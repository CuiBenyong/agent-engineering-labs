/**
 * 今天的离线剧本。每天按当天要展示的现象重写，所以它不冻结。
 *
 * 起点是 D17：子 Agent 的那批剧本在 agents/mock-scenes.ts 里，
 * 这里只保留一个早退（pickAgentScene）把它们接进来。
 *
 * D18 加了三场，一场一个要证明的事：
 *
 *   HOOK_FLOW   模型凭记忆直接改文件 → **被 pre_tool 钩子拦下，工具根本没执行**，
 *               于是它先读再改；改完钩子自动跑了测试并把结果回灌，它就没再跑第二遍。
 *               这一场同时证明了否决与回灌。
 *   HOOK_FAIL   模型改错了（守卫写在了错的条件上）→ post_tool 那个阻断型钩子
 *               把这次调用判成失败并回灌测试输出 → 它自己改对。
 *               **注意它证明的不是「钩子撤销了那次写入」**，钩子撤销不了任何东西。
 *   BG_FLOW     一条要跑很久的命令被扔到后台，模型拿到的是受理回执。
 *
 * 三场都不需要 INJECT：今天要演的两条失败路径（被拦、检查没过）本来就是
 * 正常业务路径的一部分，不是故障注入。
 */
import type { MockScene, MockStep } from './providers/mock.js'
import { TRANSCRIPT_PREFIX } from './context/summarize.js'
import { pickAgentScene } from './agents/mock-scenes.js'
import {
  DRIFT_FLOW,
  EXPLAIN,
  FIND_FAILING,
  FIX_IT,
  MCP_FLOW,
  NEW_DIVIDE,
  OLD_DIVIDE,
  PLAN_FLOW,
  REFACTOR,
  SKILL_FLOW,
  summarizeTranscript,
} from './mock-scenes.js'

/** 改错了的那一版：守卫判的是 b 没传，而不是 b 为 0，所以测试还是红的 */
const WRONG_DIVIDE = `export function divide(a, b) {
  if (b === undefined) throw new Error('divide by zero')
  return a / b
}`

/** 凭记忆直接改 → 被 read-before-write 拦下 → 先读再改 → 钩子替它跑完了测试 */
const HOOK_FLOW: MockScene = {
  name: 'hook-flow',
  steps: [
    {
      text: '这个我见过，divide 少了除零保护。最快的办法是直接把它改掉。',
      toolCalls: [
        {
          id: 'call_hook_blind',
          name: 'edit_file',
          args: { path: 'src/calc.js', old_string: OLD_DIVIDE, new_string: NEW_DIVIDE },
        },
      ],
    },
    {
      text: '被拦下了，说要先读过才能改。那就先读。',
      toolCalls: [{ id: 'call_hook_read', name: 'read_file', args: { path: 'src/calc.js' } }],
    },
    {
      text: '原文确认过了，现在做精确替换。',
      toolCalls: [
        {
          id: 'call_hook_fix',
          name: 'edit_file',
          args: { path: 'src/calc.js', old_string: OLD_DIVIDE, new_string: NEW_DIVIDE },
        },
      ],
    },
    {
      text:
        '钩子已经替我跑过 node --test 了，四个用例全绿，我就不再跑一遍。' +
        '第一次那手被拦得有道理：我当时确实是在凭记忆改文件。',
    },
  ],
}

/** 改错 → 阻断型 post_tool 钩子把这次调用判成失败 → 自己改对 */
const HOOK_FAIL_FLOW: MockScene = {
  name: 'hook-fail-flow',
  steps: [
    {
      text: '先看一眼原文。',
      toolCalls: [{ id: 'call_fail_read', name: 'read_file', args: { path: 'src/calc.js' } }],
    },
    {
      text: '加一道守卫。',
      toolCalls: [
        {
          id: 'call_hook_wrong',
          name: 'edit_file',
          args: { path: 'src/calc.js', old_string: OLD_DIVIDE, new_string: WRONG_DIVIDE },
        },
      ],
    },
    {
      text: '钩子跑的测试还是红的：我判的是 b 没传，而用例传的是 0。改成判零。',
      toolCalls: [
        {
          id: 'call_hook_right',
          name: 'edit_file',
          args: { path: 'src/calc.js', old_string: WRONG_DIVIDE, new_string: NEW_DIVIDE },
        },
      ],
    },
    { text: '这次钩子报的是全绿。守卫判的是除数为 0，不是参数没传。' },
  ],
}

/** 长活扔后台，拿回执 */
const BG_FLOW: MockScene = {
  name: 'bg-flow',
  steps: [
    {
      text: '这条要跑一会儿，我放到后台，不占着这次对话。',
      toolCalls: [
        {
          id: 'call_bg_1',
          name: 'run_background',
          args: {
            command: 'node ../../src/tasks/worker.mjs',
            why: '完整流程要走三步，前台跑会一直占着对话',
          },
        },
      ],
    },
    {
      text:
        '已经受理了，任务号在上面。**它现在才刚开始跑，我还没有任何结果**——' +
        '完成时系统会通知你，你也可以随时用 /tasks 看进度。这期间我们可以接着聊别的。',
    },
  ],
}

/** 匹配顺序有讲究：当天的新剧本排在前面，否则会被前面几天那些更宽的规则吃掉 */
const SCENES: Array<{ match: RegExp; scene: MockScene }> = [
  // 今天这三条排在最前面，否则会被下面那几条更宽的规则吃掉
  { match: /后台|长命令|慢活/, scene: BG_FLOW },
  { match: /先随便改|改错|守卫/, scene: HOOK_FAIL_FLOW },
  { match: /钩子|凭记忆|最快的办法/, scene: HOOK_FLOW },
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

  // 来自 D17：子 Agent 的消息数组是一次性的，不需要垫步（见 agents/mock-scenes.ts）。
  // 这个早退必须在 turn 那一行之前——turn 是模块级状态，两个子 Agent 并发调用会打乱它
  const agentScene = pickAgentScene(userText)
  if (agentScene) return agentScene

  if (userText !== turn.text) turn = { text: userText, base: toolResults }
  const scene = SCENES.find((entry) => entry.match.test(userText))?.scene ?? EXPLAIN
  if (turn.base === 0) return scene
  const pad: MockStep[] = Array.from({ length: turn.base }, () => ({}))
  return { name: scene.name, steps: [...pad, ...scene.steps] }
}
