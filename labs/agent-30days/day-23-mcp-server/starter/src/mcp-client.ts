// MCP client：把 server 提供的能力接进宿主。
// 注意这里没有一行「假装连上了」的代码——MCP server 不是网络出口，它是本地子进程，
// 所以 MOCK=1 下它也真的会被 spawn 起来、真的走一遍 initialize / tools/list / tools/call。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  flattenToolResult,
  toFunctionTool,
  type FunctionTool,
  type McpToolDescriptor,
  type ToolOutcome,
} from './bridge'

export interface McpConnection {
  /** server 自报的身份，排障时第一眼要看的东西 */
  serverInfo: { name: string; version: string }
  /** server 声明支持的原语（tools / resources / prompts …） */
  capabilities: string[]
  /** tools/list 的原始结果 */
  mcpTools: McpToolDescriptor[]
  /** 已经翻译成 function calling 形状、可以直接塞进模型请求的工具 */
  functionTools: FunctionTool[]
  callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome>
  close(): Promise<void>
}

const here = path.dirname(fileURLToPath(import.meta.url))

/** 子进程怎么起：本课用仓库里的 tsx 直接跑 TypeScript，生产里通常是 node dist/server.js 或一个 npx 包名。 */
function serverParams() {
  const bin = process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
  return {
    command: path.resolve(here, '..', 'node_modules', '.bin', bin),
    args: [path.join(here, 'mcp-server.ts')],
    // server 的日志走 stderr，直接透传到当前终端，方便看它到底起来了没有
    stderr: 'inherit' as const,
  }
}

export async function connectMcp(): Promise<McpConnection> {
  const client = new Client(
    { name: 'shop-agent', version: '1.0.0' },
    // client 侧也能声明自己的能力（sampling / roots / elicitation），今天一个都不用
    { capabilities: {} }
  )
  // connect 里包含 initialize 握手：双方交换协议版本与各自的能力声明
  await client.connect(new StdioClientTransport(serverParams()))

  const info = client.getServerVersion()
  const caps = client.getServerCapabilities() ?? {}
  const listed = await client.listTools()
  const mcpTools = listed.tools as McpToolDescriptor[]

  return {
    serverInfo: { name: info?.name ?? '未知', version: info?.version ?? '未知' },
    capabilities: Object.keys(caps),
    mcpTools,
    functionTools: mcpTools.map(toFunctionTool),
    async callTool(name, args) {
      // 练习 3：真的发一次 MCP tools/call，并把结果交给 flattenToolResult 压成文本。
      // 提示：MCP 把失败分成两类，你要把它们合并成同一种「给模型看的纠错说明」——
      //       业务失败（订单不存在）走结果里的 isError 字段，这次 RPC 其实是成功的；
      //       协议失败（参数不合法、工具名不存在）走 JSON-RPC error，会以抛异常的形式出现。
      //       两类都要变成 ok: false 加一段能读懂的文字，不要让异常冒泡把整轮对话打断。
      void client
      void flattenToolResult
      return {
        ok: false,
        text: `（练习 3：${name} 还没真的走 MCP，参数 ${JSON.stringify(args)} 没送出去）`,
      }
    },
    async close() {
      await client.close()
    },
  }
}
