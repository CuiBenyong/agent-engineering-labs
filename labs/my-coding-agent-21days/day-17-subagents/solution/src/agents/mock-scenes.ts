/**
 * 今天新增的离线剧本，单独一个文件。本天新增。
 *
 * 为什么不写进 mock-script.ts：那个文件已经 346 行，本课单文件上限 350。
 * **文件到了上限就拆**，是这门课的纪律之一。mock-script.ts 只多了三行接线。
 *
 * 这里有两类场景，它们的分工正好是今天的结构：
 *   - 主会话那一场：模型把一件事拆成两张派单，调 dispatch_agents 一次；
 *   - 派单场景：每个子 Agent 自己那一趟，**它们的消息数组互不相干**，
 *     所以剧本也各选各的，按派单文本匹配。
 *
 * 派单场景要绕开 mock-script.ts 里那套「垫空步骤」的逻辑：那套逻辑是为
 * 「一条会话里连着说好几句」准备的，而子 Agent 的消息数组永远是一次性的、
 * 只有一句用户消息。所以 pickAgentScene 在 pickScene 的最前面早退，不进垫步那一支。
 */
import type { MockScene } from '../providers/mock.js'
import { TASK_PREFIX } from './spec.js'

const OLD_DIVIDE = `export function divide(a, b) {
  return a / b
}`

const THROW_DIVIDE = `export function divide(a, b) {
  if (b === 0) throw new Error('divide by zero')
  return a / b
}`

const NULL_DIVIDE = `export function divide(a, b) {
  if (b === 0) return null
  return a / b
}`

const OLD_README = '那就是今天要修的东西。'
const NEW_README = `那就是今天要修的东西。

## divide 的除零行为

除数为 0 时 divide 会抛 divide by zero，不再返回 Infinity。`

/** 派单一：给 divide 加除零保护，抛错 */
const THROW_GUARD: MockScene = {
  name: 'sub-throw-guard',
  steps: [
    {
      text: '派单要求除数为 0 时抛错，我直接改 src/calc.js。',
      toolCalls: [
        {
          id: 'call_sub_throw',
          name: 'edit_file',
          args: { path: 'src/calc.js', old_string: OLD_DIVIDE, new_string: THROW_DIVIDE },
        },
      ],
    },
    {
      text:
        '已改 src/calc.js：divide 在除数为 0 时抛 divide by zero，其余行为不变。' +
        '没有改别的文件，也没有跑测试（白名单里没有跑命令的工具）。',
    },
  ],
}

/** 派单二：同一个文件，改成另一种做法。它存在只为造一次冲突 */
const NULL_GUARD: MockScene = {
  name: 'sub-null-guard',
  steps: [
    {
      text: '派单要求除数为 0 时返回 null，我改 src/calc.js。',
      toolCalls: [
        {
          id: 'call_sub_null',
          name: 'edit_file',
          args: { path: 'src/calc.js', old_string: OLD_DIVIDE, new_string: NULL_DIVIDE },
        },
      ],
    },
    { text: '已改 src/calc.js：divide 在除数为 0 时返回 null。' },
  ],
}

/** 派单三：改文档。它和派单一改的不是同一个文件，所以两者可以真并行 */
const README_DOC: MockScene = {
  name: 'sub-readme-doc',
  steps: [
    {
      text: '派单要求补一段说明，我在 README.md 末尾加一节。',
      toolCalls: [
        {
          id: 'call_sub_doc',
          name: 'edit_file',
          args: { path: 'README.md', old_string: OLD_README, new_string: NEW_README },
        },
      ],
    },
    { text: '已改 README.md：末尾加了一节说明 divide 的除零行为。没有动任何代码文件。' },
  ],
}

/** 派单四：只跑测试。用来演示「白名单不给写工具」的那一支 */
const RUN_TESTS: MockScene = {
  name: 'sub-run-tests',
  steps: [
    {
      text: '派单只要求跑测试，我跑一遍。',
      toolCalls: [{ id: 'call_sub_test', name: 'run_command', args: { command: 'node --test' } }],
    },
    { text: '测试跑完了，结果见上。我没有改任何文件。' },
  ],
}

