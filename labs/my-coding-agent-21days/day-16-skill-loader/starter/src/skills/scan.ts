/**
 * 扫描技能目录、解析元信息、校验必需字段。本天新增。
 *
 * 这一层只回答一个问题：**这台机器上有哪些技能，它们各自号称能干什么。**
 * 注意「号称」两个字——扫描阶段读到的只有 name 与 description，
 * 正文一个字都不往上下文里放。正文什么时候读、读哪几份，是 inject.ts 的事。
 *
 * 一条容易被误解的地方先说清楚：**扫描时其实把整份 SKILL.md 都从磁盘读出来了**，
 * 因为要拿到 frontmatter 就得读文件头，而按行读和整份读在这个体量上没有差别。
 * **渐进披露省的是上下文，不是磁盘 IO。** 读一份文件是微秒级的本地操作，
 * 而把同样这段文字塞进每一次请求，要按 token 一次次付钱、还要占掉窗口。
 * 把这两件事分清楚，才不会写出「为了省 token 去做懒加载文件句柄」这种没意义的优化。
 *
 * 校验的口径是**跳过并说清原因**，不是抛异常：一个技能包写坏了，
 * 最坏的后果应该是少一个技能，不是 mca 起不来。这和第十五天对掉线 server 的处理是同一条。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FrontmatterError, parseFrontmatter, type FieldValue } from './frontmatter.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/** 技能包的根目录：跟 src/ 平级的 skills/。配置文件的分层是 D21 的题目 */
export const SKILLS_DIR = path.resolve(here, '../../skills')

/** description 的长度上限。它是阶段一唯一常驻上下文的东西，所以必须有预算 */
export const MAX_DESCRIPTION_CHARS = 400

export interface Attachment {
  /** 从沙盒仓库出发能直接跑的相对路径 */
  runPath: string
  /** 脚本首行注释里的那句说明 */
  note: string
}

export interface SkillMeta {
  /** 目录名，也是技能的唯一 id */
  id: string
  dir: string
  name: string
  description: string
  /** 本实现的扩展字段：同一个 domain 下的技能互斥，见 inject.ts */
  domain: string
  priority: number
  triggers: string[]
  paths: string[]
  /** 全文有多少字符。扫描时就知道，但**没有**放进上下文 */
  bodyChars: number
  attachments: Attachment[]
}

export interface ScanResult {
  skills: SkillMeta[]
  /** 每条都是一句人话：哪个目录、缺什么、怎么改 */
  problems: string[]
}

export async function scanSkills(root: string = SKILLS_DIR): Promise<ScanResult> {
  const skills: SkillMeta[] = []
  const problems: string[] = []

  let dirs: string[]
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    // 没有 skills 目录不是错误，是「这台机器上一个技能都没装」
    return { skills, problems }
  }

  for (const id of dirs) {
    const dir = path.join(root, id)
    try {
      skills.push(await readSkill(id, dir))
    } catch (error) {
      const reason = error instanceof FrontmatterError ? error.message : String(error)
      problems.push(`skills/${id}：${reason}`)
    }
  }
  return { skills, problems }
}

async function readSkill(id: string, dir: string): Promise<SkillMeta> {
  const file = path.join(dir, 'SKILL.md')
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    throw new FrontmatterError('目录里没有 SKILL.md')
  }

  const { fields, body } = parseFrontmatter(text)
  const name = str(fields.name)
  const description = str(fields.description)
  // TODO(2)：现在缺字段也照样装上，于是 skills/broken-no-description 会被当成
  // 一个「description 是空字符串」的正常技能——它永远不会被触发，而没有任何人被告知。
  // 补上四条校验，每条 throw 一个 FrontmatterError，消息写成人话
  // （哪个字段、为什么要它、怎么改）：
  //   1) name 必填
  //   2) description 必填（它是阶段一唯一常驻上下文的东西）
  //   3) name 必须等于目录名 id
  //   4) description 不能超过 MAX_DESCRIPTION_CHARS
  // throw 出去的异常由 scanSkills 逐个接住记进 problems，
  // **一个技能包写坏了不该让 mca 起不来。**

  return {
    id,
    dir,
    name,
    description,
    domain: str(fields.domain) || id,
    priority: typeof fields.priority === 'number' ? fields.priority : 0,
    triggers: list(fields.triggers),
    paths: list(fields.paths),
    bodyChars: body.length,
    attachments: await readAttachments(dir),
  }
}

/**
 * 阶段三的清单：同级 scripts/ 下的每个脚本一行。
 *
 * **只读首行注释，不读脚本正文。** 这不是省事，这就是阶段三的定义——
 * 脚本是拿来跑的，不是拿来读给模型听的。一个三百行的脚本塞进上下文，
 * 模型多半还会「读懂之后自己照着写一遍」，那比直接跑它糟得多。
 */
async function readAttachments(dir: string): Promise<Attachment[]> {
  const scriptsDir = path.join(dir, 'scripts')
  let files: string[]
  try {
    files = (await fs.readdir(scriptsDir)).filter((f) => f.endsWith('.mjs')).sort()
  } catch {
    return []
  }
  const attachments: Attachment[] = []
  for (const file of files) {
    const head = await firstLine(path.join(scriptsDir, file))
    attachments.push({
      // 沙盒仓库在 work/repo 下，从那里回到 lab 根正好是 ../..，
      // 所以这条路径从 lab 根算起（含 skills/ 这一层），模型拿到就能直接跑
      runPath: `../../${path.relative(path.dirname(SKILLS_DIR), path.join(scriptsDir, file))}`,
      note: head,
    })
  }
  return attachments
}

async function firstLine(file: string): Promise<string> {
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(512)
    const { bytesRead } = await handle.read(buffer, 0, 512, 0)
    const line = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? ''
    return line.replace(/^\/\/\s*/, '').trim() || '（脚本首行没有写说明注释）'
  } finally {
    await handle.close()
  }
}

/** 阶段二才会用到：按需把某个技能的全文读出来 */
export async function readSkillBody(skill: SkillMeta): Promise<string> {
  const text = await fs.readFile(path.join(skill.dir, 'SKILL.md'), 'utf8')
  return parseFrontmatter(text).body
}

function str(value: FieldValue | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function list(value: FieldValue | undefined): string[] {
  if (Array.isArray(value)) return value.map((v) => v.trim()).filter((v) => v !== '')
  if (typeof value === 'string' && value.trim() !== '') return [value.trim()]
  return []
}

/** 会话上挂着的技能状态：装上的、没装上的、被用户点名的 */
export interface SkillState {
  skills: SkillMeta[]
  problems: string[]
  /** 用 /skill 点名的技能 id，用完一轮就清空 */
  pinned: string[]
}

export function emptySkillState(): SkillState {
  return { skills: [], problems: [], pinned: [] }
}
