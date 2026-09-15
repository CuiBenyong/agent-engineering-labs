import 'dotenv/config'
import { assemble, countTokens } from './assemble'
import { buildIndex, search } from './bm25'
import { loadChunks } from './corpus'
import { buildServer, buildStore, PORT, type AskResult, type Store } from './server'

/**
 * D6 实验（solution）：带引用校验、拒答策略与流式输出的问答接口。
 *
 *   MOCK=1 pnpm start            起服务 → 跑自测 → 逐项打印 ✅/❌ → 退出
 *   MOCK=1 SERVE=1 pnpm start    常驻，供你自己 curl
 *
 * 自测走的是真实 HTTP，SSE 也是真的解析，只有模型调用是离线模板。
 */

interface Check {
  name: string
  ok: boolean
  detail: string
}

const checks: Check[] = []
function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}\n   ${detail.split('\n').join('\n   ')}`)
}

const base = `http://127.0.0.1:${PORT}`

async function post(path: string, body: unknown): Promise<AskResult> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()) as AskResult
}

interface SseEvent {
  event: string
  data: Record<string, unknown>
}

async function stream(body: unknown): Promise<SseEvent[]> {
  const res = await fetch(`${base}/ask/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return text
    .split('\n\n')
    .filter((raw) => raw.startsWith('event: '))
    .map((raw) => {
      const [head, ...rest] = raw.split('\n')
      return {
        event: head.slice('event: '.length),
        data: JSON.parse(rest.join('\n').slice('data: '.length)) as Record<string, unknown>,
      }
    })
}

/** 组装这一步不经过网络，直接调函数看得更清楚 */
function checkAssembly(store: Store): void {
  const question = '删掉的文件在回收站里能保留多久？'
  const scored = search(store.index, question, 8).map((hit) => ({
    chunk: store.byId.get(hit.docId)!,
    score: hit.score,
  }))
  const result = assemble(scored, { budget: 1200, maxBlocks: 5 })
  const ids = result.blocks.map((b) => b.chunk.chunkId)
  const unique = new Set(ids).size === ids.length
  const withinBudget = result.usedTokens <= 1200
  const top = [...scored].sort((a, b) => b.score - a.score)[0]
  const second = [...scored].sort((a, b) => b.score - a.score)[1]
  const headTail =
    result.blocks[0]?.chunk.chunkId === top.chunk.chunkId &&
    result.blocks[result.blocks.length - 1]?.chunk.chunkId === second.chunk.chunkId

  record(
    '组装：去重、控预算、最高分放两端',
    unique && withinBudget && headTail && result.blocks.length <= 5,
    [
      `块编号顺序：${result.blocks.map((b) => `[${b.n}]${b.chunk.chunkId}(${b.score})`).join(' ')}`,
      `材料 ${result.usedTokens} token（预算 1200），去重丢弃 ${result.deduped.length} 块，超预算丢弃 ${result.overBudget.length} 块`,
      `第 1 名 ${top.chunk.chunkId} 应在开头、第 2 名 ${second.chunk.chunkId} 应在结尾：${headTail ? '是' : '否'}`,
    ].join('\n')
  )
}

async function checkCompression(): Promise<void> {
  const r = await post('/ask', { question: '开放 API 的默认限流是多少？超了会返回什么状态码？' })
  record(
    '上下文压缩：无关句子被删掉',
    r.stats.contextTokens < r.stats.rawTokens,
    `压缩前 ${r.stats.rawTokens} token → 压缩后 ${r.stats.contextTokens} token，省了 ${(((r.stats.rawTokens - r.stats.contextTokens) / r.stats.rawTokens) * 100).toFixed(1)}%`
  )
}

async function checkFabricated(): Promise<void> {
  const r = await post('/ask', {
    question: '开放 API 的默认限流是多少？超了会返回什么状态码？',
    fabricate: true,
  })
  const issues = r.stats.rejected.flatMap((x) => x.issues)
  // 两种编造要分别抓住：编号不存在（好抓），以及编号是真的但内容对不上（只有算重合度才发现）
  const caught =
    issues.some((i) => i.includes('不存在的块编号')) && issues.some((i) => i.includes('实质重合度'))
  const maxN = Math.max(...r.blocks.map((b) => b.n))
  const clean = r.claims.every((c) => c.citations.every((n) => n >= 1 && n <= maxN))
  record(
    '引用校验：编造的出处被拦下并打回重生成',
    caught && clean && r.status === 'answered',
    [
      `第 1 版被拒：${r.stats.rejected[0]?.issues.join('；') ?? '（没有被拒，说明校验没生效）'}`,
      `共生成 ${r.stats.attempts} 版，最终 ${r.status}，返回的引用编号 ${JSON.stringify(r.claims.map((c) => c.citations))} 全部在 1..${maxN} 内：${clean ? '是' : '否'}`,
    ].join('\n')
  )
}

async function checkRefusal(
  name: string,
  question: string,
  kind: string,
  extra?: (r: AskResult) => string
): Promise<void> {
  const r = await post('/ask', { question })
  record(
    name,
    r.status === 'refused' && r.refusal?.kind === kind,
    [
      `问题：${question}`,
      `判定：${r.refusal?.kind ?? r.status}（期望 ${kind}）`,
      `话术：${r.answer.split('\n').join(' / ')}`,
      extra?.(r) ?? '',
    ]
      .filter(Boolean)
      .join('\n')
  )
}

async function checkStreaming(): Promise<void> {
  const events = await stream({
    question: '开放 API 的默认限流是多少？超了会返回什么状态码？',
    fabricate: true,
  })
  const sentences = events.filter((e) => e.event === 'sentence')
  const dropped = events.filter((e) => e.event === 'dropped')
  const everySentenceCited = sentences.every(
    (e) => Array.isArray(e.data.citations) && (e.data.citations as unknown[]).length > 0
  )
  const maxN = Math.max(
    ...((events.find((e) => e.event === 'meta')?.data.blocks as { n: number }[]) ?? []).map(
      (b) => b.n
    )
  )
  const noBadNumber = sentences.every((e) =>
    (e.data.citations as { n: number }[]).every((c) => c.n >= 1 && c.n <= maxN)
  )
  record(
    '流式：逐句校验后才发出，编造的那两句被丢弃',
    sentences.length > 0 && dropped.length === 2 && everySentenceCited && noBadNumber,
    [
      `事件序列：${events.map((e) => e.event).join(' → ')}`,
      `发出 ${sentences.length} 句，丢弃 ${dropped.length} 句；每一句都带已核实的引用：${everySentenceCited ? '是' : '否'}`,
      dropped[0] ? `被丢弃的是：${String(dropped[0].data.text)}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  )
}