/** 主会话：把一件事拆成两张互不相干的派单 */
const DISPATCH_FLOW: MockScene = {
  name: 'dispatch-flow',
  steps: [
    {
      text: '这两件事改的不是同一批文件，也不互相依赖，可以分头干。我派两个子 Agent。',
      toolCalls: [
        {
          id: 'call_dispatch',
          name: 'dispatch_agents',
          args: {
            agents: [
              {
                id: 'calc-guard',
                task: '给 src/calc.js 的 divide 加上除零保护，除数为 0 时抛 divide by zero',
                allow: ['read_file', 'edit_file'],
              },
              {
                id: 'doc-writer',
                task: '在 README.md 末尾补一段说明，写清 divide 在除数为 0 时会抛错',
                allow: ['read_file', 'edit_file'],
              },
            ],
          },
        },
      ],
    },
    {
      text:
        '两个子 Agent 都完成了：calc-guard 改了 src/calc.js，doc-writer 改了 README.md，' +
        '两份改动都已经合并回来，没有冲突。它们中间说了什么我没看到，也不需要看到。',
    },
  ],
}

/**
 * 主会话：故意把同一个文件派给两个人，两人做法不同。它存在只为让冲突肉眼可见。
 *
 * 剧本里的第二步是**照着回执如实说**，不是自己挑一份当结论——这正是系统提示里
 * 那句「报了冲突就如实告诉用户哪个文件冲突了」在离线下的样子。
 */
const CLASH_FLOW: MockScene = {
  name: 'dispatch-clash',
  steps: [
    {
      text: '这两种做法都改 src/calc.js。我先各派一个人做出来，再看看差在哪。',
      toolCalls: [
        {
          id: 'call_dispatch_clash',
          name: 'dispatch_agents',
          args: {
            agents: [
              {
                id: 'throw-side',
                task: '给 src/calc.js 的 divide 加上除零保护，除数为 0 时抛 divide by zero',
                allow: ['read_file', 'edit_file'],
              },
              {
                id: 'null-side',
                task: '把 src/calc.js 里 divide 的除零改成返回 null',
                allow: ['read_file', 'edit_file'],
              },
            ],
          },
        },
      ],
    },
    {
      text:
        '两个人都改了 src/calc.js，而且改法不同：一个抛错，一个返回 null。' +
        '这是冲突，我没有替你挑一份落盘——两份改动都还在回执里，' +
        '请你定下用哪一种，我再按你定的那份改一次。',
    },
  ],
}

const SUBTASKS: Array<{ match: RegExp; scene: MockScene }> = [
  { match: /返回 null/, scene: NULL_GUARD },
  { match: /README/, scene: README_DOC },
  { match: /跑.*测试|node --test/, scene: RUN_TESTS },
  { match: /divide by zero|除零|抛错/, scene: THROW_GUARD },
]

/** 主会话那两场的触发词。写窄一点，免得吃掉 mock-script.ts 里已有的那几场 */
const DISPATCH_MATCH = /分头|并行|同时派|两个子 Agent/
/** 冲突那一场要排在前面判断：它的句子里多半也带着「分头」之类的词 */
const CLASH_MATCH = /两种做法|都改同一个|冲突/

/**
 * 今天这批场景的唯一入口。认不出来就返回 null，交回给 mock-script.ts 原来的表。
 */
export function pickAgentScene(userText: string): MockScene | null {
  if (userText.startsWith(TASK_PREFIX)) {
    return SUBTASKS.find((entry) => entry.match.test(userText))?.scene ?? RUN_TESTS
  }
  if (CLASH_MATCH.test(userText)) return CLASH_FLOW
  return DISPATCH_MATCH.test(userText) ? DISPATCH_FLOW : null
}
