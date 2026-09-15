import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'

const MODEL = process.env.MODEL ?? 'claude-sonnet-5'
const MAX_PAGES = 100 // 上下文窗口不到一百万 token 的模型上限是 100 页；稠密 PDF 更早就会填满窗口
const MAX_BYTES = 32 * 1024 * 1024 // 单次请求上限 32 MB（含 base64 膨胀前的原文件，这里只做粗检）

/** 我们只关心文本块里的页码引用，其他 citation 类型（字符位置等）忽略 */
interface CitedSegment {
  text: string
  pages: number[]
}

/** 只声明用到的 usage 字段，避免依赖 SDK 内部类型的细节 */
interface UsageView {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

interface AskResult {
  segments: CitedSegment[]
  usage: UsageView
  stopReason: string | null
}

/**
 * 唯一的网络出口：把 PDF 与问题发给 Claude，返回带页码的文本段与 usage。
 * MOCK=1 时返回一份结构完整的假结果——业务逻辑（拼页码、判 stop_reason、对比 usage）在离线时也要真的跑。
 */
async function askAboutPdf(pdfBase64: string, title: string, question: string): Promise<AskResult> {
  if (process.env.MOCK === '1') {
    const first = mockState.calls === 0
    mockState.calls += 1
    return {
      segments: [
        { text: '这份报告指出 POST /todos 接口完全没有请求体校验。', pages: [1] },
        {
          text: 'title 可为空、dueAt 接受任意字符串、客户端还能覆盖 id 与 done，三处问题都能从公网触达。',
          pages: [2],
        },
        {
          text: '修复方案是引入 zod 或 pydantic schema，非法请求返回 400 并附结构化的 issues。',
          pages: [3],
        },
        { text: '测试计划包含四个用例，并要求在每个 PR 的 CI 里运行。', pages: [4] },
        {
          text: '（离线模拟：去掉 MOCK=1 并在 .env 配置 ANTHROPIC_API_KEY 就能读你自己的 PDF。）',
          pages: [],
        },
      ],
      // 第一次调用模拟「写缓存」，之后模拟「读缓存」——和真实 API 的形态一致
      usage: first
        ? { input: 42, output: 180, cacheWrite: 5300, cacheRead: 0 }
        : { input: 38, output: 175, cacheWrite: 0, cacheRead: 5300 },
      stopReason: 'end_turn',
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('缺少 ANTHROPIC_API_KEY（或用 MOCK=1 离线运行）')
  const client = new Anthropic({ apiKey })

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: [
          {
            // 材料在前：文档块放在问题之前，模型先读材料再看问题
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
            title,
            citations: { enabled: true },
            // 缓存到这里为止：文档不变、问题在后面变。同一 PDF 连续提问时第二次起只付零头
            cache_control: { type: 'ephemeral' },
          },
          { type: 'text', text: question },
        ],
      },
    ],
  })

  const segments: CitedSegment[] = []
  for (const block of res.content) {
    if (block.type !== 'text') continue
    const pages: number[] = []
    for (const c of block.citations ?? []) {
      // PDF 的引用位置是 page_location；start 从 1 开始，end 不包含，所以单页引用只看 start
      if (c.type === 'page_location') pages.push(c.start_page_number)
    }
    segments.push({ text: block.text, pages })
  }

  return {
    segments,
    usage: {
      input: res.usage.input_tokens,
      output: res.usage.output_tokens,
      cacheWrite: res.usage.cache_creation_input_tokens ?? 0,
      cacheRead: res.usage.cache_read_input_tokens ?? 0,
    },
    stopReason: res.stop_reason,
  }
}

const mockState = { calls: 0 }

/** 把带页码的段落拼成一段可读的摘要：句子后面跟 [p.N]，同一句多个页码合并 */
function render(segments: CitedSegment[]): string {
  return segments
    .map((s) => {
      const uniq = [...new Set(s.pages)].sort((a, b) => a - b)
      return uniq.length ? `${s.text} [${uniq.map((p) => `p.${p}`).join(', ')}]` : s.text
    })
    .join('\n')
}

function printUsage(label: string, u: UsageView): void {
  // 三者相加才是这次真正处理的输入总量；健康的「先写后读」是第一次 cacheWrite 大、第二次 cacheRead 大
  console.log(
    `[usage:${label}] uncached=${u.input} cache_write=${u.cacheWrite} cache_read=${u.cacheRead} output=${u.output}`
  )
}

/** 读文件并做两项粗检：是不是 PDF、大小是否超限。页数用一个够用的启发式估算（数 /Type /Page 出现次数） */
function loadPdf(file: string): { base64: string; title: string } {
  if (!fs.existsSync(file)) throw new Error(`找不到文件：${file}`)
  const buf = fs.readFileSync(file)
  if (!buf.subarray(0, 5).equals(Buffer.from('%PDF-')))
    throw new Error(`${file} 不是 PDF（文件头不是 %PDF-）`)
  if (buf.byteLength > MAX_BYTES) throw new Error(`${file} 超过 32 MB 的单次请求上限，请先拆分`)
  const pageCount = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
  if (pageCount > MAX_PAGES)
    throw new Error(`${file} 约有 ${pageCount} 页，超过 ${MAX_PAGES} 页上限，请按章节拆分`)
  // base64 字符串不能有换行；Buffer.toString('base64') 本来就不会插入换行
  return { base64: buf.toString('base64'), title: path.basename(file) }
}

async function main(): Promise<void> {
  const file = process.argv[2]
  if (!file) {
    console.error('用法：pnpm start <文件.pdf> [问题…]')
    process.exit(1)
  }
  const { base64, title } = loadPdf(file)
  const questions =
    process.argv.length > 3
      ? process.argv.slice(3)
      : ['用五句话总结这份文档的核心结论，每句都要有依据。', '这份文档里提到了哪些风险或问题？']

  console.log(
    `模型：${MODEL}  文档：${title}${process.env.MOCK === '1' ? '  （MOCK 离线模式）' : ''}\n`
  )

  for (const [i, q] of questions.entries()) {
    console.log(`问题 ${i + 1}：${q}`)
    const r = await askAboutPdf(base64, title, q)
    console.log(render(r.segments))
    if (r.stopReason === 'max_tokens') {
      // 被 max_tokens 截断的摘要是残缺的：明确警告，不要静默输出半截
      console.warn('⚠️  stop_reason=max_tokens：输出被截断，请调大 max_tokens 或缩小问题范围')
    }
    printUsage(`q${i + 1}`, r.usage)
    console.log()
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
