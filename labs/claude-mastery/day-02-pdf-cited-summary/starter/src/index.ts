import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'

const MODEL = process.env.MODEL ?? 'claude-sonnet-5'
const MAX_PAGES = 100 // 上下文窗口不到一百万 token 的模型上限是 100 页
const MAX_BYTES = 32 * 1024 * 1024 // 单次请求上限 32 MB

interface CitedSegment {
  text: string
  pages: number[]
}

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
 * 唯一的网络出口。MOCK 分支已经写好，你要补的是真实请求的三个练习点。
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
      usage: first
        ? { input: 42, output: 180, cacheWrite: 5300, cacheRead: 0 }
        : { input: 38, output: 175, cacheWrite: 0, cacheRead: 5300 },
      stopReason: 'end_turn',
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('缺少 ANTHROPIC_API_KEY（或用 MOCK=1 离线运行）')
  const client = new Anthropic({ apiKey })

  // 练习 1：用 client.messages.create 发请求。content 是一个数组：
  //   先放一个 type: 'document' 的块（source 是 base64 + application/pdf，带 title，citations: { enabled: true }），
  //   再放一个 type: 'text' 的块装问题。材料在前、指令在后。
  // 练习 3：给 document 块加 cache_control: { type: 'ephemeral' }，让同一 PDF 的第二个问题命中缓存。
  //   提示：断点要打在「不变」的东西上——文档不变、问题会变。
  void client
  void pdfBase64
  void title
  void question

  // 练习 2：遍历 res.content 里 type === 'text' 的块，把 block.citations 里 type === 'page_location' 的
  //   start_page_number 收进 pages（end_page_number 不包含，单页引用只看 start）。
  //   同时把 res.usage 的四个字段与 res.stop_reason 填进返回值。
  // 现在返回一个明显「还没做完」的占位结果，让你一眼看出练习没完成：
  return {
    segments: [{ text: '（练习未完成：askAboutPdf 还没有真正调用 API）', pages: [] }],
    usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    stopReason: null,
  }
}

const mockState = { calls: 0 }

function render(segments: CitedSegment[]): string {
  return segments
    .map((s) => {
      const uniq = [...new Set(s.pages)].sort((a, b) => a - b)
      return uniq.length ? `${s.text} [${uniq.map((p) => `p.${p}`).join(', ')}]` : s.text
    })
    .join('\n')
}

function printUsage(label: string, u: UsageView): void {
  console.log(
    `[usage:${label}] uncached=${u.input} cache_write=${u.cacheWrite} cache_read=${u.cacheRead} output=${u.output}`
  )
}

function loadPdf(file: string): { base64: string; title: string } {
  if (!fs.existsSync(file)) throw new Error(`找不到文件：${file}`)
  const buf = fs.readFileSync(file)
  if (!buf.subarray(0, 5).equals(Buffer.from('%PDF-')))
    throw new Error(`${file} 不是 PDF（文件头不是 %PDF-）`)
  if (buf.byteLength > MAX_BYTES) throw new Error(`${file} 超过 32 MB 的单次请求上限，请先拆分`)
  const pageCount = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
  if (pageCount > MAX_PAGES)
    throw new Error(`${file} 约有 ${pageCount} 页，超过 ${MAX_PAGES} 页上限，请按章节拆分`)
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
