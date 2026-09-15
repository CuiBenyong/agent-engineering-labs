// MCP server：把 tools.ts 里那两个普通函数，按 MCP 的形状暴露出去。
// 这个文件是一个独立进程的入口——client 会把它当子进程 spawn 起来（stdio 传输）。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer as createHttpServer } from 'node:http'
import {
  QUERY_ORDER_DESCRIPTION,
  QUERY_ORDER_INPUT,
  TRACK_SHIPMENT_DESCRIPTION,
  TRACK_SHIPMENT_INPUT,
  queryOrder,
  trackShipment,
  type ToolOutput,
} from './tools'

/** MCP 的工具结果形状：content 是一个块数组，isError 标记这次调用失败了。 */
function toMcpResult(out: ToolOutput) {
  return { content: [{ type: 'text' as const, text: out.text }], isError: !out.ok }
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'shop-tools', version: '1.0.0' },
    // 声明本 server 提供哪些原语。MCP server 侧一共三种：tools / resources / prompts。
    // 今天只用 tools，另外两种在正文里讲，不在这个最小实现里展开。
    { capabilities: { tools: {} } }
  )

  server.registerTool(
    'query_order',
    { description: QUERY_ORDER_DESCRIPTION, inputSchema: QUERY_ORDER_INPUT },
    async ({ order_id }) => toMcpResult(queryOrder(order_id))
  )

  server.registerTool(
    'track_shipment',
    { description: TRACK_SHIPMENT_DESCRIPTION, inputSchema: TRACK_SHIPMENT_INPUT },
    async ({ order_id }) => toMcpResult(trackShipment(order_id))
  )

  return server
}

/** stdio 传输：stdout 是 JSON-RPC 的专用管道，任何一行多余的 print 都会把协议打断。 */
async function runStdio(): Promise<void> {
  const server = createMcpServer()
  await server.connect(new StdioServerTransport())
  // 日志一律走 stderr，这是 stdio server 最容易踩的坑
  console.error('[mcp-server] stdio 已连接，等待 client 的 initialize')
}

/** Streamable HTTP：远程传输，本课固定用端口 3023。无状态模式，一次请求一条连接。 */
async function runHttp(port: number): Promise<void> {
  const http = createHttpServer((req, res) => {
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end()
      return
    }
    // 无状态：每个请求现建一对 server + transport，跑完就丢，天然可以水平扩
    const server = createMcpServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    void server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch((err: unknown) => {
        console.error('[mcp-server] http 请求出错', err)
        if (!res.headersSent) res.writeHead(500).end()
      })
  })
  await new Promise<void>((resolve) => http.listen(port, '127.0.0.1', resolve))
  console.error(`[mcp-server] Streamable HTTP 已监听 http://127.0.0.1:${port}/mcp`)
}

async function main(): Promise<void> {
  if (process.env.MCP_TRANSPORT === 'http') {
    await runHttp(Number(process.env.MCP_PORT ?? 3023))
    return
  }
  await runStdio()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
