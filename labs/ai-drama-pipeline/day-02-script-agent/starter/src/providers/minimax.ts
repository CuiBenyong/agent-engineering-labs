// MiniMax 真实实现。字段与枚举全部照官方 API 文档，改动前先去文档核对：
//   https://platform.minimaxi.com/docs/api-reference/api-overview
// 鉴权只有 Authorization: Bearer，当前 OpenAPI 里没有 GroupId。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { probeDurationMs } from '../ffmpeg.js'
import type {
  ImageProvider,
  Providers,
  TextProvider,
  TtsProvider,
  VideoProvider,
  VideoResult,
} from './types.js'

const DEFAULT_BASE_URL = 'https://api.minimax.cn'

/**
 * 按 MiniMax 官方按量付费页（人民币）。
 * 注意视频有两条计费路径，别把价钱贴到错的模型上：
 *   - Hailuo 系列（v1）走套餐里的点数扣减，官方**没有**公开它的按秒单价；
 *   - H3 系列（v2）是单独付费，按秒计价（768P ¥0.50/秒、2K ¥0.80/秒、480P ¥0.33/秒）。
 * 所以 videoPerSecond 对 H3 是真实单价，对 Hailuo 只是**让台账有量纲的折算常量**。
 * 语音同理：官方只公开资源包价，这里是折算值。
 */
export const PRICE = {
  imagePerItem: 0.025,
  videoPerSecond: 0.5,
  /** 官方只公开语音资源包价，这里是由 HD 套餐折算的近似单价，非官方标价。 */
  ttsPerCharacter: 0.00035,
}

export type MiniMaxFailureKind =
  'rate-limited' | 'auth' | 'insufficient-balance' | 'content-blocked' | 'bad-request' | 'server'

export class MiniMaxError extends Error {
  constructor(
    readonly statusCode: number,
    readonly statusMsg: string,
    readonly endpoint: string
  ) {
    super(`MiniMax ${endpoint} 失败：status_code=${statusCode} ${statusMsg}`)
    this.name = 'MiniMaxError'
  }

  /** D4 的失败分类表：哪些该重试、哪些重试也没用。 */
  get kind(): MiniMaxFailureKind {
    switch (this.statusCode) {
      case 1002:
      case 1039:
        return 'rate-limited'
      case 1004:
      case 2049:
        return 'auth'
      case 1008:
      // 2056 = 已达到 Token Plan 用量上限（2026-09-07 实测拿到的真实返回）。
      // 它和余额不足是同一类：重试多少次都不会变好，必须人去充值或升配额。
      case 2056:
        return 'insufficient-balance'
      case 1026:
      case 1027:
        return 'content-blocked'
      case 2013:
        return 'bad-request'
      default:
        return 'server'
    }
  }

  get retryable(): boolean {
    return this.kind === 'rate-limited' || this.kind === 'server'
  }
}

type BaseResp = { base_resp?: { status_code?: number; status_msg?: string } }

function config() {
  const apiKey = process.env.MINIMAX_API_KEY
  if (!apiKey) throw new Error('缺少 MINIMAX_API_KEY（或用 MOCK=1 离线运行）')
  return { apiKey, baseUrl: process.env.MINIMAX_BASE_URL ?? DEFAULT_BASE_URL }
}

async function call<T extends BaseResp>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown }
): Promise<T> {
  const { apiKey, baseUrl } = config()
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  // 先读成文本再解析：HTTP 错误时厂商的解释在正文里，
  // 直接 throw 掉状态码等于把唯一有用的线索丢了（2026-09-07 调 v2 时被这条坑了一次，
  // 只看到「HTTP 400」，看不到它到底嫌哪个字段不对）。
  const text = await res.text()
  if (!res.ok) {
    throw new MiniMaxError(res.status, `HTTP ${res.status} ${text.slice(0, 500)}`, path)
  }
  let json: T
  try {
    json = JSON.parse(text) as T
  } catch {
    throw new MiniMaxError(res.status, `返回的不是 JSON：${text.slice(0, 300)}`, path)
  }
  const code = json.base_resp?.status_code ?? 0
  if (code !== 0) throw new MiniMaxError(code, json.base_resp?.status_msg ?? '', path)
  return json
}

