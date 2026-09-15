/**
 * run_command：执行一条 shell 命令。本天新增，也是全课风险最高的一个工具。
 *
 * 四道闸，一道都不能省：
 *   1. 超时。默认 30 秒。没有超时的命令工具会把整个 Agent 挂死在一个等输入的交互程序上。
 *   2. 输出上限。默认各留 4000 字符（标准输出与错误输出分别算）。一次 npm install
 *      的输出能有几十万字符，回灌进去会瞬间把上下文顶满。
 *   3. 工作目录。固定在沙盒仓库里，命令不许在别处执行。
 *   4. 明显危险的命令直接拒。这一道是「防手滑」不是「防攻击」——
 *      真正的隔离要靠沙盒（容器、临时目录、无网络），第五天的审批门与自动模式前置条件会讲。
 *
 * 杀进程这件事比想象的难，见 killTree 上面的注释。
 */
import { spawn } from 'node:child_process'
import type { ToolContext, ToolDef, ToolResult } from '../kernel/types.js'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_STREAM_CHARS = 4000
/** SIGTERM 之后给多久收尾，到点还没退就 SIGKILL */
const KILL_GRACE_MS = 2000

/** 明显不该由 Agent 顺手执行的命令。判据是「一旦执行就没法回滚」 */
const DENY_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+-[a-z]*[rf]/i, why: '递归或强制删除' },
  { re: /\b(shutdown|reboot|mkfs|dd\s+if=)/i, why: '会影响整台机器' },
  { re: /\bgit\s+push\b/i, why: '会把改动推到远端' },
  { re: /(^|\s)[:>]\s*\/dev\/sd/i, why: '直接写块设备' },
  { re: /\bcurl\b[^|]*\|\s*(ba)?sh/i, why: '下载并直接执行脚本' },
]

const inject = process.env.INJECT ?? ''

export const runCommandTool: ToolDef = {
  name: 'run_command',
  description:
    '在工作目录里执行一条 shell 命令，返回退出码与输出。' +
    '默认 30 秒超时，超时会被杀掉；标准输出与错误输出各最多返回 4000 字符。' +
    '适合跑测试、看 git 状态这类短命令，不要用它跑需要交互或长期驻留的进程。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令，例如 node --test' },
      timeout_ms: { type: 'integer', description: '超时毫秒数，默认 30000，上限 120000' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  readOnly: false,

  async run(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    const args = (rawArgs ?? {}) as Record<string, unknown>
    let command = String(args.command ?? '').trim()
    const timeoutMs = Math.min(
      120_000,
      Math.max(1000, Number(args.timeout_ms ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS)
    )

    if (!command) return { ok: false, content: 'command 是空的，没有执行任何东西。' }

    const denied = DENY_PATTERNS.find((rule) => rule.re.test(command))
    if (denied) {
      return {
        ok: false,
        content: `拒绝执行这条命令（${denied.why}）：${command}。如果确实需要，请让用户自己来。`,
      }
    }

    // 故障注入：把命令换成一个永远不退出的进程，用来验证超时与杀进程真的生效。
    // 顺手把超时压到 2 秒，否则自检要等两次 30 秒
    if (inject === 'timeout') {
      // 里面那个 setTimeout 是安全阀：万一你的杀进程没写对，它自己 20 秒后也会退，
      // 不至于在你机器上留一个永远转着的孤儿进程
      // 末尾的 & wait 是故意的：让 shell 留着当父进程，于是「只杀 shell」和
      // 「杀整个进程组」这两种写法会有肉眼可见的差别。
      // 里面那个 setTimeout 是安全阀：万一你的杀进程没写对，它自己 20 秒后也会退，
      // 不至于在你机器上留一个永远转着的孤儿进程。
      command =
        'node -e "setTimeout(() => process.exit(0), 20000); setInterval(() => {}, 1000)" & wait'
      return runOnce(command, Math.min(timeoutMs, 2000), ctx)
    }

    return runOnce(command, timeoutMs, ctx)
  },
}

function runOnce(command: string, timeoutMs: number, ctx: ToolContext): Promise<ToolResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    // detached: true 让子进程自成一个进程组。这是能不能真的杀掉它的关键：
    // 'node --test' 会再拉起子进程，只杀掉 shell 的话，那些孙子进程会变成孤儿继续跑，
    // 而且它们还持着管道，于是 Promise 永远不 resolve——「杀了却没停」就是这么来的。
    const child = spawn(command, {
      cwd: ctx.cwd,
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'], // stdin 给 ignore：交互命令直接读到 EOF 而不是卡住
    })

    let stdout = ''
    let stderr = ''
    let killedBy: 'timeout' | 'cancel' | null = null
    let settled = false

    const capture = (which: 'out' | 'err') => (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      // 边收边截：不要先攒完再截，那样内存里还是那几十万字符
      if (which === 'out') {
        if (stdout.length < MAX_STREAM_CHARS)
          stdout += text.slice(0, MAX_STREAM_CHARS - stdout.length)
      } else if (stderr.length < MAX_STREAM_CHARS) {
        stderr += text.slice(0, MAX_STREAM_CHARS - stderr.length)
      }
    }
    child.stdout?.on('data', capture('out'))
    child.stderr?.on('data', capture('err'))

    const killTree = (): void => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGTERM') // 负号 = 杀整个进程组
      } catch {
        /* 已经退了 */
      }
      setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* 已经退了 */
        }
      }, KILL_GRACE_MS).unref()
    }

    const timer = setTimeout(() => {
      killedBy = 'timeout'
      killTree()
    }, timeoutMs)

    // 用户按下取消也要杀到子进程。完整的取消链路是 D6 的内容，这里先把这一环接上
    const onAbort = () => {
      killedBy = 'cancel'
      killTree()
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })

    const finish = (code: number | null, signal: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
      const ms = Date.now() - startedAt
      resolve(describe(command, code, signal, stdout, stderr, ms, killedBy))
    }

    child.on('error', (error) => finish(null, `spawn 失败：${error.message}`))
    child.on('close', (code, signal) => finish(code, signal))
  })
}

function describe(
  command: string,
  code: number | null,
  signal: string | null,
  stdout: string,
  stderr: string,
  ms: number,
  killedBy: 'timeout' | 'cancel' | null
): ToolResult {
  const head =
    killedBy === 'timeout'
      ? `命令超时被杀掉（${ms}ms）：${command}`
      : killedBy === 'cancel'
        ? `命令被用户取消（${ms}ms）：${command}`
        : `命令退出码 ${code ?? signal ?? '未知'}（${ms}ms）：${command}`

  const parts = [head]
  if (stdout) parts.push(`标准输出：\n${stdout}`)
  if (stderr) parts.push(`错误输出：\n${stderr}`)
  if (!stdout && !stderr) parts.push('（没有任何输出）')
  if (killedBy === 'timeout') {
    // 失败信息要带下一步：模型看到「换个更短的命令」才会改策略，看到「超时」只会重试
    parts.push('建议把命令拆小，或者用 timeout_ms 显式放宽超时。')
  }

  return {
    ok: killedBy === null && code === 0,
    content: parts.join('\n'),
    meta: {
      command,
      exitCode: code,
      signal,
      ms,
      killedBy,
      stdoutChars: stdout.length,
      truncatedOutput: stdout.length >= MAX_STREAM_CHARS,
    },
  }
}
