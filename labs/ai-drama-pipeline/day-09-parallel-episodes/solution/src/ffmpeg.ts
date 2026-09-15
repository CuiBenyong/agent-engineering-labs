// ffmpeg 的最小封装：不引 fluent-ffmpeg，直接拼参数并把命令打印出来，
// 这样读者能看到每一步真正执行了什么。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export class FfmpegMissingError extends Error {
  constructor() {
    super(
      [
        '找不到 ffmpeg。本实验的占位素材与成片合成都依赖它。',
        '  macOS:  brew install ffmpeg',
        '  Debian: sudo apt-get install -y ffmpeg',
        '装好后重新运行。',
      ].join('\n')
    )
    this.name = 'FfmpegMissingError'
  }
}

let ensured = false

/** 启动时探测一次；缺失就抛可读错误，绝不静默失败。 */
export async function ensureFfmpeg(): Promise<void> {
  if (ensured) return
  try {
    await run('ffmpeg', ['-version'])
    ensured = true
  } catch {
    throw new FfmpegMissingError()
  }
}

/** 探测某个滤镜是否可用。这个 build 里没有 drawtext / subtitles 是常态，见 README。 */
export async function hasFilter(name: string): Promise<boolean> {
  try {
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-filters'])
    return new RegExp(`(^|\\s)${name}\\s`, 'm').test(stdout)
  } catch {
    return false
  }
}

export async function ffmpeg(args: string[], opts: { quiet?: boolean } = {}): Promise<void> {
  await ensureFfmpeg()
  if (!opts.quiet) console.log(`    $ ffmpeg ${args.join(' ')}`)
  await run('ffmpeg', ['-v', 'error', '-y', ...args], { maxBuffer: 1024 * 1024 * 32 })
}

/** 读一个媒体文件的时长（毫秒）。 */
export async function probeDurationMs(path: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    path,
  ])
  return Math.round(Number.parseFloat(stdout.trim()) * 1000)
}
