// D1 演示用 MCP 服务端：按 2026-07-28 规范手写，零依赖，只为了让你看清线上传的是什么。
// 用法：不要直接跑它，跑 `node demo-client.mjs`，客户端会把它当子进程拉起来。
// 许可：MIT
import readline from 'node:readline'

const PROTOCOL_VERSION = '2026-07-28'
const SERVER_INFO = { name: 'demo-weather-server', version: '0.1.0' }

const TOOLS = [
  {
    name: 'get_weather',
    title: '天气查询',
    description: '查询某个城市当前的天气。city 传中文或英文城市名均可，例如「上海」或「Seattle」。',
    inputSchema: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市名' } },
      required: ['city'],
    },
    outputSchema: {
      type: 'object',
      properties: { celsius: { type: 'number' }, conditions: { type: 'string' } },
      required: ['celsius', 'conditions'],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
]

// 离线假数据：这个 lab 不联网，重点是报文而不是天气准不准
const FAKE = {
  上海: { celsius: 24, conditions: '多云' },
  Seattle: { celsius: 15, conditions: '小雨' },
}

function ok(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      resultType: 'complete',
      ...result,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    },
  }
}

function fail(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function handle(msg) {
  const meta = msg.params?._meta ?? {}
  const version = meta['io.modelcontextprotocol/protocolVersion']

  // 2026-07-28：协议版本是每条请求的必填项，缺了就是 -32602
  if (!version) return fail(msg.id, -32602, '缺少 io.modelcontextprotocol/protocolVersion')
  if (version !== PROTOCOL_VERSION) {
    return fail(msg.id, -32022, `不支持的协议版本 ${version}，本服务端支持 ${PROTOCOL_VERSION}`)
  }
  // 客户端能力同样必填，允许是空对象，但不能不写
  if (meta['io.modelcontextprotocol/clientCapabilities'] === undefined) {
    return fail(msg.id, -32602, '缺少 io.modelcontextprotocol/clientCapabilities')
  }

  switch (msg.method) {
    case 'server/discover':
      return ok(msg.id, {
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {} },
        instructions: '一个只有天气查询的演示服务端。',
        ttlMs: 3600000,
        cacheScope: 'public',
      })

    case 'tools/list':
      return ok(msg.id, { tools: TOOLS, ttlMs: 300000, cacheScope: 'public' })

    case 'tools/call': {
      if (msg.params?.name !== 'get_weather') {
        // 协议错误：工具名不存在，模型改参数也没用
        return fail(msg.id, -32602, `Unknown tool: ${msg.params?.name}`)
      }
      const city = msg.params?.arguments?.city
      const hit = FAKE[city]
      if (!hit) {
        // 工具执行错误：把可行的城市告诉模型，让它自己改
        return ok(msg.id, {
          content: [{ type: 'text', text: `没有 ${city} 的数据。可用城市：上海、Seattle。` }],
          isError: true,
        })
      }
      return ok(msg.id, {
        content: [{ type: 'text', text: JSON.stringify(hit) }],
        structuredContent: hit,
        isError: false,
      })
    }

    default:
      return fail(msg.id, -32601, `Method not found: ${msg.method}`)
  }
}

// stdio 传输：一行一条 JSON，stdout 里不许出现任何不是 MCP 消息的东西
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    process.stderr.write(`[server] 收到无法解析的行：${line}\n`) // 日志只能走 stderr
    return
  }
  if (msg.id === undefined) return // 通知不需要回复
  process.stdout.write(JSON.stringify(handle(msg)) + '\n')
})
rl.on('close', () => process.exit(0))