async function checkLookup(): Promise<void> {
  const res = await fetch(`${base}/chunk/doc-006/c01`)
  const chunk = (await res.json()) as { chunkId?: string; text?: string }
  record(
    '回查原文：引用编号能落回一段可核对的文字',
    res.status === 200 && typeof chunk.text === 'string' && chunk.text.length > 0,
    `GET /chunk/doc-006/c01 → ${res.status}，${chunk.chunkId ?? '?'} 的正文 ${chunk.text?.length ?? 0} 字`
  )
}

async function main(): Promise<void> {
  const store = buildStore()
  const app = buildServer(store)
  await app.listen({ port: PORT, host: '127.0.0.1' })

  if (process.env.SERVE === '1') {
    const chunks = loadChunks()
    console.log(
      `服务已启动：${base}（${chunks.length} 个块，共 ${countTokens(chunks.map((c) => c.text).join('')).toLocaleString()} token）`
    )
    console.log(
      `试试：curl -s ${base}/ask -H 'content-type: application/json' -d '{"question":"回收站保留多久"}'`
    )
    return
  }

  console.log(`自测开始（MOCK=${process.env.MOCK ?? '0'}，端口 ${PORT}）\n`)
  checkAssembly(store)
  await checkCompression()
  await checkFabricated()
  await checkRefusal('拒答线一：检索分数太低', '公司每年团建预算是多少？', 'low_score')
  await checkRefusal(
    '拒答线二：材料互相冲突',
    '单个文件最大能上传多大？',
    'conflict',
    (r) => `证据：${JSON.stringify(r.refusal?.conflict)}`
  )
  await checkRefusal(
    '第三种：问题超出材料覆盖范围',
    '云梯科技给员工报销手机话费吗？',
    'unsupported'
  )
  await checkStreaming()
  await checkLookup()

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
