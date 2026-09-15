/**
 * 今天的离线剧本。每天按当天要展示的现象重写，所以它不冻结。
 *
 * D9 要展示的是「指令文件真的在起作用」，而最容易看清这件事的地方是**冲突**：
 * 三层指令都写了「测试命令」，用户级说 npm test、项目级说 node --test、
 * 目录级说 node --test test/calc.test.js。合并规则是越具体越靠后、后者赢，
 * 所以剧本里模型执行的那条命令**只能是目录级那一条**——参数里带 test/calc.test.js。
 *
 * 这是本课离线剧本的一个惯用手法：**把「规则生效了」变成一个可断言的参数值。**
 * 单看模型说了什么没法验（它可以嘴上说一套做一套），但工具调用的参数是硬的。
 *
 * D8 的解释场景与 D7 的修复场景留着，因为引用注入与会话恢复那两条链路今天还在用。
 */
import type { MockScene, MockStep } from './providers/mock.js'

const OLD_DIVIDE = `export function divide(a, b) {
  return a / b
}`

const NEW_DIVIDE = `export function divide(a, b) {
  if (b === 0) throw new Error('divide by zero')
  return a / b
}`

/** 今天的主场景：按最具体那一层的测试命令跑 */
const RUN_TESTS: MockScene = {
  name: 'run-tests',
  steps: [
    {
      text:
        '项目级指令写的测试命令是 node --test，但 src/ 那一层更具体：node --test test/calc.test.js。' +
        '按「越具体越靠后、后者赢」，我用后面这条。',
      toolCalls: [
        {
          id: 'call_test_1',
          name: 'run_command',
          args: { command: 'node --test test/calc.test.js' },
        },
      ],
    },
    {
      text:
        '失败的是 divide by zero 那个用例。目录级指令里那条「除零处理」说得很清楚：' +
        'divide 遇到 0 必须抛错，不能返回 Infinity。要我按这条改掉吗？',
    },
  ],
}

/** 问规矩：把三层来源说清楚，一次工具调用都不需要 */
const EXPLAIN_RULES: MockScene = {
  name: 'explain-rules',
  steps: [
    {
      text:
        '我这次读到三层指令：用户级是你的个人偏好（中文回答），项目级是这个仓库的规矩' +
        '（代码风格、断言库），目录级是 src/ 的特殊规矩（测试命令与除零处理）。' +
        '同一件事有多种说法时我听最具体的那一层，也就是目录级。',
    },
  ],
}

const FIX_IT: MockScene = {
  name: 'fix-it',
  steps: [
    {
      text: '按目录级那条「除零处理」，给 divide 加上除零保护。',
      toolCalls: [
        {
          id: 'call_edit_src',
          name: 'edit_file',
          args: { path: 'src/calc.js', old_string: OLD_DIVIDE, new_string: NEW_DIVIDE },
        },
      ],
    },
    {
      text: '再按目录级那条测试命令确认一次。',
      toolCalls: [
        {
          id: 'call_test_2',
          name: 'run_command',
          args: { command: 'node --test test/calc.test.js' },
        },
      ],
    },
    { text: '四个用例全绿，divide by zero 那个用例修好了。' },
  ],
}

const EXPLAIN_FILE: MockScene = {
  name: 'explain-file',
  steps: [
    {
      text:
        '你贴进来的 src/calc.js 里，divide 直接返回 a 除以 b：b 为 0 时会得到 Infinity 而不是抛错。' +
        '这正好违反了目录级指令里那条「除零处理」。我不用再读一遍文件了。',
    },
  ],
}

const SCENES: Array<{ match: RegExp; scene: MockScene }> = [
  { match: /修|改掉|加上|保护/, scene: FIX_IT },
  { match: /规矩|指令|规范|读到什么/, scene: EXPLAIN_RULES },
  { match: /测试|跑一下|哪个用例/, scene: RUN_TESTS },
  { match: /解释|讲讲|说明|为什么|哪里有问题/, scene: EXPLAIN_FILE },
]

let turn = { text: '', base: 0 }

/**
 * 离线引擎选步骤的依据是「整段历史里的工具结果条数」，多轮会话里它和「这一轮的第几步」
 * 不相等。所以记下这一轮开始时的条数，在剧本前面垫上同样多的空步骤。
 */
export function pickScene(userText: string, toolResults: number): MockScene {
  if (userText !== turn.text) turn = { text: userText, base: toolResults }
  const scene = SCENES.find((entry) => entry.match.test(userText))?.scene ?? EXPLAIN_RULES
  if (turn.base === 0) return scene
  const pad: MockStep[] = Array.from({ length: turn.base }, () => ({}))
  return { name: scene.name, steps: [...pad, ...scene.steps] }
}
