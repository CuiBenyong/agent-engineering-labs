// D2 实验（starter）：手写 while 循环 Agent + 2 个工具
//
// 这份代码里没有任何框架：模型调用是一次裸 fetch，Agent 循环是一个 for，
// 工具是两个普通函数。脚手架已经写完，被挖空的是循环里最关键的那几行。
//
// 一共 5 个练习点，**按 1 到 5 的顺序做，每做完一个都跑一次 `MOCK=1 pnpm start`**：
// 你会看到症状一个接一个地变——从「只说了一句莫名其妙的话」，到「多步轨迹出来了但模型说它
// 没拿到天气」，再到「报错之后模型自己改对了」。5 个都做完，输出应该和 solution 完全一致。
import 'dotenv/config'

// ---------------------------------------------------------------------------
// 1. 类型：把 OpenAI / OpenRouter 那套 tool calling 的报文形状写成类型
// ---------------------------------------------------------------------------

interface ToolProperty {
  type: string
  description: string
}

interface ToolParameters {
  type: 'object'
  properties: Record<string, ToolProperty>
  required: string[]
}

/** 一个工具的「说明书」。模型只能看到这些字段，看不到你的源码。 */
interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: ToolParameters
  }
}

/** 模型发出的一次工具调用请求。注意 arguments 是 JSON 文本，不是对象。 */
interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface AssistantMessage {
  role: 'assistant'
  content: string | null
  tool_calls?: ToolCall[]
}

type Message =
  | { role: 'system' | 'user'; content: string }
  | AssistantMessage
  | { role: 'tool'; tool_call_id: string; content: string }

interface ModelChoice {
  /** 停止原因：'stop' 表示话说完了，'tool_calls' 表示它想调工具。循环的开关就是它。 */
  finish_reason: string
  message: AssistantMessage
}

interface RunResult {
  answer: string
  modelCalls: number
  toolCalls: number
  toolFailures: number
}

// ---------------------------------------------------------------------------
// 2. 工具的说明书（JSON Schema）
// ---------------------------------------------------------------------------

const TOOLS: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询某个城市今天的天气。city 用中文城市名，不要带「市」字。',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '中文城市名，例如 杭州' },
        },
        required: ['city'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      // 练习 1：把这个工具的说明书补完整。
      // 模型只能看到这几行字，看不到你下面写的 calculate 函数——描述含糊，它就填错参数。
      // TODO: 把 description 写清楚（说明它只接受数字和 + - * / 与括号、参数里不要带单位）。
      // TODO: 在 properties 里补上 expression 参数（type 与 description），并把它写进 required。
      // 现在这样跑，假模型不知道该传什么，只能给一个空参数，你会看到它反复失败直到撞上步数上限。
      description: '做计算。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
]

// ---------------------------------------------------------------------------
// 3. 工具的实现
// ---------------------------------------------------------------------------

// 天气用一张内置表，真接气象 API 不是今天的重点——今天只有「调模型」一个网络出口
const WEATHER: Record<string, string> = {
  杭州: '晴，24℃',
  北京: '多云，19℃',
  上海: '小雨，21℃',
  广州: '阵雨，29℃',
}

function queryWeather(city: string): string {
  const forecast = WEATHER[city]
  if (!forecast) {
    // 错误文案里带上「正确的样子」，模型下一轮才知道该怎么改
    throw new Error(`没有 ${city} 的天气数据，目前支持：${Object.keys(WEATHER).join('、')}`)
  }
  return `${city}：${forecast}`
}

/** 一个极小的四则运算解释器。故意不用 eval：模型给的字符串等同于用户输入，不可信。 */
function calculate(expression: string): string {
  const compact = expression.replace(/\s+/g, '')
  if (compact === '') {
    throw new Error('表达式为空，expression 里要给一个像 24 - 19 这样的算式')
  }

  const tokens = compact.match(/\d+(?:\.\d+)?|[+\-*/()]/g) ?? []
  // 把认出来的记号拼回去，和原串不一致就说明中间混进了不认识的字符（比如单位 ℃）
  if (tokens.join('') !== compact) {
    throw new Error(
      `表达式里有无法识别的字符（只支持数字、+ - * / 和括号，不要带单位）：${expression}`
    )
  }

  let pos = 0
  const peek = (): string | undefined => tokens[pos]

  function parseFactor(): number {
    const token = peek()
    if (token === '(') {
      pos++
      const value = parseExpr()
      if (peek() !== ')') throw new Error('括号不匹配')
      pos++
      return value
    }
    if (token === '-') {
      pos++
      return -parseFactor()
    }
    if (token === undefined) throw new Error('表达式不完整')
    if (!/^\d/.test(token)) throw new Error(`这里应该是一个数字，实际读到的是 ${token}`)
    pos++
    return Number(token)
  }

  function parseTerm(): number {
    let value = parseFactor()
    while (peek() === '*' || peek() === '/') {
      const op = tokens[pos]
      pos++
      const right = parseFactor()
      if (op === '/' && right === 0) throw new Error('除数不能为 0')
      value = op === '*' ? value * right : value / right
    }
    return value
  }

  function parseExpr(): number {
    let value = parseTerm()
    while (peek() === '+' || peek() === '-') {
      const op = tokens[pos]
      pos++
      const right = parseTerm()
      value = op === '+' ? value + right : value - right
    }
    return value
  }

  const value = parseExpr()
  if (pos !== tokens.length) throw new Error(`表达式在 ${String(peek())} 处解析不下去了`)
  return `计算结果：${value}`
}

