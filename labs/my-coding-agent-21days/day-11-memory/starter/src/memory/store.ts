/**
 * 记忆的存储层：一条记忆一个文件，带元信息。本天新增。
 *
 * 为什么是「一条一个文件」而不是一个大文件——五条理由，前四条都是工程上的：
 *
 *   1. **元信息挂得住。** 一条记忆要记住「什么时候写的、谁写的、跟哪些词与哪些路径有关、
 *      靠什么核对它还成不成立」。一个大文件只能给整份文件一个时间戳，
 *      于是三个月前那句话和昨天那句话在检索时一样新。
 *   2. **检索的单位天然就是文件。** 命中原因能指到一个文件名，用户能直接打开、直接删。
 *      大文件要先切分，而切分的规则就是下一个 bug 的来源。
 *   3. **并发写不打架。** 两个 mca 进程同时干活，各写各的新文件；追加同一个大文件会交错，
 *      而交错出来的那一行是永久损坏的。
 *   4. **删一条就是删一个文件。** 改大文件是一次全量重写，写坏了整份记忆一起没。
 *   5. 代价也说清楚：**几百条之后目录会变大**，所以今天必须同时做 `/forget` 与过期核对。
 *      上万条要上索引，那超出本课范围。
 *
 * 文件格式是「几行元信息 + 一个空行 + 正文」，故意不引 YAML 库：字段只有六个，
 * 而手写解析器的全部代码在 parseMemory 里，不到三十行。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { redact, type RedactVerdict } from './redact.js'

/** 记忆目录。和会话日志、快照一样住在 work/ 下——它是这台机器上学到的经验，不进 git */
export const MEMORY_DIR = path.resolve(process.cwd(), 'work/memory')

/**
 * 两条写入路径的来源标记。**这个字段是今天最便宜也最值钱的一个。**
 *
 * command  用户用 /remember 显式写下的
 * model    模型自己调 remember 工具沉淀下来的
 *
 * 为什么必须分开：出问题的时候你要能回答「这条错的事实是谁写进来的」。
 * 而且检索排序里显式那一路要压过自动那一路——见 retrieve.ts。
 */
export type MemorySource = 'command' | 'model'

export const SOURCE_LABEL: Record<MemorySource, string> = {
  command: '用户写下',
  model: '模型沉淀',
}

/**
 * 锚点：一条记忆「还成不成立」的可核对依据。
 *
 * 它是今天最后一节的全部机制：一条记忆说「测试要用 node --test」，
 * 那它就该能指出「你去看 package.json，里面写着 node --test」。
 * 锚点失效（文件没了、那段字不在了）说明世界变了，这条记忆要重新核对。
 *
 * 没有锚点的记忆是允许的（有些事实没法锚在文件上，比如「用户偏好中文回复」），
 * 那种只能靠年龄提醒。
 */
export interface MemoryAnchor {
  /** 相对沙盒仓库的路径 */
  path: string
  /** 这个文件里应该还能找到的一段字 */
  contains: string
}

export interface Memory {
  id: string
  text: string
  source: MemorySource
  /** 写下时间，ISO 字符串。**含时间所以不可复现，正文里不要贴具体值** */
  at: string
  /** 检索用的关键词，写入时给，缺省从正文里抽 */
  keys: string[]
  /** 与哪些路径有关，检索时按当前话题里的路径匹配 */
  paths: string[]
  anchor?: MemoryAnchor
}

export interface WriteInput {
  text: string
  source: MemorySource
  keys?: string[]
  paths?: string[]
  anchor?: MemoryAnchor
}

export type WriteOutcome =
  { ok: true; memory: Memory; duplicateOf?: string } | { ok: false; verdict: RedactVerdict }

/** 上限：一条记忆的正文。超了不是截断而是拒绝——一条要翻页的「事实」不是事实，是文档 */
export const MEMORY_TEXT_LIMIT = 400

/**
 * 写一条记忆。**两条写入路径都走这一个函数。**
 *
 * 拦截放在这一层而不是两个入口各写一遍，理由和第十天「校验放数据模型不放工具」一样：
 * 不变量属于数据。少写一处，那一处就是漏洞——而这里漏掉的是密钥。
 */
export async function write(input: WriteInput): Promise<WriteOutcome> {
  const text = input.text.trim().replace(/\s+/g, ' ')
  const verdict = await redact(text, { source: input.source })
  if (!verdict.allowed) return { ok: false, verdict }

  const existing = await load()
  // TODO(1)：同一条事实写两遍不该变成两个文件。
  //
  // 两条写入路径都汇到这里，所以去重也只该写在这一层。判据用 normalizeText
  // 归一化之后完全相同即可——更聪明的去重（语义相近）要嵌入模型，那不是本课的东西，
  // 而且它会误杀。命中已有的那条时返回 { ok: true, memory: 已有那条, duplicateOf: 它的 id }，
  // 不要新写文件。
  //
  // 顺手想清楚为什么拦截（redact）也必须在这一层、而不是在 /remember 与 remember 工具里
  // 各写一遍：少写一处，那一处就是漏洞——而这里漏掉的是密钥。

  const memory: Memory = {
    id: nextId(existing),
    text,
    source: input.source,
    at: new Date().toISOString(),
    keys: dedupe(input.keys?.length ? input.keys : keywordsOf(text)),
    paths: dedupe(input.paths ?? []),
    ...(input.anchor ? { anchor: input.anchor } : {}),
  }
  await fs.mkdir(MEMORY_DIR, { recursive: true })
  await fs.writeFile(path.join(MEMORY_DIR, `${memory.id}.md`), serialize(memory), 'utf8')
  return { ok: true, memory }
}

