// ffprobe 的最小封装：只取封装决策真正需要的那几个字段。
// 不引 fluent-ffmpeg，参数原样拼出来，读者能看到每一步执行了什么。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat } from 'node:fs/promises'

const run = promisify(execFile)

export type MediaInfo = {
  path: string
  width: number
  height: number
  fps: number
  durationSec: number
  videoCodec: string
  audioCodec: string
  container: string
  bytes: number
}

export async function probe(path: string): Promise<MediaInfo> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,codec_name,width,height,r_frame_rate',
    '-show_entries',
    'format=duration,format_name',
    '-of',
    'json',
    path,
  ])
  const json = JSON.parse(stdout) as {
    streams?: {
      codec_type?: string
      codec_name?: string
      width?: number
      height?: number
      r_frame_rate?: string
    }[]
    format?: { duration?: string; format_name?: string }
  }
  const v = json.streams?.find((s) => s.codec_type === 'video')
  const a = json.streams?.find((s) => s.codec_type === 'audio')
  const [num, den] = (v?.r_frame_rate ?? '0/1').split('/').map(Number)
  return {
    path,
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    fps: den ? Math.round((num / den) * 100) / 100 : 0,
    durationSec: Number(json.format?.duration ?? 0),
    videoCodec: v?.codec_name ?? '',
    audioCodec: a?.codec_name ?? '',
    container: (json.format?.format_name ?? '').split(',')[0] ?? '',
    bytes: (await stat(path)).size,
  }
}
