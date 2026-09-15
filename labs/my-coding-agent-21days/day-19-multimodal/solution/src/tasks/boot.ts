/**
 * 后台任务这一摊的启停。本天新增。
 *
 * 单独做一个 boot 文件的理由和第十五天的 mcp/boot.ts 一样：**REPL 只该多两行。**
 * 起队列、起任务表、起进度接收端是三件事，全塞进 repl.ts 的话那个文件会一路变胖，
 * 而它本来的职责只有按键、命令分发与提示符。
 */
import type { TaskState } from '../session-factory.js'
import { NoticeQueue } from './notify.js'
import { TaskManager } from './manager.js'
import { startProgressServer, taskPort, type ProgressServer } from './server.js'

export interface BootedTasks {
  state: TaskState
  server: ProgressServer | null
}

export async function bootTasks(cwd: string, out: (line: string) => void): Promise<BootedTasks> {
  const notices = new NoticeQueue()
  const port = taskPort()
  // 端口要在起 server 之前就告诉任务表：它是通过环境变量传给每个子进程的
  const manager = new TaskManager(notices, cwd, { MCA_TASK_PORT: String(port) })
  const server = await startProgressServer(manager)
  if (server) out(`[后台] 进度接收端已就绪：http://127.0.0.1:${server.port}（/tasks 看任务）`)
  else out(`[后台] 端口 ${port} 被占用，任务照样能跑，只是报不上进度（MCA_TASK_PORT 可以换端口）`)
  return { state: { manager, notices }, server }
}

export async function shutdownTasks(booted: BootedTasks): Promise<void> {
  // 先杀进程再关端口：反过来的话，正在报进度的任务会在关掉的端口上收到连接拒绝，
  // 日志里多出一堆吓人的报错，而那只是我们自己收摊的顺序没排对
  booted.state.manager.shutdown()
  await booted.server?.close()
}