/** 读出全部记忆，最新的在前。读不懂的文件跳过并不报错——一条坏文件不该让整个功能瘫掉 */
export async function load(): Promise<Memory[]> {
  const names = await fs.readdir(MEMORY_DIR).catch(() => [] as string[])
  const memories: Memory[] = []
  for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
    const raw = await fs.readFile(path.join(MEMORY_DIR, name), 'utf8').catch(() => null)
    if (raw === null) continue
    const parsed = parseMemory(name.replace(/\.md$/, ''), raw)
    if (parsed) memories.push(parsed)
  }
  return memories.sort((a, b) => b.at.localeCompare(a.at))
}

/** 删一条。返回它是否真的存在——「删了个不存在的」要说出来，不要静默成功 */
export async function forget(id: string): Promise<boolean> {
  const file = path.join(MEMORY_DIR, `${id}.md`)
  const gone = await fs
    .rm(file)
    .then(() => true)
    .catch(() => false)
  return gone
}

export function serialize(memory: Memory): string {
  const lines = [
    `id: ${memory.id}`,
    `source: ${memory.source}`,
    `at: ${memory.at}`,
    `keys: ${memory.keys.join(', ')}`,
    `paths: ${memory.paths.join(', ')}`,
  ]
  if (memory.anchor) {
    lines.push(`anchor-path: ${memory.anchor.path}`, `anchor-contains: ${memory.anchor.contains}`)
  }
  return `${lines.join('\n')}\n\n${memory.text}\n`
}

/**
 * 手写解析。格式是「元信息行 + 空行 + 正文」，所以第一个空行就是分界。
 *
 * 一条口径：**解析不出来就返回 null，不抛异常也不「尽量修补」。**
 * 修补出来的记忆是一条你不知道内容的事实，它会被注入进上下文——
 * 比丢掉它糟得多。这和第七天「日志坏行停在坏行之前」是同一条纪律。
 */
export function parseMemory(id: string, raw: string): Memory | null {
  const split = raw.indexOf('\n\n')
  if (split === -1) return null
  const head = raw.slice(0, split).split('\n')
  const text = raw.slice(split + 2).trim()
  if (!text) return null

  const fields = new Map<string, string>()
  for (const line of head) {
    const colon = line.indexOf(':')
    if (colon === -1) return null
    fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }

  const source = fields.get('source')
  if (source !== 'command' && source !== 'model') return null
  const at = fields.get('at')
  if (!at || Number.isNaN(Date.parse(at))) return null

  const anchorPath = fields.get('anchor-path')
  const anchorContains = fields.get('anchor-contains')
  return {
    id: fields.get('id') || id,
    text,
    source,
    at,
    keys: splitList(fields.get('keys')),
    paths: splitList(fields.get('paths')),
    ...(anchorPath && anchorContains
      ? { anchor: { path: anchorPath, contains: anchorContains } }
      : {}),
  }
}

/**
 * id 用递增序号而不是时间戳，是为了让 `/forget m3` 这种命令打得出来。
 * 时间已经在 at 字段里了，id 只要唯一且好念。
 */
function nextId(existing: Memory[]): string {
  let max = 0
  for (const memory of existing) {
    const n = Number(/^m(\d+)$/.exec(memory.id)?.[1] ?? 0)
    if (n > max) max = n
  }
  return `m${max + 1}`
}

/**
 * 从正文里抽关键词的兜底实现。两种字符分开处理：
 *
 *   英数词  按分隔符切，长度 3 起（`node`、`--test` 里的 `test`、`package.json`）
 *   中文    切成**相邻两字的组合**，而不是整段留着
 *
 * 第二条值得说明。把「测试要用内置的测试运行器」整段当一个关键词，
 * 用户下次问「怎么跑测试」就一个字都对不上——而中文没有空格，
 * 想切出「测试」这个词就得有分词表。两字组合是不用分词表的最省做法：
 * 它一定会切出「测试」，代价只是也切出「试要」这种废词，而废词只会让匹配多一点点噪音。
 *
 * 它当然不如让模型自己给关键词准（`remember` 工具就是让它给的），但显式命令那一路
 * 用户只给一句话，总得有个兜底。**兜底的标准是宁可多给几个**：
 * 关键词多了只是多命中一点，少了这条记忆就再也找不回来。
 */
export function keywordsOf(text: string): string[] {
  const words = (text.toLowerCase().match(/[a-z0-9_.\-]{3,}/g) ?? []).filter(
    (word) => !STOP_WORDS.has(word)
  )
  const grams: string[] = []
  for (const run of text.match(/[一-鿿]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const gram = run.slice(i, i + 2)
      // 含虚词的组合直接丢掉。这一行把「库的」「只能」「那条」这种噪音挡在外面，
      // 而它挡不住的（「仓库」「测试」「脚本」）恰好就是想要的那些
      if (STOP_WORDS.has(gram)) continue
      if ([...gram].some((ch) => FUNCTION_CHARS.has(ch))) continue
      grams.push(gram)
    }
  }
  return dedupe([...words, ...grams]).slice(0, 16)
}

/** 虚词表：这些字自己不承载话题，出现在两字组合里就说明那个组合是切歪的 */
const FUNCTION_CHARS = new Set(
  '一的了是在和与给用把被这那个其之为对从就都也很还只能要会有没不而且如则以及等我你他它们条些着过再又更最'
)

const STOP_WORDS = new Set(
  'the and for that this with 这个 那个 一个 因为 所以 不要 可以'.split(' ')
)

function splitList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))]
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[\s，。,.；;！!]/g, '')
}