/**
 * 执行一次工具调用，永远返回字符串——**这个函数故意不抛异常**。
 * 在 Agent 里，工具报错通常只是模型参数填错了，把错误当成一条正常的观察结果回传，
 * 它下一轮往往就自己改对了；抛出去只会让用户看到一个 500。
 */
function executeTool(call: ToolCall): string {
  const name = call.function.name
  try {
    // arguments 是一段 JSON 文本而不是对象，模型偶尔还会吐出不合法的 JSON，
    // 所以这一行解析本身也必须被 try 住
    const args = JSON.parse(call.function.arguments) as Record<string, unknown>
    switch (name) {
      case 'get_weather':
        return queryWeather(String(args.city ?? ''))
      case 'calculate':
        return calculate(String(args.expression ?? ''))
      default:
        return `工具执行失败：没有名为 ${name} 的工具，请从工具列表里重新选一个。`
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[log] ${name} 执行失败：${message}`)
    // 练习 4：工具报错了，要不要让模型看见？在 Agent 里答案是「要」——
    // 把错误整理成一句模型看得懂的话回传，它下一轮往往就自己改对了。
    // 但只回你自己写的那句话，绝不要回 err.stack：堆栈里有文件路径和内部服务名，
    // 它会原封不动进入下一次请求，还可能被模型复述给用户。
    // TODO: 把下面的占位文本换成 `工具执行失败：${message}`。
    // 不改的话，模型看不出自己哪里错了，会一直用带单位的表达式重试，直到撞上步数上限。
    return '（工具报错了，但错误信息没有回传给模型）'
  }
}

// ---------------------------------------------------------------------------
// 4. 模型调用：MOCK=1 时换成一个按剧本走的假模型
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = '你是一个会用工具的助教。需要天气或计算时必须调用工具，不要凭空猜数字。'

let mockCallSeq = 0

function mockToolCall(name: string, args: Record<string, string>): ToolCall {
  mockCallSeq++
  return {
    id: `call_mock_${mockCallSeq}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}

/**
 * 离线假模型。它是**演示级**的：靠数轮次和读观察结果来决定下一步，
 * 真实模型靠的是语义理解，别把这段当生产做法。
 *
 * 但它有两件事是「真」的，正因为这两件事，你的循环写没写对离线就能验：
 * 1. 它真的会去读你回填的那些 role 为 tool 的消息（读不到就会说自己没拿到数据）。
 * 2. 它第一次调计算器会故意把单位也写进表达式——只有当你把工具的报错回传给它，
 *    它才会在下一轮改成纯数字。这就是「错误回传让模型自纠错」的现场。
 */
function mockModel(messages: Message[], tools: ToolSchema[]): ModelChoice {
  const text = (content: string): ModelChoice => ({
    finish_reason: 'stop',
    message: { role: 'assistant', content },
  })
  const act = (calls: ToolCall[]): ModelChoice => ({
    finish_reason: 'tool_calls',
    message: { role: 'assistant', content: null, tool_calls: calls },
  })

  const userInput = messages.find((m) => m.role === 'user')?.content ?? ''
  const rounds = messages.filter((m) => m.role === 'assistant' && m.tool_calls?.length).length
  const observations = messages.filter((m) => m.role === 'tool').map((m) => m.content)
  const lastObservation = observations[observations.length - 1]

  // 演示用：这个问法会让假模型永远请求同一个工具，用来验证步数上限真的拦得住
  if (userInput.includes('死循环') || userInput.includes('loop-forever')) {
    return act([mockToolCall('get_weather', { city: '杭州' })])
  }

  // 第一轮：一次请求两个城市的天气（这就是并行工具调用，你要回两条 tool 消息）
  if (rounds === 0) {
    return act([
      mockToolCall('get_weather', { city: '杭州' }),
      mockToolCall('get_weather', { city: '北京' }),
    ])
  }

  const readings = observations
    .map((o) => /^(.+?)：.*?(-?\d+(?:\.\d+)?)℃/.exec(o))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ city: m[1], temp: Number(m[2]) }))

  if (readings.length < 2) {
    return text(
      '（离线模拟）我没拿到两地的气温，没法比较——检查一下工具结果是不是真的回填进 messages 了。'
    )
  }

  const diffMatch = observations
    .map((o) => /^计算结果：(-?\d+(?:\.\d+)?)$/.exec(o))
    .find((m) => m !== null)

  if (!diffMatch) {
    const calculateSchema = tools.find((t) => t.function.name === 'calculate')
    if (!calculateSchema?.function.parameters.properties.expression) {
      // 工具说明书里没有 expression 这个参数，模型不知道该传什么，只能空着手上
      return act([mockToolCall('calculate', {})])
    }
    const [first, second] = readings
    const failed = lastObservation?.startsWith('工具执行失败') ?? false
    // 没看到报错就照旧带单位（模型很爱犯这个错），看到报错才改成纯数字
    const expression = failed
      ? `${first.temp} - ${second.temp}`
      : `${first.temp}℃ - ${second.temp}℃`
    return act([mockToolCall('calculate', { expression })])
  }

  const [first, second] = readings
  return text(
    `（离线模拟）${first.city}今天 ${first.temp}℃，${second.city} ${second.temp}℃，` +
      `${first.city}比${second.city}高 ${diffMatch[1]}℃。`
  )
}

