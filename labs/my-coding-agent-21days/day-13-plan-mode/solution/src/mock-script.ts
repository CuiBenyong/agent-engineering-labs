/**
 * 今天的离线剧本。每天按当天要展示的现象重写，所以它不冻结。
 *
 * D13 加了两场，都是**一句用户输入驱动一整条链路**的长剧本：
 *
 *   PLAN_FLOW   先问后做的完整七步：提问 → 试着跑命令（被探索模式挡回来）→
 *               改用只读工具看代码 → 交计划 → 批准 → 改文件 → 跑测试验证
 *   DRIFT_FLOW  故意偏离计划的对照：计划里只写了一个文件，执行时多改了一个，
 *               而且没跑验证命令。它存在的意义是让核对表打出两个警告——
 *               **一份计划审批机制，只有在能抓到偏离的时候才是机制。**
 *
 * 第二步「试着跑命令然后被挡回来」是本天最值得看的一步，也是刻意写进剧本的：
 * 探索模式挡住 run_command 之后，回灌给模型的是 PLAN_RULES 里那句话
 * （「先探清楚，然后用 submit_plan 交一份计划」），于是它下一步真的改用只读工具。
 * 这正是第五天定下的口径——**拒绝的文本要写成模型能改道的样子**——在今天的复用。
 *
 * D12 的「写摘要」那一场原样留着（摘要请求会命中 TRANSCRIPT_PREFIX 那一支）。
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

/** 今天的那份计划。正文与自检都引用它，所以只写一处 */
export const DEMO_PLAN = {
  goal: '给 divide 加上除零保护，让 divide by zero 那个用例变绿',
  steps: [
    { files: ['src/calc.js'], action: '在 divide 开头判断除数为 0，为 0 时抛错' },
    { files: [], action: '跑一遍测试确认四个用例全绿' },
  ],
  verify: ['跑 node --test，四个用例全绿'],
  risks: ['原来依赖 divide(1, 0) 返回 Infinity 的调用方会开始收到异常'],
}

const ASK_STEP: MockStep = {
  text: '动手之前有一件事必须问清楚，两种做法改出来的代码完全不同。',
  toolCalls: [
    {
      id: 'call_ask_1',
      name: 'ask_user',
      args: {
        question: 'divide 的除数为 0 时，你希望它怎么表现？',
        options: [
          { value: 'throw', label: '抛错（测试里那个用例期望的行为）' },
          { value: 'null', label: '返回 null，让调用方自己判断' },
          { value: 'infinity', label: '保持现在的 Infinity 不变，只改测试' },
        ],
        default: 'throw',
      },
    },
  ],
}

/** 先问后做的完整链路。步骤索引 = 已有的工具结果条数 */
const PLAN_FLOW: MockScene = {
  name: 'plan-flow',
  steps: [
    ASK_STEP,
    {
      text: '明白了，抛错。我先跑一遍测试看现在是什么样。',
      toolCalls: [{ id: 'call_test_probe', name: 'run_command', args: { command: 'node --test' } }],
    },
    {
      text: '现在是只读探索模式，跑命令被挡回来了——那我用只读工具看代码。',
      toolCalls: [{ id: 'call_read_calc', name: 'read_file', args: { path: 'src/calc.js' } }],
    },
    {
      text: '看清楚了，divide 直接返回 a 除以 b。出一份计划给你过。',
      toolCalls: [{ id: 'call_submit_1', name: 'submit_plan', args: DEMO_PLAN }],
    },
    {
      text: '按计划的第一步改 src/calc.js。',
      toolCalls: [
        {
          id: 'call_edit_calc',
          name: 'edit_file',
          args: { path: 'src/calc.js', old_string: OLD_DIVIDE, new_string: NEW_DIVIDE },
        },
      ],
    },
    {
      text: '按第二步跑测试验证。',
      toolCalls: [
        { id: 'call_test_verify', name: 'run_command', args: { command: 'node --test' } },
      ],
    },
    {
      text:
        '这一轮的动作都在上面：成功的那几步与计划一致；' +
        '被挡回来的说明计划还没拿到批准，我等你的意见。',
    },
  ],
}

/**
 * 偏离计划的对照：直接交同一份计划，改完 src/calc.js 之后**多改一个计划外的文件**，
 * 而且不跑验证命令。它复用 PLAN_FLOW 的第 4、5 两步（交计划、改文件），
 * 只把后面换掉——两条支线共用同一份计划，核对表的差别才只来自「实际做了什么」。
 */
const DRIFT_FLOW: MockScene = {
  name: 'drift-flow',
  steps: [
    PLAN_FLOW.steps[3] as MockStep,
    PLAN_FLOW.steps[4] as MockStep,
    {
      text: '顺手写一份说明文件。',
      toolCalls: [
        {
          id: 'call_create_notes',
          name: 'create_file',
          args: { path: 'src/notes.md', content: '# divide\n\n除数为 0 时抛错。\n' },
        },
      ],
    },
    { text: '改完了。' },
  ],
}

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

/** 匹配顺序有讲究：今天两场长剧本排在前面，否则会被 D8 那几条更宽的规则吃掉 */
const SCENES: Array<{ match: RegExp; scene: MockScene }> = [
  { match: /顺手|连带|一起改/, scene: DRIFT_FLOW },
  { match: /安全|稳一点|按计划|先问/, scene: PLAN_FLOW },
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
