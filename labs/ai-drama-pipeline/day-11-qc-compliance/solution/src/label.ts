// D11 的第三块：生成合成内容标识。
//
// 法规口径（《人工智能生成合成内容标识办法》，2025 年 9 月 1 日起施行）：
//   显式标识 = 在内容或界面中添加的、以文字/声音/图形呈现、**可以被用户明显感知**的标识；
//   隐式标识 = 用技术措施加在**文件数据**里的、不易被用户明显感知的标识。
//   两者都要做，不是二选一。
//
// ⚠️ 下面这个 JSON 结构是**本课自己定的演示结构**，不是国标字段。
//    强制性国标 GB 45438-2025《网络安全技术 人工智能生成合成内容标识方法》与办法同日实施，
//    元数据的具体字段名以国标正式文本为准，上线前必须逐字核对。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { hasFilter } from './ffmpeg.js'

const run = promisify(execFile)

export type GenLabel = {
  generatedBy: 'ai'
  producer: string
  models: string[]
  runId: string
  createdAt: string
  note: string
}

export function buildLabel(runId: string, producer: string, models: string[]): GenLabel {
  return {
    generatedBy: 'ai',
    producer,
    models,
    runId,
    createdAt: new Date().toISOString(),
    note: '本课演示用结构，字段名以 GB 45438-2025 正式文本为准',
  }
}

/** 隐式标识：写进容器元数据。`-c copy` 意味着不重新编码，几十毫秒就写完。 */
export async function writeImplicitLabel(input: {
  videoPath: string
  srtPath: string
  outPath: string
  label: GenLabel
}): Promise<void> {
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    input.videoPath,
    '-i',
    input.srtPath,
    '-c',
    'copy',
    '-c:s',
    'mov_text',
    '-metadata:s:s:0',
    'language=chi',
    '-metadata',
    `comment=${JSON.stringify(input.label)}`,
    '-metadata',
    'title=AI 生成合成内容',
    input.outPath,
  ])
}

/** 读回来验证。写进去没读过，等于没写。 */
export async function readImplicitLabel(path: string): Promise<GenLabel | null> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format_tags=comment',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    path,
  ])
  try {
    return JSON.parse(stdout.trim()) as GenLabel
  } catch {
    return null
  }
}

export type ExplicitPlan = { mode: 'burn-in' | 'subtitle-track'; text: string; note: string }

/**
 * 显式标识要「可以被用户明显感知」。最稳的做法是烧进画面，
 * 但烧字需要 ffmpeg 带 libfreetype（drawtext 滤镜）——很多最小 build 没有。
 * 所以这里**先探测能力再降级**：探测不到就把标识作为字幕轨的第一条送出去，并把降级这件事说清楚。
 */
export async function planExplicitLabel(text: string): Promise<ExplicitPlan> {
  if (await hasFilter('drawtext')) {
    return { mode: 'burn-in', text, note: '本机 ffmpeg 带 drawtext，标识直接烧进画面' }
  }
  return {
    mode: 'subtitle-track',
    text,
    note: '本机 ffmpeg 没有 drawtext（缺 libfreetype），已回落为字幕轨承载显式标识；正式发布前必须换成烧录版本',
  }
}

/** 把显式标识作为第一条字幕塞进 SRT，并把后面每一条的序号顺延。 */
export function prependLabelCue(srt: string, text: string, holdMs = 2000): string {
  const stamp = (ms: number) => {
    const p = (n: number, w = 2) => String(n).padStart(w, '0')
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`
  }
  const shifted = srt.replace(/^(\d+)$/gm, (_m, n: string) => String(Number(n) + 1))
  return `1\n${stamp(0)} --> ${stamp(holdMs)}\n${text}\n\n${shifted}`
}
