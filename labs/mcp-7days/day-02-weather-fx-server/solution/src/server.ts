import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { fetchRate, fetchWeather, KNOWN_CITIES, KNOWN_CURRENCIES } from './data.js'

/**
 * 注册一个工具需要四件东西：名字、给模型看的描述、输入 schema、执行体。
 * 输出 schema 与注解是可选的，但生产里都该写——理由见正文「输出 schema」与「工具注解」两节。
 */
export function buildServer(): McpServer {
  const server = new McpServer({ name: 'weather-fx-server', version: '0.1.0' })

  server.registerTool(
    'get_weather',
    {
      title: '天气查询',
      // 描述是给模型看的，不是给同事看的：说清什么时候该用、参数长什么样、给一个例子
      description:
        '查询某个城市当前的天气，返回摄氏温度与天气状况。city 传城市名，中文或英文均可，例如「上海」或「Seattle」。只有当用户明确问到天气、气温、要不要带伞时才调用它。',
      inputSchema: {
        city: z.string().min(1).describe('城市名，中文或英文，例如「上海」或「Seattle」'),
      },
      // 有了输出 schema，下游代码就不用去解析自然语言了
      outputSchema: {
        celsius: z.number().describe('当前气温，摄氏度'),
        conditions: z.string().describe('天气状况的中文描述，例如「多云」'),
        updatedAt: z.string().describe('数据更新时间，ISO 8601'),
      },
      annotations: {
        readOnlyHint: true, // 只读：不会改变任何外部状态
        idempotentHint: true, // 幂等：同样的参数连调两次，效果和调一次一样
        openWorldHint: true, // 开放世界：查的是外部真实世界，结果会随时间变
      },
    },
    async ({ city }) => {
      const hit = await fetchWeather(city)
      if (!hit) {
        // 工具执行错误：模型换个城市名就可能成功，所以要把可选值告诉它
        return {
          content: [
            {
              type: 'text',
              text: `没有「${city}」的天气数据。可用城市：${KNOWN_CITIES.join('、')}。`,
            },
          ],
          isError: true,
        }
      }
      // content 给模型看，structuredContent 给代码用，两个都给才兼容老客户端
      return {
        content: [{ type: 'text', text: JSON.stringify(hit) }],
        structuredContent: { ...hit },
      }
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
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ amount, from, to }) => {
      const src = from.toUpperCase()
      const dst = to.toUpperCase()

      // 业务校验失败同样是执行错误，不是协议错误：模型改个参数就可能成功
      if (!(amount > 0)) {
        return {
          content: [{ type: 'text', text: `amount 必须大于 0，收到的是 ${amount}。` }],
          isError: true,
        }
      }

      const [srcRate, dstRate] = await Promise.all([fetchRate(src), fetchRate(dst)])
      const missing = [srcRate === null ? src : null, dstRate === null ? dst : null].filter(
        (x): x is string => x !== null
      )
      if (missing.length > 0) {
        return {
          content: [
            {
              type: 'text',
              text: `不支持的货币代码：${missing.join('、')}。可用代码：${KNOWN_CURRENCIES.join('、')}。`,
            },
          ],
          isError: true,
        }
      }

      // 两个都以人民币为基准，所以跨币种汇率就是两者相除
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
