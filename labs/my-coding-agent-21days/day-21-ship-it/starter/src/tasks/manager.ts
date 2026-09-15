/**
 * 后台任务表。本天新增。
 *
 * 三件套，一件都不能少：**进程、日志、状态查询**。
 *
 *   进程    起一个自成进程组的子进程，父进程不等它。
 *   日志    输出必须落盘，因为没人看着它。前台命令的输出可以直接回灌给模型，
 *           后台命令的输出可能有几万行、可能在半小时后才产生——它只能进文件。
 *   状态    一张能查的表。**这是最容易漏的一件**：没有它，一个后台任务
 *           就是一个你启动完就再也找不到的东西。
 *
 * 今天只讲这三件，**不讲隔离**——「两个任务会不会互相踩」是第十七天工作树那一节的题目。
 * 这里的后台任务和前台命令跑在同一个工作区里，这是一个已知的简化，正文里写清楚了。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { NoticeQueue } from './notify.js'

export const TASKS_DIR = path.resolve(process.cwd(), 'work/tasks')

export type TaskStatus = 'running' | 'done' | 'failed' | 'killed'

export interface TaskProgress {
  step: number
  total: number
  note: string
}

export interface Task {
  id: string
  command: string
  status: TaskStatus
  startedAt: number
  ms: number
  exitCode: number | null
  logPath: string
  /** 任务自己报上来的进度（走 3118 那个口子）。没报过就是 null */
  progress: TaskProgress | null
}

export class TaskManager {
  private readonly tasks = new Map<string, Task>()
  private readonly children = new Map<string, ChildProcess>()
  private seq = 0

  constructor(
    private readonly notices: NoticeQueue,
    private readonly cwd: string,
    private readonly extraEnv: Record<string, string> = {}
  ) {}

  /**
   * 起一个后台任务，**立刻返回**。
   *
   * 这个方法刻意不是 async 的：一旦写成 async，就一定会有人在某处 await 它，
   * 而「await 一个后台任务」正好把今天要做的事整个抵消掉。
   */
  start(command: string): Task {
    this.seq += 1
    const id = `t${this.seq}`
    const logPath = path.join(TASKS_DIR, `${id}.log`)
    const task: Task = {
      id,
      command,
      status: 'running',
      startedAt: Date.now(),
      ms: 0,
      exitCode: null,
      logPath,
      progress: null,
    }
    this.tasks.set(id, task)

    // 目录要先建好。这一步同步做掉，省得「日志文件偶尔不存在」变成一个随机故障
    void fs.mkdir(TASKS_DIR, { recursive: true }).then(() => {
      // 'w' 不是 'a'：任务号在每个进程里从 t1 重新开始，用追加的话
      // 这一次的日志会接在上一次 t1 的后面，而那个坑只在第二次跑的时候才出现
      const log = createWriteStream(logPath, { flags: 'w' })
      log.write(`$ ${command}\n`)
      // detached 与第四天 run_command 那里同一个理由：要杀就得杀整个进程组
      const child = spawn(command, {
        cwd: this.cwd,
        shell: true,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...this.extraEnv, MCA_TASK_ID: id },
      })
      this.children.set(id, child)
      child.stdout?.pipe(log)
      child.stderr?.pipe(log)
      child.on('error', (error) => this.settle(id, null, `启动失败：${error.message}`))
      child.on('close', (code) => this.settle(id, code, null))
    })

    return task
  }

  private settle(id: string, code: number | null, error: string | null): void {
    const task = this.tasks.get(id)
    if (!task || task.status !== 'running') return
    task.ms = Date.now() - task.startedAt
    task.exitCode = code
    task.status = error !== null ? 'failed' : code === 0 ? 'done' : 'failed'
    this.children.delete(id)
    const mark = task.status === 'done' ? '✔' : '✘'
    this.notices.push({
      taskId: id,
      text:
        `[后台] ${mark} ${id} ${task.status === 'done' ? '完成' : '失败'}（${task.ms}ms，退出码 ${code ?? '无'}）：` +
        `${task.command}${error ? `——${error}` : ''}。日志 /task ${id}`,
    })
  }

  /** 任务自己报进度。它走的是网络那条路，见 server.ts */
  note(id: string, progress: TaskProgress): boolean {
    const task = this.tasks.get(id)
    if (!task) return false
    task.progress = progress
    // **进度不推送通知**：一个每秒报三次进度的任务会把终端刷爆。
    // 进度是拉的（/task 去查），完成是推的（只推一次）——这条区分值得记住
    return true
  }

  list(): Task[] {
    return [...this.tasks.values()]
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  /** 看日志的最后几行。后台任务的输出不回灌给模型，只在用户问起时打给他看 */
  async tail(id: string, lines = 12): Promise<string[]> {
    const task = this.tasks.get(id)
    if (!task) return []
    const text = await fs.readFile(task.logPath, 'utf8').catch(() => '')
    return text.split('\n').filter(Boolean).slice(-lines)
  }

  /** 退出时收摊。不收的话机器上会留下一串跟谁都没关系的孤儿进程 */
  shutdown(): void {
    for (const [id, child] of this.children) {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* 已经退了 */
        }
      }
      const task = this.tasks.get(id)
      if (task && task.status === 'running') {
        task.status = 'killed'
        task.ms = Date.now() - task.startedAt
      }
    }
    this.children.clear()
  }
}