async function callModel(messages: Message[]): Promise<ModelChoice> {
  if (process.env.MOCK === '1') {
    await new Promise((resolve) => setTimeout(resolve, 120)) // 装一点网络延迟，轨迹更像真的
    return mockModel(messages, TOOLS)
  }

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('缺少 OPENROUTER_API_KEY（或用 MOCK=1 离线运行）')

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    // tools 每一轮都要重新带上：模型不记得你上一轮给过它什么工具
    body: JSON.stringify({
      model: process.env.MODEL ?? 'openai/gpt-4o-mini',
      messages,
      tools: TOOLS,
    }),
  })
  if (!res.ok) throw new Error(`模型调用失败：HTTP ${res.status} ${await res.text()}`)

  const json = (await res.json()) as { choices: ModelChoice[] }
  return json.choices[0]
}

// ---------------------------------------------------------------------------
// 5. Agent 循环本体
// ---------------------------------------------------------------------------

// 没有这个上限，它就是一个会自己花钱的 while (true)
const MAX_STEPS = 6

async function runAgent(userInput: string): Promise<RunResult> {
  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userInput },
  ]
  const result: RunResult = { answer: '', modelCalls: 0, toolCalls: 0, toolFailures: 0 }

  for (let step = 1; step <= MAX_STEPS; step++) {
    const choice = await callModel(messages)
    result.modelCalls++
    // 模型这一轮说的话原样进历史（思考）。漏了这条，下一轮的 tool 消息就会变成无主消息，服务端直接 400
    messages.push(choice.message)

    const toolCalls = choice.message.tool_calls ?? []

    // 练习 2：整个 Agent 循环的开关就在这里。
    // 读停止原因（finish_reason）：不是 'tool_calls' 就说明模型把话说完了，把 content 交给用户；
    // 是 'tool_calls' 就往下走，去执行它请求的那些工具。
    // TODO: 把下面这个写死的 true 换成真正的判断：
    //       choice.finish_reason !== 'tool_calls' || toolCalls.length === 0
    // 现在这样等于「只调一次模型就收工」，你会看到它一句有用的话都没说就结束了。
    const modelHasFinished: boolean = true

    if (modelHasFinished) {
      console.log(`[第 ${step} 步] 停止原因 = ${choice.finish_reason}，循环结束`)
      result.answer = choice.message.content ?? '（模型这一轮没有说话——它其实是在请求调用工具）'
      return result
    }

    console.log(
      `[第 ${step} 步] 停止原因 = ${choice.finish_reason}，模型请求了 ${toolCalls.length} 个工具`
    )
    for (const call of toolCalls) {
      console.log(`  → ${call.function.name} ${call.function.arguments}`)
      const output = executeTool(call) // 行动
      result.toolCalls++
      if (output.startsWith('工具执行失败')) result.toolFailures++
      console.log(`  ← ${output}`)
      // 练习 3：把工具结果变成一条消息塞回 messages，模型下一轮才看得见它（这就是「观察」）。
      // tool_call_id 这一行已经给你了：它必须等于上面那个 call.id，对不上服务端直接返回 400。
      // TODO: 把 content 的占位文本换成真正的 output。
      // 不改的话，模型会告诉你它没拿到天气数据——因为它看到的确实只有这句占位符。
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: '（工具结果还没有回填）',
      })
    }
  }

  // 练习 5：循环撞上 MAX_STEPS 了，要给用户一句交代。
  // 注意 MAX_STEPS 这个常量已经写好了——它是安全护栏，不能留空让你练手，
  // 否则 starter 一跑就是个会自己花钱的死循环。你要补的是「撞上之后怎么办」。
  // TODO: 换成一句人话，说明没能在有限步数内完成，并给用户一个下一步建议。
  // 跑 `MOCK=1 pnpm start 演示死循环` 就能看到现在这个空回复有多让人困惑。
  result.answer = ''
  return result
}

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(' ') || '杭州今天比北京高几度？'
  console.log(`你> ${question}`)
  const result = await runAgent(question)
  console.log(`助教> ${result.answer}`)
  console.log(
    `[统计] ${result.modelCalls} 次模型调用，${result.toolCalls} 次工具调用，其中 ${result.toolFailures} 次报错`
  )
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
