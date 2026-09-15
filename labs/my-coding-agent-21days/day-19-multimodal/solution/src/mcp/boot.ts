/**
 * 启动时把 MCP 挂上。本天新增。
 *
 * 单独一个文件而不是塞进 repl.ts，理由还是行数：D14 的 repl.ts 已经 336 行，
 * 本课单文件上限 350。而且这段逻辑自检也要用，放在这里两边共用一份。
 *
 * 一条口径写在这儿最合适：**挂载失败绝不能拦住 mca 启动。** 用户是来改代码的，
 * 一个查工单的 server 连不上，最坏的后果应该是少两个工具。
 */
import type http from 'node:http'
import { McpMount } from './mount.js'
import { demoServers, mcpEnabled, usesLocalDemoServer } from './servers.js'
import { startTicketServer } from '../servers/tickets-http.js'

export interface Booted {
  mount: McpMount | null
  /** 顺手起起来的演示 server。用户自己指了地址时是 null */
  demo: http.Server | null
}

export async function bootMcp(log: (line: string) => void): Promise<Booted> {
  if (!mcpEnabled()) return { mount: null, demo: null }

  let demo: http.Server | null = null
  if (usesLocalDemoServer()) {
    // 端口被占着不是错误：多半是你自己在另一个终端起了同一个演示 server。
    // 那就直接连它，不要因为 EADDRINUSE 把 mca 拦在门外
    try {
      demo = await startTicketServer()
    } catch (error) {
      log(`[mcp] 演示用的 HTTP server 没起来（${String(error)}），将直接连已有的那个`)
    }
  }

  const mount = new McpMount({ log })
  const count = await mount.connect(demoServers())
  log(
    `[mcp] 一共挂上 ${count} 个远端工具${mount.down.size > 0 ? `，${mount.down.size} 个 server 掉线` : ''}`
  )
  return { mount, demo }
}

export async function shutdownMcp(booted: Booted): Promise<void> {
  await booted.mount?.close()
  booted.demo?.close()
}
