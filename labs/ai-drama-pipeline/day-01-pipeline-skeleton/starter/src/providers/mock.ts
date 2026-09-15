// 离线实现：不需要网络、不需要密钥，但产出的是真文件。
// 关键约束：不使用 drawtext / subtitles / ass 滤镜——最小 ffmpeg build 里没有它们。

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ffmpeg, probeDurationMs } from '../ffmpeg.js'
import type { ImageProvider, Providers, TextProvider, TtsProvider, VideoProvider } from './types.js'

/** 每个汉字 0.22 秒——全课统一的台词时长估算系数。 */
export const SECONDS_PER_HANZI = 0.22

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 由任意字符串稳定地取一个颜色，让不同镜头的占位图颜色不同。 */
function colorOf(key: string): string {
  let h = 2166136261
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  const hue = Math.abs(h) % 360
  const [r, g, b] = hsvToRgb(hue, 0.55, 0.72)
  return `0x${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  const t: [number, number, number] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x]
  return t.map((n) => Math.round((n + m) * 255)) as [number, number, number]
}

/** 由字符串取一个可听出差别的音高。 */
function toneOf(key: string): number {
  let h = 0
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return 260 + (h % 8) * 55
}

async function ensureDir(path: string) {
  await mkdir(dirname(path), { recursive: true })
}

class MockTextProvider implements TextProvider {
  readonly name = 'mock'
  readonly model = 'mock-text'
  async complete(input: { system?: string; user: string }) {
    await sleep(30)
    // 业务逻辑要真的跑，所以离线回复也要随输入变化：把输入回显进去。
    const text = `【离线模拟】收到 ${input.user.length} 字的请求。去掉 MOCK=1 并配置 MINIMAX_API_KEY 就会连真实模型。`
    return { text, promptTokens: input.user.length, completionTokens: text.length }
  }
}

class MockImageProvider implements ImageProvider {
  readonly name = 'mock'
  readonly model = 'mock-image'
  async generate(input: {
    prompt: string
    outPath: string
    seed?: number
    referenceImage?: string
  }) {
    await ensureDir(input.outPath)
    // 练习 1：让占位图「按镜头不同而不同」，并且是 1080x1920 的竖屏。
    //   把 key 拼成 `${input.prompt}|${input.seed ?? ''}|${input.referenceImage ?? ''}`，
    //   用 colorOf(key) 取一个稳定颜色，再把下面 ffmpeg 参数里的颜色与画布尺寸换掉。
    //   提示：lavfi 的 color 源写法是 color=c=0xRRGGBB:s=宽x高 ，-frames:v 1 表示只出一帧。
    void colorOf
    await ffmpeg(
      ['-f', 'lavfi', '-i', 'color=c=0x808080:s=640x640', '-frames:v', '1', input.outPath],
      { quiet: true }
    )
    return { path: input.outPath, costCny: 0 }
  }
}

class MockVideoProvider implements VideoProvider {
  readonly name = 'mock'
  readonly model = 'mock-video'
  async generate(input: {
    prompt: string
    outPath: string
    durationSec: number
    firstFrame?: string
    onProgress?: (stage: string) => void
  }) {
    await ensureDir(input.outPath)
    // 练习 2：把占位视频补成一段「像真的」的片子，三件事缺一不可——
    //   (1) 依次回调 input.onProgress 走一遍 Preparing / Queueing / Processing / Success，
    //       真实厂商是异步任务，离线也要让调用方的状态机代码真的被执行；
    //   (2) 时长照 input.durationSec 来，不要写死 1 秒；
    //   (3) 加一条音轨，否则第 6 天合成时会因为缺音轨而对不齐。
    //   提示：testsrc2=s=1080x1920:r=24:d=秒数 出画面，sine=frequency=赫兹:d=秒数 出声音，
    //        两路 -f lavfi -i 之后用 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest 收尾。
    //        音高可以用 toneOf(input.prompt)，不同镜头听起来就不一样。
    void toneOf
    void sleep
    await ffmpeg(
      [
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=1080x1920:r=24:d=1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        input.outPath,
      ],
      { quiet: true }
    )
    return { path: input.outPath, costCny: 0 }
  }
}

class MockTtsProvider implements TtsProvider {
  readonly name = 'mock'
  readonly model = 'mock-tts'
  async synthesize(input: { text: string; voiceId: string; outPath: string }) {
    await ensureDir(input.outPath)
    const seconds = Math.max(0.5, Number((input.text.length * SECONDS_PER_HANZI).toFixed(2)))
    await ffmpeg(
      [
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=${toneOf(input.voiceId)}:d=${seconds}`,
        '-c:a',
        'libmp3lame',
        '-b:a',
        '128k',
        input.outPath,
      ],
      { quiet: true }
    )
    return {
      path: input.outPath,
      durationMs: await probeDurationMs(input.outPath),
      usageCharacters: input.text.length,
      costCny: 0,
    }
  }
}

export function createMockProviders(): Providers {
  return {
    text: new MockTextProvider(),
    image: new MockImageProvider(),
    video: new MockVideoProvider(),
    tts: new MockTtsProvider(),
  }
}

/** 写一个占位的空文件，供 starter 挖空处使用。 */
export async function writePlaceholderFile(path: string, note: string) {
  await ensureDir(path)
  await writeFile(path, note, 'utf8')
}
