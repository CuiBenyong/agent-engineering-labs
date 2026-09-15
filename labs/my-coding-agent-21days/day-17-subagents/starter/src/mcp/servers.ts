/**
 * 挂哪几个 server。本天新增。
 *
 * 配置只有一个来源：环境变量（配置文件的分层是 D21 的题目）。两个变量：
 *
 *   MCP         设成 off 就完全不挂 MCP，mca 退回到只有本地工具的样子
 *   MCP_TICKETS_URL  工单系统那个 HTTP server 的地址。不填就用本地演示 server，
 *                    填一个连不上的地址就能看到**失败隔离**：笔记库照常可用
 *
 * 别名（notes / tickets）由**我们这边**定，不是 server 自报的名字——
 * 规范明确说服务端的 serverInfo.name 不保证跨 server 唯一，不该拿它消歧。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServerSpec } from './mount.js'
import { TICKETS_PORT } from '../servers/tickets-http.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/** 演示用 stdio server 的绝对路径。它是一个独立的 node 程序，跟 mca 不共享任何代码 */
export const NOTES_SERVER = path.join(here, '../servers/notes-stdio.mjs')

export const DEFAULT_TICKETS_URL = `http://127.0.0.1:${TICKETS_PORT}/mcp`

export function ticketsUrl(): string {
  return process.env.MCP_TICKETS_URL ?? DEFAULT_TICKETS_URL
}

/** 用的是本地演示 server 的默认地址时，mca 顺手把它起起来，省掉开第二个终端 */
export function usesLocalDemoServer(): boolean {
  return ticketsUrl() === DEFAULT_TICKETS_URL
}

export function mcpEnabled(): boolean {
  return process.env.MCP !== 'off'
}

export function demoServers(): ServerSpec[] {
  return [
    { alias: 'notes', kind: 'stdio', command: process.execPath, args: [NOTES_SERVER] },
    // 超时给得比 stdio 短一点：连不上的 HTTP 地址要快点掉进掉线表，
    // 不然每次启动都要干等满默认超时
    { alias: 'tickets', kind: 'http', url: ticketsUrl(), timeoutMs: 3000 },
  ]
}
