/**
 * 今天的离线剧本。每天按当天要展示的现象重写，所以它不冻结。
 *
 * D11 要展示三件事，各一个场景：
 *
 *   1. **自动沉淀**：模型自己判断「这条以后还用得上」，调 remember 记一条，
 *      并主动给出关键词与一个可核对的锚点
 *   2. **跨会话召回**：换一条全新的会话（历史是空的），问一个相关的问题，
 *      那条事实自己回到上下文里，模型按它给的做法干活
 *   3. **敏感内容被拦**：模型想把一个 key 记进记忆，被拒绝并读到理由，
 *      于是改成记「这个项目需要哪个环境变量」
 *
 * 一句必须说清的话：**离线模式下「模型说了什么」是剧本写的。**
 * 所以第二个场景里真正被验证的不是「它答得对」，而是**那条事实进了这一轮的请求**——
 * 而这正是召回的定义。答得对不对是真实模式的事，也是它该负的责。
 * 自检里第二个场景的断言就落在「槽位里有没有那条事实」上，不落在台词上。
 */
import type { MockScene, MockStep } from './providers/mock.js'

const TEST_CMD = 'node --test test/calc.test.js'

/** 这条事实的分工正好是今天的例子：它读代码读不出来（package.json 里那行只是一个命令） */
const TEST_FACT =
  '这个仓库的测试只能用 node --test 跑，脚本里那条是给 CI 用的，本地直接跑会少载一个用例'

/**
 * 一个明显是假的 key，只用来触发拦截规则。
 * 注意它在剧本里出现过，但**它不会出现在任何一条记忆文件、任何一行终端输出里**——
 * 拦截话术里一个字的原文都没有，这一条是今天的硬要求。
 */
const FAKE_KEY = 'sk-EXAMPLEexample1234567890abcd'

/** 场景一：自动沉淀。给关键词、给路径、给锚点，三样都给才叫「记得住也找得回」 */
const SEDIMENT: MockScene = {
  name: 'sediment',
  steps: [
    {
      text: '这条以后还用得上，我记一下。',
      toolCalls: [
        {
          id: 'call_remember_1',
          name: 'remember',
          args: {
            text: TEST_FACT,
            keys: ['测试', '验证', 'node', '--test'],
            paths: ['package.json', 'test'],
            // 锚点：将来 package.json 里这行没了，这条记忆就自己举手要核对
            anchor: { path: 'package.json', contains: 'node --test' },
          },
        },
      ],
    },
    { text: '记好了。下次问到测试怎么跑，这条会自己回到上下文里。' },
  ],
}

/**
 * 场景二：跨会话召回。这一轮的历史是空的，模型「知道」这件事的唯一途径
 * 就是槽位里那条被检索出来的记忆。
 */
const RECALL: MockScene = {
  name: 'recall',
  steps: [
    {
      text: '记忆里写着这个仓库要用内置的测试运行器，我按那个跑。',
      toolCalls: [{ id: 'call_test_1', name: 'run_command', args: { command: TEST_CMD } }],
    },
    { text: '四个用例里有一个是红的：divide by zero。' },
  ],
}

/**
 * 场景三：密钥被拦，模型改记变量名。
 *
 * 第二步是今天最想让读者看到的一幕：**拒绝的理由里带了「该往哪儿放」，
 * 于是它下一轮自己改对了。** 这和第三天的坏参数、第五天的被拒绝、第六天的打转打断
 * 走的是同一条通路——失败的工具结果就是它的下一步说明书。
 */
const SECRET: MockScene = {
  name: 'secret',
  steps: [
    {
      text: '好，我把这个 key 记进长期记忆。',
      toolCalls: [
        {
          id: 'call_remember_secret',
          name: 'remember',
          args: { text: `这个项目的网关 key 是 ${FAKE_KEY}`, keys: ['key', '网关'] },
        },
      ],
    },
    {
      text: '你说得对，密钥不该进记忆。我改成记住它从哪儿读。',
      toolCalls: [
        {
          id: 'call_remember_envvar',
          name: 'remember',
          args: {
            text: '这个项目的网关凭据从环境变量 LLM_API_KEY 读，不要写死在任何文件里',
            keys: ['key', '凭据', '环境变量', '网关'],
            paths: ['.env.example'],
          },
        },
      ],
    },
    { text: '记的是变量名，密钥本身一个字都没有落盘。' },
  ],
}

const SCENES: Array<{ match: RegExp; scene: MockScene }> = [
  { match: /密钥|凭据|我的 key|把这个 key/, scene: SECRET },
  { match: /验证|怎么跑|跑一下|测试怎么/, scene: RECALL },
  { match: /记一下|记住|以后都|别用|不要用/, scene: SEDIMENT },
]

let turn = { text: '', base: 0 }

/**
 * 离线引擎选步骤的依据是「整段历史里的工具结果条数」，多轮会话里它和「这一轮的第几步」
 * 不相等。所以记下这一轮开始时的条数，在剧本前面垫上同样多的空步骤。
 */
export function pickScene(userText: string, toolResults: number): MockScene {
  if (userText !== turn.text) turn = { text: userText, base: toolResults }
  const scene = SCENES.find((entry) => entry.match.test(userText))?.scene ?? SEDIMENT
  if (turn.base === 0) return scene
  const pad: MockStep[] = Array.from({ length: turn.base }, () => ({}))
  return { name: scene.name, steps: [...pad, ...scene.steps] }
}

export { FAKE_KEY, TEST_FACT }
