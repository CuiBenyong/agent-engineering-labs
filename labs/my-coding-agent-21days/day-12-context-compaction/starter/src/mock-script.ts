/**
 * 今天的离线剧本。每天按当天要展示的现象重写，所以它不冻结。
 *
 * D12 多了一个场景：**写摘要**。它是今天唯一需要模型「动脑子」的一步。
 *
 * 这一段值得说清楚，因为它决定了离线现象的可信度：摘要请求把整段要压缩的对话
 * 作为最后一条用户消息发出去，而离线引擎选场景时拿到的正是那条消息的正文——
 * 所以**剧本能真的读到那段对话**，摘要是从转录里抽出来的，不是写死的一段话。
 * 改掉早期那条事实，摘要跟着变；把事实删掉，摘要里就没有它。
 * 这正是「改一个输入，输出必须跟着变」这条判据要的东西。
 *
 * 当然，抽取是按规则做的（找「记住：」、找工具名、找路径），不是理解。
 * 真实模型做的是同一件事的智能版本，格式约束一模一样（见 context/summarize.ts）。
 *
 * D8 的三段剧本（贴了资料就直接答、先查明失败用例、再动手修）原样留着。
 */
import type { MockScene, MockStep } from './providers/mock.js'
import { SUMMARY_HEADINGS, TRANSCRIPT_PREFIX } from './context/summarize.js'

const OLD_DIVIDE = `export function divide(a, b) {
  return a / b
}`

const NEW_DIVIDE = `export function divide(a, b) {
  if (b === 0) throw new Error('divide by zero')
  return a / b
}`

/** 主场景：材料已经注入，一次工具调用都不需要 */
const EXPLAIN: MockScene = {
  name: 'explain',
  steps: [
    {
      text:
        '你贴进来的 src/calc.js 里，divide 直接返回 a 除以 b：b 为 0 时会得到 Infinity 而不是抛错。' +
        '测试里那个 divide by zero 用例就是因为这个失败的。我不用再读一遍文件了。',
    },
  ],
}

const FIND_FAILING: MockScene = {
  name: 'find-failing',
  steps: [
    {
      text: '我先跑一遍测试。',
      toolCalls: [{ id: 'call_test_1', name: 'run_command', args: { command: 'node --test' } }],
    },
    {
      text: '失败的是 divide by zero 那个用例：divide 在除数为 0 时应该抛错，现在返回 Infinity。',
    },
  ],
}

const FIX_IT: MockScene = {
  name: 'fix-it',
  steps: [
    {
      text: '按上一轮查到的，给 divide 加上除零保护。',
      toolCalls: [
        {
          id: 'call_edit_src',
          name: 'edit_file',
          args: { path: 'src/calc.js', old_string: OLD_DIVIDE, new_string: NEW_DIVIDE },
        },
      ],
    },
    {
      text: '再跑一次确认。',
      toolCalls: [{ id: 'call_test_2', name: 'run_command', args: { command: 'node --test' } }],
    },
    { text: '四个用例全绿，divide by zero 那个用例修好了。' },
  ],
}

/**
 * 从转录里抽出四节内容。
 *
 * 抽取规则刻意保守：**只抄原文里已经出现过的东西**，一个字都不推断。
 * 这也是给真实模型的那份提示词里写的同一条要求——摘要一旦开始推测，
 * 后面的对话就会建立在一句没人说过的话上。
 */
function summarizeTranscript(transcript: string): string {
  const facts: string[] = []
  const changes: string[] = []
  const pending: string[] = []
  const keys = new Set<string>()

  for (const line of transcript.split('\n')) {
    const remembered = /记住[：:]\s*(.+)/.exec(line)
    if (remembered) facts.push(remembered[1] as string)
    if (line.includes('divide by zero') && !facts.some((f) => f.includes('divide by zero'))) {
      facts.push('失败的用例是 divide by zero')
    }
    const called = /调用了：(.+)/.exec(line)
    if (called) changes.push((called[1] as string).slice(0, 60))
    if (/还没|尚未|待办/.test(line)) pending.push(line.replace(/^【[^】]+】/, '').slice(0, 40))
    for (const match of line.matchAll(/[\w./-]+\.(?:js|json|md)/g)) keys.add(match[0])
    for (const match of line.matchAll(/node --test|pnpm [\w:-]+/g)) keys.add(match[0])
  }

  const section = (heading: string, rows: string[]): string =>
    `${heading}\n${(rows.length > 0 ? rows.slice(0, 4) : ['无']).map((row) => `- ${row}`).join('\n')}`

  return [
    section(SUMMARY_HEADINGS[0] as string, facts),
    section(SUMMARY_HEADINGS[1] as string, changes),
    section(SUMMARY_HEADINGS[2] as string, pending),
    section(SUMMARY_HEADINGS[3] as string, [...keys]),
  ].join('\n')
}

const SCENES: Array<{ match: RegExp; scene: MockScene }> = [
  { match: /修|改|加上|保护/, scene: FIX_IT },
  { match: /测试|哪个用例/, scene: FIND_FAILING },
  { match: /解释|讲讲|说明|为什么|哪里有问题/, scene: EXPLAIN },
]

let turn = { text: '', base: 0 }

/**
 * 离线引擎选步骤的依据是「整段历史里的工具结果条数」，多轮会话里它和「这一轮的第几步」
 * 不相等。所以记下这一轮开始时的条数，在剧本前面垫上同样多的空步骤。
 */
export function pickScene(userText: string, toolResults: number): MockScene {
  // 摘要请求排在最前面判断：它的输入是一整段转录，正好会命中下面那几个关键词
  if (userText.startsWith(TRANSCRIPT_PREFIX)) {
    return { name: 'summarize', steps: [{ text: summarizeTranscript(userText) }] }
  }

  if (userText !== turn.text) turn = { text: userText, base: toolResults }
  const scene = SCENES.find((entry) => entry.match.test(userText))?.scene ?? EXPLAIN
  if (turn.base === 0) return scene
  const pad: MockStep[] = Array.from({ length: turn.base }, () => ({}))
  return { name: scene.name, steps: [...pad, ...scene.steps] }
}
