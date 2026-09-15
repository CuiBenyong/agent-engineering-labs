import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

/**
 * 沙箱第一档：进程级。
 *
 * 它只买到三样东西：**独立进程**（崩了不带走主进程）、**超时必杀**（死循环不会挂住服务）、
 * **环境变量白名单**（子进程拿不到父进程的密钥）。
 * 它买不到的东西同样要说清楚：文件系统和网络仍然是通的。
 * 真正要跑不受信任的代码，得上第二档（容器：无网络、只读 rootfs、非 root、CPU 与内存限额）
 * 或第三档（microVM）。教学实验只做第一档。
 */

/** 只放行跑起来必需的几个变量，密钥一个都不传。默认拒绝，而不是默认继承。 */
const ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG']

export interface SandboxResult {
  ok: boolean
  timedOut: boolean
  stdout: string
  stderr: string
}

export function runInSandbox(code: string, timeoutMs = 800): SandboxResult {
  const env: Record<string, string> = {}
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }

  const res = spawnSync(process.execPath, ['-e', code], {
    env, // 注意是替换而不是展开 process.env——展开就等于什么都没隔离
    cwd: tmpdir(), // 至少别让它站在项目目录里
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
    maxBuffer: 256 * 1024,
  })

  const timedOut = res.error !== undefined && 'code' in res.error && res.error.code === 'ETIMEDOUT'
  return {
    ok: !timedOut && res.status === 0,
    timedOut,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  }
}
