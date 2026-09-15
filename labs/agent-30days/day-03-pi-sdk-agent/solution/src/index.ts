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
// 这是 D2 那两个工具搬过来的版本。对照一下你会发现：
// 工具的业务逻辑一个字没变，变的只是「怎么把它交给循环」。

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
  label: '四则运算',
  description:
    '计算一个只含数字、加减乘除与圆括号的四则运算表达式，返回计算结果。需要精确算术时使用，不要自己心算。',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: '要计算的表达式，例如 (12 + 30) * 2' },
    },
    required: ['expression'],
  },
  async execute(_toolCallId, params) {
    // 失败就抛：内核会把异常转成一条带错误标记的工具结果回给模型，
    // 模型下一轮往往能自己改参数重试。千万别在这里把异常吞掉返回“操作失败”，
    // 那样模型会以为工具跑成功了。
    return textResult(`${params.expression} = ${evaluate(params.expression)}`)
  },
})

/** 一个不用 eval 的四则运算求值器：非法字符直接抛错。 */
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
    customTools: [getTimeTool, calcTool],
    sessionManager: SessionManager.inMemory(),
  })

  // 循环不归你管了，观察靠订阅。turn_start / turn_end 就是 D2 那个 for 循环的一次迭代
  let turns = 0
  const unsubscribe = session.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case 'turn_start':
        turns = event.turn
        console.log(`\n[第 ${event.turn} 轮开始]`)
        break
      case 'tool_execution_start':
        console.log(`  [调用工具] ${event.toolName} 参数=${JSON.stringify(event.args)}`)
        break
      case 'tool_execution_end':
        console.log(`  [工具${event.isError ? '报错' : '返回'}] ${event.text}`)
        break
      case 'message_update':
        process.stdout.write(event.delta)
        break
      case 'turn_end':
        console.log(`\n[第 ${event.turn} 轮结束] 本轮产生 ${event.toolResults} 条工具结果`)
        break
      case 'agent_end':
        console.log(`[循环结束] stopReason=${event.stopReason}，一共跑了 ${turns} 轮`)
        break
      default:
        break
    }
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
