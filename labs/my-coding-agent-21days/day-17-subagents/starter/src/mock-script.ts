/**
 * 今天的离线剧本。每天按当天要展示的现象重写，所以它不冻结。
 *
 * D16 加了一场 SKILL_FLOW：用户一句话同时命中两条技能（calc 约定与测试手册），
 * 模型按约定改代码、按手册跑测试，并在最后点名它用的是哪份约定。
 * 它要证明的是：**技能不占工具清单的位置，它只是在合适的时候出现在模型面前的一段文字。**
 *
 * 原 D15 加了一场 MCP_FLOW：模型先查团队笔记再查工单，两次调用的都是**远端工具**。
 * 它要证明的事只有一句：**远端工具在循环眼里和本地工具没有任何区别。**
 * 剧本里写的是带命名空间的本地名（mcp__notes__search），而发到 server 上的是原名。
 *
 * 原 D14 加了一场 REFACTOR：一次任务里连改同一个文件两次，好让快照的去重肉眼可见。
 *
 * 原 D13 加了两场长剧本：PLAN_FLOW（提问 → 被探索模式挡回来 → 只读探查 → 交计划 →
 * 批准 → 改文件 → 验证）与 DRIFT_FLOW（故意偏离计划，让核对表打出两个警告）。
 * 原 D12 的「写摘要」那一场原样留着（摘要请求会命中 TRANSCRIPT_PREFIX 那一支）。
 */
import type { MockScene, MockStep } from './providers/mock.js'
import { pickAgentScene } from './agents/mock-scenes.js'
import { SUMMARY_HEADINGS, TRANSCRIPT_PREFIX } from './context/summarize.js'

const OLD_DIVIDE = `export function divide(a, b) {
  return a / b
}`

const NEW_DIVIDE = `export function divide(a, b) {
  if (b === 0) throw new Error('divide by zero')
  return a / b
}`

const NOTED_DIVIDE = `// 除数为 0 时抛错，而不是返回 Infinity
export function divide(a, b) {
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

/**
 * 本天新增：一次任务里连着改同一个文件两次。
 *
 * 它是为快照那条时间线写的：两次 edit 会产生四条记录（前后各一张），
 * 而其中第一次的「改之后」与第二次的「改之前」内容完全相同，
 * 所以对象库里只有三份对象——**内容寻址的去重在这里第一次肉眼可见。**
 */
const REFACTOR: MockScene = {
  name: 'refactor',
  steps: [
    {
      text: '先给 divide 加上除零保护。',
      toolCalls: [
        {
          id: 'call_edit_guard',
          name: 'edit_file',
          args: { path: 'src/calc.js', old_string: OLD_DIVIDE, new_string: NEW_DIVIDE },
        },
      ],
    },
    {
      text: '再给它补一行说明。',
      toolCalls: [
        {
          id: 'call_edit_note',
          name: 'edit_file',
          args: { path: 'src/calc.js', old_string: NEW_DIVIDE, new_string: NOTED_DIVIDE },
        },
      ],
    },
    {
      text: '跑测试确认。',
      toolCalls: [{ id: 'call_test_3', name: 'run_command', args: { command: 'node --test' } }],
    },
    { text: '四个用例全绿，divide 也带上说明了。' },
  ],
}

/**
 * 本天新增：连着调两个远端工具。
 *
 * 第一步调笔记库（stdio），第二步调工单系统（HTTP），两步都要过审批门——
 * 这正是今天的信任边界：**服务端说自己只读不作数。**
 */
const MCP_FLOW: MockScene = {
  name: 'mcp-flow',
  steps: [
    {
      text: '动手之前先查一下团队笔记里有没有关于除零的约定。',
      toolCalls: [
        {
          id: 'call_mcp_notes',
          name: 'mcp__notes__search',
          args: { query: '除数为 0' },
        },
      ],
    },
    {
      text: '笔记里确实有这条约定。再看看工单系统里有没有相关的工单。',
      toolCalls: [
        { id: 'call_mcp_tickets', name: 'mcp__tickets__search', args: { query: 'divide' } },
      ],
    },
    {
      text:
        '两边都查到了：团队约定是除数为 0 时抛错，工单 T-1001 记的就是这个问题。' +
        '来源是外部的笔记库与工单系统，不是本仓库里的代码。',
    },
  ],
}

/**
 * 本天新增：一句话同时命中两条技能之后，模型按技能里写的规矩干活。
 *
 * 两处细节是刻意的：抛错的消息逐字是 calc-conventions 里写的 divide by zero，
 * 跑测试用的是 node-test-runner 里写的 node --test。**技能有没有真的起作用，
 * 判据就是「模型做的事能不能在技能正文里逐字找到出处」**，不是它嘴上说没说读过。
 */
const SKILL_FLOW: MockScene = {
  name: 'skill-flow',
  steps: [
    {
      text: '按 calc-conventions 里的约定，除数为 0 时应该抛错而不是返回 Infinity。我来改。',
      toolCalls: [
        {
          id: 'call_skill_edit',
          name: 'edit_file',
          args: { path: 'src/calc.js', old_string: OLD_DIVIDE, new_string: NEW_DIVIDE },
        },
      ],
    },
    {
      text: '再按 node-test-runner 里的办法跑一遍测试。',
      toolCalls: [{ id: 'call_skill_test', name: 'run_command', args: { command: 'node --test' } }],
    },
    {
      text:
        '四个用例全绿。改动依据是团队技能 calc-conventions：divide 在除数为 0 时抛 ' +
        'divide by zero，不返回 Infinity；测试的跑法来自 node-test-runner。',
    },
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
  { match: /除零|技能|手艺卡/, scene: SKILL_FLOW },
  { match: /笔记|工单/, scene: MCP_FLOW },
  { match: /注释|说明也补|改两次/, scene: REFACTOR },
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

  // 子 Agent 的消息数组是一次性的，不需要垫步（见 agents/mock-scenes.ts）
  const agentScene = pickAgentScene(userText)
  if (agentScene) return agentScene
  if (userText !== turn.text) turn = { text: userText, base: toolResults }
  const scene = SCENES.find((entry) => entry.match.test(userText))?.scene ?? EXPLAIN
  if (turn.base === 0) return scene
  const pad: MockStep[] = Array.from({ length: turn.base }, () => ({}))
  return { name: scene.name, steps: [...pad, ...scene.steps] }
}
