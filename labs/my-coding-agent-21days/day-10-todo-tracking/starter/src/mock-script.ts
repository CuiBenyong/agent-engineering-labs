/**
 * 今天的离线剧本。每天按当天要展示的现象重写，所以它不冻结。
 *
 * D10 要展示三件事，各一个场景：
 *
 *   1. 主链路：三步任务从 0/3 走到 3/3，中途**始终只有一个进行中**
 *   2. 违规纠正：一次给两个 in_progress，被拒绝并回灌，下一轮它自己改对
 *   3. `INJECT=loop`：清单写完之后就再也不动，而它一直在调同一个工具——
 *      打转检测会挡住那个调用，停滞检测会指出「整件事没进展」
 *
 * 第三个场景是今天最值得看的一个，因为它同时暴露了两个机制的分工：
 * **打转检测看「有没有重复调用」，清单看「有没有进展」。** 前者只挡住单次调用，
 * 后者才说得出「你已经三轮没往前走了」。
 *
 * 一个和以往不同的地方：停滞提醒是以 user 角色回灌的，于是它会变成
 * 「最后一条用户消息」，而离线引擎是按这条消息选场景的。所以下面 pickScene 里
 * 多了一句：带（系统提醒）前缀的消息不算新指令，继续用当前这一轮的场景。
 */
import type { MockScene, MockStep } from './providers/mock.js'
import { NUDGE_PREFIX } from './todo/stall.js'

const OLD_DIVIDE = `export function divide(a, b) {
  return a / b
}`

const NEW_DIVIDE = `export function divide(a, b) {
  if (b === 0) throw new Error('divide by zero')
  return a / b
}`

const PLAN = [
  { id: 't1', text: '跑一次测试，确认哪个用例是红的' },
  { id: 't2', text: '给 divide 补上除零保护' },
  { id: 't3', text: '再跑一次测试，确认全绿' },
]

/** 整表替换的一步：按状态数组生成 items */
function table(statuses: Array<'pending' | 'in_progress' | 'done'>) {
  return PLAN.map((item, i) => ({ ...item, status: statuses[i] as string }))
}

const TEST_CMD = 'node --test test/calc.test.js'

/**
 * 主场景。每一步只发一个工具调用——离线引擎是按「历史里的工具结果条数」选步骤的，
 * 一步发两个调用会让步骤号跳两格。
 *
 * 状态推进用整表替换而不是七次单项更新，是为了让整件事在八轮上限之内跑完：
 * 一次整表替换能同时把「上一条 done」和「下一条 in_progress」一起改掉。
 */
const FIX_WITH_PLAN: MockScene = {
  name: 'fix-with-plan',
  steps: [
    {
      text: '这活儿有三步，我先把计划写下来。',
      toolCalls: [
        {
          id: 'call_todo_1',
          name: 'update_todos',
          args: { items: table(['in_progress', 'pending', 'pending']) },
        },
      ],
    },
    {
      text: '先跑测试。',
      toolCalls: [{ id: 'call_test_1', name: 'run_command', args: { command: TEST_CMD } }],
    },
    {
      text: '失败的是 divide by zero。第一步做完，开始第二步。',
      toolCalls: [
        {
          id: 'call_todo_2',
          name: 'update_todos',
          args: { items: table(['done', 'in_progress', 'pending']) },
        },
      ],
    },
    {
      text: '给 divide 加上除零保护。',
      toolCalls: [
        {
          id: 'call_edit_src',
          name: 'edit_file',
          args: { path: 'src/calc.js', old_string: OLD_DIVIDE, new_string: NEW_DIVIDE },
        },
      ],
    },
    {
      text: '改完了，进第三步。',
      toolCalls: [
        {
          id: 'call_todo_3',
          name: 'update_todos',
          args: { items: table(['done', 'done', 'in_progress']) },
        },
      ],
    },
    {
      text: '再跑一次确认。',
      toolCalls: [{ id: 'call_test_2', name: 'run_command', args: { command: TEST_CMD } }],
    },
    {
      text: '四个用例全绿。',
      toolCalls: [
        {
          id: 'call_todo_4',
          name: 'update_todos',
          args: { items: table(['done', 'done', 'done']) },
        },
      ],
    },
    { text: '三步都做完了：定位、修复、验证，divide by zero 那个用例已经绿了。' },
  ],
}

/** 违规场景：一次给两个进行中，被拒绝，下一轮自己改对 */
const TWO_RUNNING: MockScene = {
  name: 'two-running',
  steps: [
    {
      text: '我打算同时推进前两步。',
      toolCalls: [
        {
          id: 'call_todo_bad',
          name: 'update_todos',
          args: { items: table(['in_progress', 'in_progress', 'pending']) },
        },
      ],
    },
    {
      text: '好，一次只做一件。只把第一步设为进行中。',
      toolCalls: [
        {
          id: 'call_todo_fixed',
          name: 'update_todos',
          args: { items: table(['in_progress', 'pending', 'pending']) },
        },
      ],
    },
    { text: '清单改好了：第一步进行中，另外两步待做。' },
  ],
}

/**
 * 打转场景（`INJECT=loop`）：计划写完之后，每一轮都用**完全相同的参数**
 * 调同一个工具，清单再也不动。
 *
 * 会看到两件事先后发生：第三次相同调用被打转检测挡下来（不执行、回灌一条说明），
 * 而清单三轮没动之后停滞检测开始提醒，再一次就停下这一轮。
 */
const LOOP: MockScene = {
  name: 'loop',
  steps: [
    {
      text: '先写计划。',
      toolCalls: [
        {
          id: 'call_todo_loop',
          name: 'update_todos',
          args: { items: table(['in_progress', 'pending', 'pending']) },
        },
      ],
    },
    ...Array.from({ length: 8 }, (_, i) => ({
      text: '我再看一眼 calc.js。',
      toolCalls: [{ id: `call_read_${i}`, name: 'read_file', args: { path: 'src/calc.js' } }],
    })),
  ],
}

const SCENES: Array<{ match: RegExp; scene: MockScene }> = [
  { match: /同时|两件|一起推进/, scene: TWO_RUNNING },
  { match: /修|改掉|失败的测试/, scene: FIX_WITH_PLAN },
  { match: /看一眼|再看看|读一下/, scene: LOOP },
]

let turn = { text: '', base: 0 }

/**
 * 离线引擎选步骤的依据是「整段历史里的工具结果条数」，多轮会话里它和「这一轮的第几步」
 * 不相等。所以记下这一轮开始时的条数，在剧本前面垫上同样多的空步骤。
 */
export function pickScene(userText: string, toolResults: number): MockScene {
  const inject = process.env.INJECT ?? ''
  // 停滞提醒以 user 角色进消息数组，它不是新指令：沿用当前这一轮的场景
  const text = userText.startsWith(NUDGE_PREFIX) ? turn.text : userText
  if (text !== turn.text) turn = { text, base: toolResults }
  const scene =
    inject === 'loop'
      ? LOOP
      : (SCENES.find((entry) => entry.match.test(text))?.scene ?? FIX_WITH_PLAN)
  if (turn.base === 0) return scene
  const pad: MockStep[] = Array.from({ length: turn.base }, () => ({}))
  return { name: scene.name, steps: [...pad, ...scene.steps] }
}
