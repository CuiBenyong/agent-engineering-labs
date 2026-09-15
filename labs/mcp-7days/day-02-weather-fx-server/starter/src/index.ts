// D2 实验（starter）：一个含天气与汇率两个工具的 stdio MCP 服务端
//
//   MOCK=1 SELFTEST=1 pnpm start   进程起来后自己给自己发请求，逐项打印 ✅/❌ 后退出
//   MOCK=1 pnpm start              常驻，走 stdio，供 Inspector 或任何 MCP 客户端接入
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildServer } from './server.js'

if (process.env.SELFTEST === '1') {
  await import('./selftest.js')
} else {
  const server = buildServer()
  // stdio 传输：stdout 是协议通道，任何调试输出都必须走 stderr，否则客户端解析失败
  process.stderr.write('[weather-fx-server] 已启动，等待 stdin 上的 MCP 消息\n')
  await server.connect(new StdioServerTransport())
}
