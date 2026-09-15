/**
 * D13 到 D17 攒下来的那几场离线剧本。**本天从 mock-script.ts 纯搬运过来，一个字都没改。**
 *
 * 搬的理由是行数：那个文件已经 346 行，本课单文件上限 350，而今天还要加两场新剧本。
 * 拆的界线在「剧本内容」与「怎么挑剧本」之间：这里是一沓剧本，
 * mock-script.ts 剩下的是当天新剧本加那张匹配表。
 */
import type { MockScene, MockStep } from './providers/mock.js'
import { SUMMARY_HEADINGS } from './context/summarize.js'

export const OLD_DIVIDE = `export function divide(a, b) {
  return a / b
}`

export const NEW_DIVIDE = `export function divide(a, b) {
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
export const PLAN_FLOW: MockScene = {
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
export const DRIFT_FLOW: MockScene = {
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
/**
 * 叠加说明（来自 D18）：下面三场剧本（REFACTOR / SKILL_FLOW / FIX_IT）原本是 D14–D16 写的，
 * 那时还没有钩子，所以模型都是**凭记忆直接做精确替换**。D18 加了 read-before-write
 * 之后，这三场的第一次 edit_file 会被 pre_tool 钩子拦下，工具根本不执行——
 * 剧本照样跑完，文件却一个字没改，模型还会照着剧本说「全绿」，而且不会有任何东西报错。
 * 所以 D18 给三场各补了一步 read_file：真实模型在这条规则下也只能先读再改，
 * 补上之后剧本才和当下这个 Agent 对得上。
 */
export const REFACTOR: MockScene = {
  name: 'refactor',
  steps: [
    {
      text: '先把 src/calc.js 读一遍——凭记忆做精确替换会被 read-before-write 拦下。',
      toolCalls: [{ id: 'call_refactor_read', name: 'read_file', args: { path: 'src/calc.js' } }],
    },
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
export const MCP_FLOW: MockScene = {
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
export const SKILL_FLOW: MockScene = {
  name: 'skill-flow',
  steps: [
    {
      text: '按 calc-conventions 动手之前，先把 src/calc.js 读一遍。',
      toolCalls: [{ id: 'call_skill_read', name: 'read_file', args: { path: 'src/calc.js' } }],
    },
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
export const EXPLAIN: MockScene = {
  name: 'explain',
  steps: [
    {
      text:
        '你贴进来的 src/calc.js 里，divide 直接返回 a 除以 b：b 为 0 时会得到 Infinity 而不是抛错。' +
        '测试里那个 divide by zero 用例就是因为这个失败的。我不用再读一遍文件了。',
    },
  ],
}

export const FIND_FAILING: MockScene = {
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

export const FIX_IT: MockScene = {
  name: 'fix-it',
  steps: [
    {
      text: '先把 src/calc.js 读一遍，再动手改。',
      toolCalls: [{ id: 'call_fix_read', name: 'read_file', args: { path: 'src/calc.js' } }],
    },
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
export function summarizeTranscript(transcript: string): string {
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
