import 'dotenv/config'
import {
  createAgentSession,
  defineTool,
  ModelRuntime,
  SessionManager,
  textResult,
  type AgentEvent,
} from './pi-lite.js'

// ─────────────────────────── 业务代码：两个工具 ───────────────────────────
// 这是 D2 那两个工具搬过来的版本。工具的业务逻辑一个字没变，
// 变的只是「怎么把它交给循环」—— 今天要练的就是这个「怎么交」。
//
// get_time 已经写好了，照着它做 calc。

const getTimeTool = defineTool<Record<string, never>>({
  name: 'get_time',
  label: '获取当前时间',
  // description 是写给模型看的：它靠这段话决定要不要调、什么时候调
  description: '获取服务器当前的日期与时间。当用户问“现在几点”“今天几号”这类问题时使用。',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute() {
    return textResult(`现在是 ${new Date().toLocaleString('zh-CN', { hour12: false })}`)
  },
})

const calcTool = defineTool<{ expression: string }>({
  name: 'calc',
  label: '四则运算', // 只给界面展示用，模型看不到
  // 练习 1：把说明书写清楚。
  // 下面这句 description 和 expression 的字段描述都太含糊了 —— 它们是**写给模型看的**，
  // 模型完全靠这两段话判断「该不该调这个工具、该往里填什么」。
  // 先原样跑一次 `MOCK=1 pnpm start`（做完练习 2 之后），你会看到假模型明确说
  // 「描述太含糊，判断不出该不该用它」——这就是含糊描述在真实系统里造成的后果。
  // TODO: 把 description 改成一句能让模型判断使用时机的话（说清楚它算什么、什么时候该用）；
  //       再把 expression 的 description 补上一个具体例子。
  description: '计算器',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: '表达式' },
    },
    required: ['expression'],
  },
  async execute(_toolCallId, params) {
    // 练习 4：把下面这段 try/catch 去掉，让 evaluate 的异常直接抛出去。
    // 现在这种写法是正文点名批判的反面做法：异常被吞掉、返回一句「计算失败」当**正常结果**，
    // 模型会以为工具跑成功了，于是拿着一句没有信息量的话继续往下答。
    // 正确做法是直接抛 —— 内核会把它转成一条带错误标记的工具结果回给模型，
    // 模型下一轮往往能自己改参数重试。
    // 验证方法：`MOCK=1 pnpm start --tool-error`，看日志里是「工具返回」还是「工具报错」。
    try {
      return textResult(`${params.expression} = ${evaluate(params.expression)}`)
    } catch {
      return textResult('计算失败')
    }
  },
})

/** 一个不用 eval 的四则运算求值器：非法字符直接抛错。不是本实验的重点，已经写好了。 */
function evaluate(expression: string): number {
  const tokens = expression.match(/\d+(?:\.\d+)?|[+\-*/()]/g) ?? []
  if (tokens.join('') !== expression.replace(/\s+/g, '')) {
    throw new Error(`表达式里有不认识的字符：${expression}`)
  }

  let position = 0
  const peek = (): string | undefined => tokens[position]

  const parseFactor = (): number => {
    const token = tokens[position++]
    if (token === undefined) throw new Error('表达式不完整')
    if (token === '(') {
      const value = parseExpression()
      if (tokens[position++] !== ')') throw new Error('括号没有闭合')
      return value
    }
    if (token === '-') return -parseFactor()
    const value = Number(token)
    if (Number.isNaN(value)) throw new Error(`这里应该是一个数字，却拿到 ${token}`)
    return value
  }

  const parseTerm = (): number => {
    let value = parseFactor()
    while (peek() === '*' || peek() === '/') {
      const operator = tokens[position++]
      const right = parseFactor()
      if (operator === '/' && right === 0) throw new Error('除数不能为 0')
      value = operator === '*' ? value * right : value / right
    }
    return value
  }

  function parseExpression(): number {
    let value = parseTerm()
    while (peek() === '+' || peek() === '-') {
      const operator = tokens[position++]
      value = operator === '+' ? value + parseTerm() : value - parseTerm()
    }
    return value
  }

  const result = parseExpression()
  if (position !== tokens.length) throw new Error(`表达式结尾有多余内容：${expression}`)
  return result
}

// ─────────────────────────── 四步：注册、开会话、订阅、发问 ───────────────────────────

async function main(): Promise<void> {
  const question = process.argv
    .slice(2)
    .filter((arg) => !arg.startsWith('--'))
    .join(' ')
  const prompt = question || '现在几点？再帮我算 12 加 30 再乘 2'

  const modelRuntime = await ModelRuntime.create()
  const model = (await modelRuntime.getAvailable())[0]
  if (!model) throw new Error('没有可用模型')

  const { session } = await createAgentSession({
    model,
    modelRuntime,
    // 练习 2：把 calcTool 也注册进来。
    // 现在只注册了一个工具，所以先原样跑一次 `MOCK=1 pnpm start`：
    // 你会看到模型说「我手上没有计算工具，所以那道算术没法算」——
    // **注册**这一步就是这么直接地决定了 Agent 的能力边界。
    // TODO: 在下面这个数组里加上 calcTool。
    customTools: [getTimeTool],
    sessionManager: SessionManager.inMemory(),
  })

  // 循环不归你管了，观察靠订阅。
  let turns = 0
  const unsubscribe = session.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case 'tool_execution_start':
        console.log(`  [调用工具] ${event.toolName} 参数=${JSON.stringify(event.args)}`)
        break
      case 'tool_execution_end':
        console.log(`  [工具${event.isError ? '报错' : '返回'}] ${event.text}`)
        break
      case 'message_update':
        process.stdout.write(event.delta)
        break
      // 练习 3：补上轮次事件，把 D2 那个 for 循环的每一次迭代显示出来。
      // turn_start / turn_end 就是一次迭代的开始与结束，agent_end 就是你 return 的那一刻。
      // TODO: 加三个 case ——
      //   'turn_start'：把 event.turn 存进上面的 turns，并打印「第 N 轮开始」；
      //   'turn_end'：打印「第 N 轮结束」以及 event.toolResults（本轮产生了几条工具结果）；
      //   'agent_end'：打印 event.stopReason 和一共跑了几轮。
      // 提示：做完之后跑一次，数一数这次对话到底跑了几轮 —— 答案应该是 2。
      default:
        break
    }
    void turns
  })

  console.log(`你> ${prompt}`)
  console.log('助教> （下面是事件流，文字部分就是模型的回答）')
  await session.prompt(prompt)

  unsubscribe()
  session.dispose()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
