/**
 * 今天的离线剧本。每天按当天要展示的现象重写，所以它不冻结。
 *
 * D7 要展示的是「跨进程接着干」，所以剧本第一次被拆成**两段两轮**：
 *   第一轮：跑测试，查明失败的是哪个用例（一个事实）
 *   第二轮（重启之后）：按上一轮查到的事实动手修，再跑一次
 *
 * 这里有一个今天才需要解决的问题，值得单独说：离线剧本引擎（冻结）选步骤的依据是
 * **整段历史里的工具结果条数**，而不是「这一轮的第几步」。单轮的时候两者相等，
 * 多轮就错位了——第二轮的第一步会拿到第 2 步的台词。
 *
 * 解法在下面的 pickScene 里：记下「这句用户消息第一次出现时，历史里已经有多少条
 * 工具结果」，然后在剧本前面垫上同样多的空步骤。于是每一轮的剧本都从自己的第 0 步开始。
 * 这个补偿只发生在剧本层，冻结的引擎一行都不用改。
 */
import type { MockScene, MockStep } from './providers/mock.js'

const OLD_DIVIDE = `export function divide(a, b) {
  return a / b
}`

const NEW_DIVIDE = `export function divide(a, b) {
  if (b === 0) throw new Error('divide by zero')
  return a / b
}`

/** 第一轮：查明事实，不动手 */
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

/** 第二轮：引用上一轮查到的事实动手改 */
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
  { match: /测试|失败|哪个用例/, scene: FIND_FAILING },
]

/** 这一轮的用户消息，以及它出现时历史里已有的工具结果条数 */
let turn = { text: '', base: 0 }

export function pickScene(userText: string, toolResults: number): MockScene {
  if (userText !== turn.text) turn = { text: userText, base: toolResults }
  const scene = SCENES.find((entry) => entry.match.test(userText))?.scene ?? FIND_FAILING
  if (turn.base === 0) return scene
  // 垫上 base 个空步骤，把这一轮的第 0 步顶到 index 等于 base 的位置。
  // 空步骤永远不会被选中，因为选步骤用的 toolResults 一定不小于 base
  const pad: MockStep[] = Array.from({ length: turn.base }, () => ({}))
  return { name: scene.name, steps: [...pad, ...scene.steps] }
}