/**
 * 参考图与首帧图必须让**厂商的服务端**读得到，所以只接受公网 URL 或 base64 data URL。
 * 2026-09-07 用真 key 实测：直接传本机路径会被拒，报 `disallowed image url:
 * localhost or private address not allowed`。读者在自己机器上没有公网地址，
 * 唯一可行的传法就是把文件内联成 data URL——这一层替业务代码做掉这件事，
 * 于是上层可以一直用本地路径，不用关心厂商要什么形态。
 *
 * 代价要知道：base64 会让请求体膨胀约三分之一，而图片有 10MB、首帧有 20MB 的上限，
 * 所以超限时给一条能看懂的错，而不是让厂商回一个含糊的 1000。
 */
async function toRemoteImage(ref: string, maxBytes: number, label: string): Promise<string> {
  if (/^(https?:|data:)/i.test(ref)) return ref
  const buf = await readFile(ref)
  if (buf.byteLength > maxBytes) {
    throw new Error(
      `${label} ${ref} 有 ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB，` +
        `超过 ${maxBytes / 1024 / 1024}MB 上限。先压缩或降分辨率再传。`
    )
  }
  const mime = /\.png$/i.test(ref)
    ? 'image/png'
    : /\.webp$/i.test(ref)
      ? 'image/webp'
      : 'image/jpeg'
  return `data:${mime};base64,${buf.toString('base64')}`
}

async function ensureDir(path: string) {
  await mkdir(dirname(path), { recursive: true })
}

