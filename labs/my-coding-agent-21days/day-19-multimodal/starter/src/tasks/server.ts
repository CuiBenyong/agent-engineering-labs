/**
 * 进度与通知的接收端。本天新增，占端口 3118（本课 HTTP = 3000 + 天号，D18 天号 118）。
 *
 * 为什么要开一个口子，而不是直接读子进程的 stdout：**stdout 是给人看的日志，
 * 不是给程序读的协议。** 想从日志里解析出进度，就得约定一个前缀、写一个解析器，
 * 而任务本身打一行无关的话就会把它骗过去。给一个明确的接口，任务想报就报、
 * 不想报就不报，双方谁都不用猜对方的输出格式。
 *
 * 端口与地址都读环境变量（MCA_TASK_PORT，缺省 3118），**只绑 127.0.0.1**：
 * 这是一个本机进程之间说话的口子，绑 0.0.0.0 等于把「让 Agent 跑一条命令」
 * 这件事开放给整个局域网。
 */
import http from 'node:http'
import type { TaskManager } from './manager.js'

export const DEFAULT_TASK_PORT = 3118

export function taskPort(): number {
  const raw = Number(process.env.MCA_TASK_PORT ?? DEFAULT_TASK_PORT)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TASK_PORT
}

export interface ProgressServer {
  port: number
  close(): Promise<void>
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * 起服务端。端口被占用时**不抛异常**，返回 null 并说明原因——
 * 进度报不上来只是少一个信息，不该让整个 mca 起不来。这和第十五天掉线的
 * MCP server、第十六天写坏的技能包是同一条：**一个零件坏了，最坏的后果是少一个零件。**
 */
export function startProgressServer(manager: TaskManager): Promise<ProgressServer | null> {
  const port = taskPort()
  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
      if (request.method === 'POST' && url.pathname === '/progress') {
        const body = await readJson(request)
        const id = String(body.task ?? '')
        const ok = manager.note(id, {
          step: Number(body.step ?? 0),
          total: Number(body.total ?? 0),
          note: String(body.note ?? ''),
        })
        response.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok }))
        return
      }
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      // 只开一个口子：任务表在进程内存里，用户要看状态直接 /tasks 就够了，
      // 再开一个 HTTP 只读接口是把同一份数据从两个地方端出去
      response.end('只有 POST /progress 这一个口子\n')
    })()
  })

  return new Promise((resolve) => {
    server.once('error', () => resolve(null))
    server.listen(port, '127.0.0.1', () => {
      // unref 之后这个 server 不会拦着进程退出。自检跑完就该退，不该被一个监听器吊着
      server.unref()
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}
