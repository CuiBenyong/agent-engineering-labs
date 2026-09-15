/**
 * 自检入口：不进 REPL，逐项验证今天该成立的十五件事，打印勾叉后按结果退出。
 *
 * 今天全部离线、全部可复现：估算与校准是算术，压缩走的是同一个离线剧本，
 * 探针判据是「事实还在不在上下文里」而不是「模型答得对不对」。
 * 唯一不可复现的是耗时，而今天一个数字都不看耗时。
 */
import fs from 'node:fs/promises'
import { stdout } from 'node:process'
import { newSession } from './commands.js'
import { runTurn } from './turn.js'
import { createProvider } from './providers/index.js'
import { SessionLog, SESSIONS_DIR } from './session/log.js'
import { seedRepo } from './seed.js'
import type { Message } from './kernel/types.js'
import type { ChatProvider, ChatRequest, StreamDelta } from './providers/types.js'
import {
  Calibrator,
  DEFAULT_COEFF,
  activeCoefficients,
  estimateMessages,
  estimateTokens,
  sampleUsage,
  useCoefficients,
} from './context/tokens.js'
import { accountLanes, RESERVE, SUMMARY_PREFIX } from './context/budget.js'
import {
  checkProbes,
  compact,
  decideCompaction,
  defaultPinned,
  dropOldest,
  groupMessages,
  planKeep,
  segmentsOf,
  type CompactOptions,
} from './context/compact.js'
import { looksStructured } from './context/summarize.js'

const out = (line: string) => stdout.write(`${line}\n`)
let passed = 0
let failed = 0

function check(ok: boolean, label: string): void {
  out(`${ok ? '✔' : '✘'} ${label}`)
  if (ok) passed += 1
  else failed += 1
}

/** 自检用的小窗口：默认的 32000 要造十万字的历史才压得动，看日志反而看不清 */
const OPTIONS: CompactOptions = {
  windowTokens: 1600,
  triggerRatio: 0.7,
  keepRecentGroups: 3,
  maxSegments: 3,
  pinned: defaultPinned,
}

const FACT = 'pnpm build:calc'

/**
 * 一段「长会话」。四组工具往返各带 1200 字符的结果，是长上下文最常见的来因。
 * 早期那条「记住：…」就是压缩之后要用探针查的事实。
 */
function longHistory(): Message[] {
  const messages: Message[] = [{ role: 'system', content: '你是 mca，一个终端里的编码助手。' }]
  messages.push({
    role: 'user',
    content: `记住：这个仓库的构建命令是 ${FACT}，测试用 node --test 跑。`,
  })
  messages.push({ role: 'assistant', content: '记下了。' })
  messages.push({ role: 'user', content: '先看看测试为什么失败。' })
  for (let i = 0; i < 4; i += 1) {
    messages.push({
      role: 'assistant',
      content: `第 ${i + 1} 次查看文件。`,
      toolCalls: [
        { id: `call_${i}`, name: 'read_file', args: JSON.stringify({ path: 'src/calc.js' }) },
      ],
    })
    messages.push({
      role: 'tool',
      toolCallId: `call_${i}`,
      name: 'read_file',
      content: `src/calc.js（第 1-40 行，共 40 行）\n${'const filler = 1\n'.repeat(70)}`,
    })
  }
  messages.push({ role: 'user', content: 'divide by zero 那个用例还是红的。' })
  messages.push({ role: 'assistant', content: '我改一下 divide。' })
  return messages
}

/** 一个故意不按格式写摘要的 provider：用来验「摘要不合格就整次放弃」 */
class SloppyProvider implements ChatProvider {
  readonly id = 'sloppy'
  readonly model = 'sloppy'
  async *stream(_req: ChatRequest): AsyncIterable<StreamDelta> {
    yield { type: 'text', text: '我们讨论了一些关于除法的问题，总体上进展顺利。' }
    yield { type: 'finish', reason: 'stop' }
  }
}

async function realTokensOf(provider: ChatProvider, text: string): Promise<number> {
  for await (const delta of provider.stream({ messages: [{ role: 'user', content: text }] })) {
    if (delta.type === 'usage') return delta.promptTokens
  }
  return 0
}

