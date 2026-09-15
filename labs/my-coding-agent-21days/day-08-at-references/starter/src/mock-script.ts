/**
 * 今天的离线剧本。每天按当天要展示的现象重写，所以它不冻结。
 *
 * D8 要展示的是「资料已经在上下文里，就不用再翻仓库了」，所以主场景**一次工具调用都没有**：
 * 用户把文件用 @ 贴进来，模型直接给结论。这正是引用注入的收益——
 * 前七天它要 glob、read_file 来回三四轮才能拿到同一份材料。
 *
 * D7 的两段剧本（先查明事实、重启之后再动手）留着，因为会话恢复那条链路今天还在用。
 * 补偿 base 的那段逻辑也留着，理由见下面 pickScene 的注释。
 */
import type { MockScene, MockStep } from './providers/mock.js'

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

const SCENES: Array<{ match: RegExp; scene: MockScene }> = [
  { match: /修|改|加上|保护/, scene: FIX_IT },
  { match: /测试|哪个用例/, scene: FIND_FAILING },
  { match: /解释|讲讲|说明|为什么|哪里有问题/, scene: EXPLAIN },
]

let turn = { text: '', base: 0 }

/**
 * 离线引擎选步骤的依据是「整段历史里的工具结果条数」，多轮会话里它和「这一轮的第几步」
 * 不相等。所以记下这一轮开始时的条数，在剧本前面垫上同样多的空步骤。
 * 空步骤永远不会被选中，因为选步骤用的条数一定不小于 base。
 */
export function pickScene(userText: string, toolResults: number): MockScene {
  if (userText !== turn.text) turn = { text: userText, base: toolResults }
  const scene = SCENES.find((entry) => entry.match.test(userText))?.scene ?? EXPLAIN
  if (turn.base === 0) return scene
  const pad: MockStep[] = Array.from({ length: turn.base }, () => ({}))
  return { name: scene.name, steps: [...pad, ...scene.steps] }
}