async function download(url: string, outPath: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败 ${res.status}：${url}`)
  await ensureDir(outPath)
  await writeFile(outPath, Buffer.from(await res.arrayBuffer()))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------- 文本：OpenAI 兼容 ----------
/**
 * MiniMax 的文本模型是推理型的：正文之前会先输出一段 `<think>…</think>`。
 * 2026-09-07 实测确认，即使请求里带了 `response_format: { type: 'json_object' }`
 * 这段思考文本依然存在——所以 JSON 模式**不能**替代本地校验。
 * 在 provider 这一层剥掉它，业务代码就不用每处都记得处理。
 * 只剥闭合的那一对：如果出现了没有闭合的 `<think>`，说明响应被截断了，
 * 这时候原样返回，让上层的 schema 校验把它判失败，而不是在这里悄悄吞掉。
 */
function stripReasoning(text: string): string {
  return text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, '')
}

class MiniMaxTextProvider implements TextProvider {
  readonly name = 'minimax'
  readonly model = process.env.MINIMAX_TEXT_MODEL ?? 'MiniMax-M3'

  async complete(input: { system?: string; user: string; temperature?: number }) {
    const messages = [
      ...(input.system ? [{ role: 'system', content: input.system }] : []),
      { role: 'user', content: input.user },
    ]
    const json = await call<
      BaseResp & {
        choices?: { message?: { content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
    >('/v1/chat/completions', {
      method: 'POST',
      body: { model: this.model, messages, temperature: input.temperature ?? 0.8 },
    })
    return {
      text: stripReasoning(json.choices?.[0]?.message?.content ?? ''),
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
    }
  }
}

// ---------- 图像 ----------

class MiniMaxImageProvider implements ImageProvider {
  readonly name = 'minimax'
  readonly model = process.env.MINIMAX_IMAGE_MODEL ?? 'image-01'

  async generate(input: {
    prompt: string
    outPath: string
    aspectRatio?: string
    seed?: number
    referenceImage?: string
  }) {
    const json = await call<BaseResp & { data?: { image_urls?: string[] } }>(
      '/v1/image_generation',
      {
        method: 'POST',
        body: {
          model: this.model,
          prompt: input.prompt,
          aspect_ratio: input.aspectRatio ?? '9:16',
          n: 1,
          response_format: 'url',
          prompt_optimizer: false,
          ...(input.seed === undefined ? {} : { seed: input.seed }),
          // type 目前只支持 character，且每次请求只能带一张参考图
          ...(input.referenceImage
            ? {
                subject_reference: [
                  {
                    type: 'character',
                    image_file: await toRemoteImage(
                      input.referenceImage,
                      10 * 1024 * 1024,
                      '参考图'
                    ),
                  },
                ],
              }
            : {}),
        },
      }
    )
    const url = json.data?.image_urls?.[0]
    if (!url) throw new Error('MiniMax 图像接口没有返回 image_urls')
    // 图片链接 24 小时后失效，所以下载落盘是流程的一部分，不是可选项。
    await download(url, input.outPath)
    return { path: input.outPath, costCny: PRICE.imagePerItem }
  }
}

// ---------- 视频：提交 → 轮询 → 取件 → 下载 ----------

/** v1 查询接口的 status 枚举，首字母大写。 */
const TERMINAL_OK = 'Success'
const TERMINAL_FAIL = 'Fail'

class MiniMaxVideoProvider implements VideoProvider {
  readonly name = 'minimax'
  readonly model = process.env.MINIMAX_VIDEO_MODEL ?? 'MiniMax-Hailuo-2.3'

  async generate(input: {
    prompt: string
    outPath: string
    durationSec: number
    firstFrame?: string
    resolution?: string
    onProgress?: (stage: string) => void
  }) {
    // MiniMax 有两套并存的视频接口，端点、状态枚举、取件方式全不一样，靠模型名分流：
    //   v1（Hailuo 系列）：查询用 query 参数、status 首字母大写、要再调 files/retrieve 取件；
    //   v2（H3 系列）：查询用路径参数、status 全小写、查询结果里直接带下载地址。
    // 这正是「差异不在能力，在形状」的最好例子——两条路都在这一层里关起来，
    // 上层业务代码只知道 `await video.generate(...)`，不知道底下有两套协议。
    if (/^MiniMax-H3/i.test(this.model)) return this.generateV2(input)

    const created = await call<BaseResp & { task_id?: string }>('/v1/video_generation', {
      method: 'POST',
      body: {
        model: this.model,
        prompt: input.prompt,
        duration: Math.round(input.durationSec),
        resolution: input.resolution ?? '768P',
        ...(input.firstFrame
          ? { first_frame_image: await toRemoteImage(input.firstFrame, 20 * 1024 * 1024, '首帧图') }
          : {}),
      },
    })
    const taskId = created.task_id
    if (!taskId) throw new Error('MiniMax 视频接口没有返回 task_id')

    const fileId = await this.poll(taskId, input.onProgress)
    // 拿 file_id 换真实下载地址，链接是临时的，必须立刻落盘。
    const file = await call<BaseResp & { file?: { download_url?: string } }>(
      `/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`,
      { method: 'GET' }
    )
    const url = file.file?.download_url
    if (!url) throw new Error('MiniMax 取件接口没有返回 download_url')
    await download(url, input.outPath)
    return { path: input.outPath, costCny: input.durationSec * PRICE.videoPerSecond }
  }

  /**
   * v2（H3 系列）。与 v1 的差别都是**形状**上的，不是能力上的：
   * - 提示词与首帧不再是平级字段，而是塞进 `content[]`，用 `role` 区分（`first_frame` / `reference_image`）
   * - `resolution` 与 `duration` 是必填
   * - 创建响应里**没有 `base_resp`**，只有 `{ task_id }`（实测）
   * - 查询是路径参数，状态在 `task.status` 且**全小写**，成功后 `task.content.url` 直接就是下载地址
   */
  private async generateV2(input: {
    prompt: string
    outPath: string
    durationSec: number
    firstFrame?: string
    resolution?: string
    onProgress?: (stage: string) => void
  }): Promise<VideoResult> {
    const content: Record<string, unknown>[] = [{ type: 'text', text: input.prompt }]
    if (input.firstFrame) {
      content.push({
        type: 'image_url',
        image_url: { url: await toRemoteImage(input.firstFrame, 20 * 1024 * 1024, '首帧图') },
        role: 'first_frame',
      })
    }
    const created = await call<BaseResp & { task_id?: string }>('/v2/video_generation', {
      method: 'POST',
      body: {
        model: this.model,
        content,
        resolution: input.resolution ?? '768P',
        // H3 的 duration 有下限：官方枚举是 4–15 秒，而剧本里的镜头可以只有 3 秒
        // （实测传 3 直接 HTTP 400）。所以按厂商下限请求，多出来的部分由 D6 的
        // `trim=duration=<时间槽>` 在本地裁掉——**时间轴是权威，厂商只是素材来源**。
        // 代价是这一镜会按 4 秒计费而不是 3 秒，台账因此会略微高估，这是可接受的。
        duration: Math.min(15, Math.max(4, Math.round(input.durationSec))),
        ratio: '9:16',
      },
    })
    const taskId = created.task_id
    if (!taskId) throw new Error('MiniMax v2 视频接口没有返回 task_id')

    const timeoutMs = Number(process.env.VIDEO_TIMEOUT_MS ?? 15 * 60 * 1000)
    const deadline = Date.now() + timeoutMs
    let waitMs = 5000
    for (;;) {
      const json = await call<
        BaseResp & { task?: { status?: string; content?: { url?: string }; usage?: unknown } }
      >(`/v2/query/video_generation/${encodeURIComponent(taskId)}`, { method: 'GET' })
      const status = json.task?.status ?? 'unknown'
      input.onProgress?.(status)
      if (status === 'succeeded') {
        const url = json.task?.content?.url
        if (!url) throw new Error('v2 任务成功但没有 task.content.url')
        await download(url, input.outPath)
        return { path: input.outPath, costCny: input.durationSec * PRICE.videoPerSecond }
      }
      if (status === 'failed' || status === 'cancelled') {
        throw new Error(`v2 视频任务${status === 'failed' ? '失败' : '被取消'}：task_id=${taskId}`)
      }
      if (Date.now() + waitMs > deadline) {
        throw new Error(
          `v2 视频任务超时放弃：task_id=${taskId}，已等待 ${Math.round(timeoutMs / 1000)} 秒`
        )
      }
      await sleep(waitMs)
      waitMs = Math.min(waitMs * 1.5, 20000)
    }
  }

  /** 指数退避轮询，带超时上限。官方建议 10 秒一次，这里从 5 秒起步退到 20 秒。 */
  private async poll(taskId: string, onProgress?: (s: string) => void): Promise<string> {
    const timeoutMs = Number(process.env.VIDEO_TIMEOUT_MS ?? 15 * 60 * 1000)
    const deadline = Date.now() + timeoutMs
    let waitMs = 5000
    for (;;) {
      const json = await call<BaseResp & { status?: string; file_id?: string }>(
        `/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`,
        { method: 'GET' }
      )
      const status = json.status ?? 'Unknown'
      onProgress?.(status)
      if (status === TERMINAL_OK) {
        if (!json.file_id) throw new Error('任务成功但没有 file_id')
        return json.file_id
      }
      if (status === TERMINAL_FAIL) throw new Error(`视频任务失败：task_id=${taskId}`)
      if (Date.now() + waitMs > deadline) {
        throw new Error(
          `视频任务超时放弃：task_id=${taskId}，已等待 ${Math.round(timeoutMs / 1000)} 秒`
        )
      }
      await sleep(waitMs)
      waitMs = Math.min(waitMs * 1.5, 20000)
    }
  }
}

// ---------- 语音 ----------

class MiniMaxTtsProvider implements TtsProvider {
  readonly name = 'minimax'
  readonly model = process.env.MINIMAX_TTS_MODEL ?? 'speech-2.8-hd'

  async synthesize(input: {
    text: string
    voiceId: string
    outPath: string
    emotion?: string
    speed?: number
  }) {
    const json = await call<
      BaseResp & {
        data?: { audio?: string }
        extra_info?: { audio_length?: number; usage_characters?: number }
      }
    >('/v1/t2a_v2', {
      method: 'POST',
      body: {
        model: this.model,
        text: input.text,
        stream: false,
        voice_setting: {
          voice_id: input.voiceId,
          speed: input.speed ?? 1,
          vol: 1,
          pitch: 0,
          ...(input.emotion ? { emotion: input.emotion } : {}),
        },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
      },
    })
    const hex = json.data?.audio
    if (!hex) throw new Error('MiniMax 语音接口没有返回 data.audio')
    // 默认 output_format 是 hex，不是 base64。
    await ensureDir(input.outPath)
    await writeFile(input.outPath, Buffer.from(hex, 'hex'))
    const usageCharacters = json.extra_info?.usage_characters ?? input.text.length
    return {
      path: input.outPath,
      durationMs: json.extra_info?.audio_length ?? (await probeDurationMs(input.outPath)),
      usageCharacters,
      costCny: usageCharacters * PRICE.ttsPerCharacter,
    }
  }
}

export function createMiniMaxProviders(): Providers {
  return {
    text: new MiniMaxTextProvider(),
    image: new MiniMaxImageProvider(),
    video: new MiniMaxVideoProvider(),
    tts: new MiniMaxTtsProvider(),
  }
}