async function main(): Promise<void> {
  await fs.rm(SESSIONS_DIR, { recursive: true, force: true })
  await seedRepo()
  const provider = createProvider()

  // 1. 估算器：中英分系数，与第八天那一行报账用的是同一个函数
  useCoefficients(DEFAULT_COEFF)
  check(
    estimateTokens('中文四个字') === 5 &&
      estimateTokens('abcd') === 1 &&
      estimateTokens('中文 abcd') === 3,
    `默认系数下：五个汉字 ${estimateTokens('中文四个字')} token，四个 ASCII 字符 ${estimateTokens('abcd')} token`
  )

  // 2. 校准：拿真实用量回归两个系数，误差应当明显下降
  const calibrator = new Calibrator()
  const samples = [
    '中文中文中文中文中文中文中文中文',
    'plain ascii text for calibration only',
    '混合 mixed 内容 content 各占一半左右',
    '短 short',
    '这一条几乎全是中文只掺了一个 x',
  ]
  for (const text of samples) calibrator.add(text, await realTokensOf(provider, text))
  const fit = calibrator.fit()
  check(
    fit.samples === 5 && !fit.degenerate && fit.errorAfter < fit.errorBefore && fit.errorAfter < 5,
    `校准 5 条样本：系数 中日韩 ${fit.coeff.cjk.toFixed(2)} / 其余 ${fit.coeff.rest.toFixed(2)}，误差 ${fit.errorBefore}% → ${fit.errorAfter}%`
  )

  // 3. 样本比例太单一时必须承认解不出来，而不是硬解出一对荒唐系数
  const flatOnly = new Calibrator()
  for (const text of ['aaaa', 'bbbbbbbb', 'cccccccccccc']) {
    flatOnly.add(text, await realTokensOf(provider, text))
  }
  const flatFit = flatOnly.fit()
  check(
    flatFit.degenerate && flatFit.coeff.cjk === flatFit.coeff.rest,
    `全是纯 ASCII 的样本被判为解不开：${flatFit.note}`
  )

  // 4. 取样包装只取一轮里的第一条 usage（第二轮的输入已经不是这段文本了）
  const once = new Calibrator()
  const fake = (async function* () {
    yield { type: 'usage', promptTokens: 10, completionTokens: 1, cachedTokens: 0 } as const
    yield { type: 'usage', promptTokens: 999, completionTokens: 1, cachedTokens: 0 } as const
    yield { type: 'done', reason: 'stop' } as const
  })()
  for await (const _event of sampleUsage(once, '一二三四五六七八九十', fake)) void _event
  check(once.size === 1, '用量取样只取这一轮的第一条 usage，一轮一条样本')

  // 5. 分组：带工具调用的助手消息与它的结果是一个整体；结果缺失的那组是「未完成」
  const unfinished: Message[] = [
    { role: 'system', content: 's' },
    {
      role: 'assistant',
      content: '两个调用',
      toolCalls: [
        { id: 'a', name: 'read_file', args: '{}' },
        { id: 'b', name: 'grep', args: '{}' },
      ],
    },
    { role: 'tool', toolCallId: 'a', name: 'read_file', content: '结果 a' },
  ]
  const groups = groupMessages(unfinished)
  check(
    groups.length === 2 &&
      groups[1]?.start === 1 &&
      groups[1]?.end === 3 &&
      groups[1]?.keep === 'unfinished',
    '助手消息与它的工具结果分成一组；工具结果少于工具调用时这一组被标成未完成'
  )

  // 6. 保留清单：系统指令、钉住的待办清单、未完成的工具调用、最近三组都不可压
  const pinnedHistory = [...longHistory()]
  pinnedHistory.splice(3, 0, { role: 'user', content: '待办清单：1. 修 divide 2. 跑测试' })
  const kept = planKeep(pinnedHistory, OPTIONS)
  const keeps = kept.map((g) => g.keep)
  check(
    keeps[0] === 'system' &&
      keeps.includes('pinned') &&
      keeps.filter((k) => k === 'recent').length === 3 &&
      keeps.includes('compressible'),
    `保留清单命中四类：系统指令、钉住的清单、最近 3 组，其余 ${keeps.filter((k) => k === 'compressible').length} 组才是可压区`
  )

  // 7. 触发判定按比例，不按轮数：同样的消息条数，长的触发短的不触发
  const long = longHistory()
  const short: Message[] = long.map((m) =>
    m.role === 'tool' ? { ...m, content: 'src/calc.js（第 1-3 行）\nconst filler = 1' } : m
  )
  const dLong = decideCompaction(long, OPTIONS)
  const dShort = decideCompaction(short, OPTIONS)
  check(
    dLong.should && !dShort.should && long.length === short.length,
    `同样 ${long.length} 条消息、同样的轮数：长的 ${dLong.tokens} token 触发，短的 ${dShort.tokens} token 不触发`
  )

  // 8. 分段：切点在用户消息处
  const segments = segmentsOf(long, planKeep(long, OPTIONS), 3)
  check(
    segments.length === 2 && segments[0]?.length === 2 && segments[1]?.length === 4,
    `可压区按用户消息切成 ${segments.length} 段（${segments.map((s) => s.length).join(' + ')} 组）`
  )

  // 9. 压一次：消息数与估算都下降，摘要是结构化的
  const compacting = longHistory()
  const beforeTokens = estimateMessages(compacting)
  const result = await compact(provider, compacting, OPTIONS)
  check(
    result.compacted &&
      result.afterMessages < result.beforeMessages &&
      result.afterTokens < beforeTokens &&
      result.segments === 2 &&
      result.summaries.every((s) => looksStructured(s)),
    `压缩：${result.beforeMessages} 条 → ${result.afterMessages} 条，估算 ${result.beforeTokens} → ${result.afterTokens} token，2 段摘要都带齐四个小标题`
  )

  // 10. 压完之后结构还合法：系统指令仍在第 0 条，摘要在原位置，没有孤立的工具结果
  const orphan = compacting.some(
    (m, i) =>
      m.role === 'tool' &&
      !(compacting[i - 1]?.toolCalls?.length || compacting[i - 1]?.role === 'tool')
  )
  check(
    compacting[0]?.role === 'system' &&
      String(compacting[1]?.content ?? '').startsWith(SUMMARY_PREFIX) &&
      !orphan,
    '压完的消息数组仍然合法：系统指令在最前、摘要接在它后面、没有对不上调用的工具结果'
  )

  // 11. 探针：早期那条事实压完还在
  const probes = checkProbes(compacting, [
    { question: '这个仓库的构建命令是什么？', expect: FACT },
    { question: '失败的那个用例是哪一个？', expect: 'divide by zero' },
  ])
  check(
    probes.every((p) => p.found),
    `两条探针在压缩后的上下文里都还找得到：${probes.map((p) => p.expect).join('、')}`
  )

  // 12. 反面对照：只留最近几组的截断式压缩，省下的差不多，但那条事实没了
  const truncated = dropOldest(longHistory(), OPTIONS)
  const lost = checkProbes(truncated, [{ question: '构建命令？', expect: FACT }])
  check(
    lost[0]?.found === false && estimateMessages(truncated) < beforeTokens,
    `换成「只留最近三组」的截断式：估算降到 ${estimateMessages(truncated)} token，但「${FACT}」这条事实丢了`
  )

  // 13. 摘要不按格式写就整次放弃，上下文一个字都不动
  const guarded = longHistory()
  const snapshot = JSON.stringify(guarded)
  const sloppy = await compact(new SloppyProvider(), guarded, OPTIONS)
  check(
    !sloppy.compacted && JSON.stringify(guarded) === snapshot,
    `摘要没按四个小标题写时整次放弃：${sloppy.reason}`
  )

  // 14. 总预算按路记账，空的那两路也在表里（第九天与第十一天接进来就自动有数）
  const lanes = accountLanes(compacting, 1600)
  const laneOf = (name: string) => lanes.rows.find((row) => row.lane === name)
  check(
    laneOf('system')?.tokens !== undefined &&
      laneOf('summary')?.messages === 2 &&
      laneOf('instructions')?.messages === 0 &&
      laneOf('memory')?.messages === 0 &&
      Math.abs(Object.values(RESERVE).reduce((a, b) => a + b, 0) - 1) < 1e-9,
    `预算分七路：摘要 ${laneOf('summary')?.tokens} token、对话 ${laneOf('history')?.tokens} token、工具结果 ${laneOf('tools')?.tokens} token；指令文件与记忆两路本实验为空但额度已留出`
  )

  // 15. 真实流水线：长会话进来先压再答，一轮里两件事都发生
  const session = newSession(() => {}, await SessionLog.create())
  session.messages.splice(0, session.messages.length, ...longHistory())
  const lines: string[] = []
  const outcome = await runTurn({
    session,
    provider,
    line: '解释一下 @src/calc.js 里的 divide 哪里有问题',
    write: () => {},
    out: (line) => lines.push(line),
    compaction: OPTIONS,
    tty: false,
  })
  check(
    outcome.compaction?.compacted === true &&
      lines.some((line) => line.startsWith('触发压缩：')) &&
      outcome.summary.tools.length === 0 &&
      outcome.summary.text.includes('Infinity'),
    `一轮流水线：先触发压缩（${outcome.compaction?.beforeMessages} → ${outcome.compaction?.afterMessages} 条），再零次工具调用答完这一句`
  )

  out(`${passed}/${passed + failed} 通过`)
  out(
    `（估算一直用默认系数 中日韩 ${activeCoefficients().cjk.toFixed(2)} / 其余 ${activeCoefficients().rest.toFixed(2)}：` +
      '第 2 项算出的系数**故意没有应用到全局**，否则后面各项的 token 数就不可复现了。' +
      'REPL 里攒够三条真实用量样本会自动应用，见 /tokens。' +
      '另外离线下的「真实用量」来自剧本，接真网关时同一段代码会回归出另一对系数）'
  )
  if (failed > 0) process.exitCode = 1
}

await main()
