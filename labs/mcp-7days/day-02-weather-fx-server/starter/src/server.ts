import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { fetchRate, fetchWeather, KNOWN_CITIES, KNOWN_CURRENCIES } from './data.js'

/**
 * 注册一个工具需要四件东西：名字、给模型看的描述、输入 schema、执行体。
 * 输出 schema 与注解是可选的，但生产里都该写。
 *
 * 这里有 5 个练习点，跑 `MOCK=1 SELFTEST=1 pnpm start` 能看到对应的 ❌。
 * 每做完一个，就有一项从 ❌ 变成 ✅。
 */
export function buildServer(): McpServer {
  const server = new McpServer({ name: 'weather-fx-server', version: '0.1.0' })

  server.registerTool(
    'get_weather',
    {
      title: '天气查询',
      // 练习 1：这句描述是给模型看的，现在这样写模型根本不知道什么时候该调它。
      // 改写成：这个工具做什么、参数长什么样（给一个例子）、什么情况下才该用它。
      // 提示：描述里写「见 wiki」「详见文档」是没用的，模型看不到你的 wiki。
      description: '查天气',
      inputSchema: {
        city: z.string().min(1).describe('城市名，中文或英文，例如「上海」或「Seattle」'),
      },
      // 练习 2：补上输出 schema，并在下面的执行体里返回 structuredContent。
      // 没有它，下游代码只能去解析自然语言；自测第 1 项和第 3 项都在等这一步。
      // 提示：三个字段——celsius（number）、conditions（string）、updatedAt（string）。

      // 练习 5：补上工具注解。想清楚这个工具是不是只读、是不是幂等、
      // 查的是不是外部真实世界，再决定三个 Hint 各填什么。
      // 提示：字段名是 readOnlyHint / destructiveHint / idempotentHint / openWorldHint。
    },
    async ({ city }) => {
      const hit = await fetchWeather(city)
      if (!hit) {
        // 练习 3：现在这里直接抛异常。SDK 会把它兜成一条 isError 结果，
        // 但模型拿到的文案是一句干巴巴的报错，它不知道该换成哪个城市重试。
        // 改成主动返回 isError，并把 KNOWN_CITIES 列进文案里。
        void KNOWN_CITIES
        throw new Error('查不到')
      }
      // 练习 2 的后半：这里现在只回了 content，没有 structuredContent。
      return { content: [{ type: 'text', text: JSON.stringify(hit) }] }
    }
  )

  server.registerTool(
    'convert_currency',
    {
      title: '汇率换算',
      description:
        '把一笔金额从一种货币换算成另一种货币，返回换算结果与所用汇率。amount 是正数金额，from 与 to 是三字母货币代码，例如 USD、CNY、EUR、JPY、SGD。',
      inputSchema: {
        amount: z.number().describe('待换算的金额，必须大于 0'),
        from: z.string().length(3).describe('源货币的三字母代码，例如 USD'),
        to: z.string().length(3).describe('目标货币的三字母代码，例如 CNY'),
      },
      outputSchema: {
        converted: z.number().describe('换算后的金额，保留两位小数'),
        rate: z.number().describe('从源货币到目标货币的汇率'),
        from: z.string(),
        to: z.string(),
      },
      // 练习 5 的后半：这个工具的注解也要补。
    },
    async ({ amount, from, to }) => {
      const src = from.toUpperCase()
      const dst = to.toUpperCase()

      // 练习 4：补上业务校验。amount 必须大于 0，两个币种都必须在 KNOWN_CURRENCIES 里。
      // 校验失败要返回 isError 的执行错误（模型改个参数就可能成功），不要抛异常。
      void KNOWN_CURRENCIES

      const [srcRate, dstRate] = await Promise.all([fetchRate(src), fetchRate(dst)])

      // 没有校验，未知币种在这里会算出 NaN，然后一路静默地传给模型——
      // 这就是「不做参数校验」在生产里真正的样子。
      const rate = (srcRate as number) / (dstRate as number)
      const converted = Math.round(amount * rate * 100) / 100
      const payload = { converted, rate: Math.round(rate * 1e6) / 1e6, from: src, to: dst }
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload,
      }
    }
  )

  return server
}
