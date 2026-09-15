// D4 的教学主体：把「提交 → 轮询 → 取件 → 下载」四步拆开，让每一步都能被单独观察和注入失败。
// D1 的 VideoProvider.generate() 把这四步包成了一次 await，方便调用；
// 这一天要把包装拆掉，因为出问题的永远是包装里面那一层。

import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ffmpeg } from './ffmpeg.js'
import { MiniMaxError } from './providers/index.js'

/** v1 查询接口的 status 枚举，首字母大写，照官方文档抄。 */
export type TaskStatus = 'Preparing' | 'Queueing' | 'Processing' | 'Success' | 'Fail'

export type SubmitInput = {
  prompt: string
  durationSec: number
  firstFrame?: string
  resolution?: string
}

export interface VideoTaskApi {
  readonly name: string
  readonly model: string
  /** 第一步：提交，只拿回一个 task_id，此时什么都还没生成 */
  submit(input: SubmitInput): Promise<string>
  /** 第二步：查状态，成功时同时给出 file_id */
  query(taskId: string): Promise<{ status: TaskStatus; fileId?: string }>
  /** 第三步：拿 file_id 换一个临时下载地址 */
  retrieve(fileId: string): Promise<string>
  /** 第四步：立刻下载落盘，链接是临时的 */
  download(url: string, outPath: string): Promise<void>
}

/**
 * 首帧必须让**厂商的服务端**读得到，所以只接受公网 URL 或 base64 data URL。
 * 2026-09-07 用真 key 实测：直接传本机路径会被拒，报
 * `2013 invalid params, first_frame_image: invalid image url`。
 * 读者机器上没有公网地址，唯一可行的传法就是把文件内联成 data URL。
 * 代价要知道：base64 会让请求体膨胀约三分之一，首帧上限 20MB。
 */
async function toRemoteImage(ref: string): Promise<string> {
  if (/^(https?:|data:)/i.test(ref)) return ref
  const buf = await readFile(ref)
  const MAX = 20 * 1024 * 1024
  if (buf.byteLength > MAX) {
    throw new Error(`首帧 ${ref} 有 ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB，超过 20MB 上限`)
  }
  const mime = /\.png$/i.test(ref)
    ? 'image/png'
    : /\.webp$/i.test(ref)
      ? 'image/webp'
      : 'image/jpeg'
  return `data:${mime};base64,${buf.toString('base64')}`
}

export class TaskTimeoutError extends Error {
  constructor(
    readonly taskId: string,
    readonly waitedMs: number
  ) {
    super(`任务超时放弃：task_id=${taskId}，已等待 ${Math.round(waitedMs / 1000)} 秒`)
    this.name = 'TaskTimeoutError'
  }
}

export class TaskFailedError extends Error {
  constructor(readonly taskId: string) {
    super(`任务返回 Fail：task_id=${taskId}`)
    this.name = 'TaskFailedError'
  }
}

export type PollOptions = {
  timeoutMs: number
  initialWaitMs: number
  maxWaitMs: number
  factor: number
  onTick?: (info: {
    attempt: number
    status: TaskStatus
    elapsedMs: number
    nextWaitMs: number
  }) => void
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 指数退避轮询，带超时上限。
 * 三个必须做对的地方：
 *   1. 先判终态再判超时——任务刚好在最后一次查询里成功时不能被误杀；
 *   2. 超时判断放在 sleep 之前，用「睡完会不会越过截止时间」来判，而不是睡完再看；
 *   3. 间隔有上限，否则退避几轮之后你会睡上好几分钟才发现任务早就好了。
 */
export async function pollUntilDone(
  api: VideoTaskApi,
  taskId: string,
  opts: PollOptions
): Promise<string> {
  const startedAt = Date.now()
  const deadline = startedAt + opts.timeoutMs
  let waitMs = opts.initialWaitMs

  for (let attempt = 1; ; attempt += 1) {
    const { status, fileId } = await api.query(taskId)
    const elapsedMs = Date.now() - startedAt

    if (status === 'Success') {
      if (!fileId) throw new Error(`任务成功但没有 file_id：task_id=${taskId}`)
      opts.onTick?.({ attempt, status, elapsedMs, nextWaitMs: 0 })
      return fileId
    }
    if (status === 'Fail') {
      opts.onTick?.({ attempt, status, elapsedMs, nextWaitMs: 0 })
      throw new TaskFailedError(taskId)
    }

    // 睡下去会越过截止时间，就现在放弃，而不是睡完再发现超时。
    if (Date.now() + waitMs > deadline) {
      opts.onTick?.({ attempt, status, elapsedMs, nextWaitMs: 0 })
      throw new TaskTimeoutError(taskId, elapsedMs)
    }

    opts.onTick?.({ attempt, status, elapsedMs, nextWaitMs: waitMs })
    await sleep(waitMs)
    waitMs = Math.min(Math.round(waitMs * opts.factor), opts.maxWaitMs)
  }
}

// ---------- 离线实现：一个真的会走完状态机的假任务队列 ----------

type MockTask = { polls: number; input: SubmitInput; stuck: boolean }

/**
 * 全课统一的故障注入开关 INJECT，本天支持四个值：
 *   timeout     任务永远停在 Queueing，用来验证超时放弃
 *   ratelimit   第一次提交撞 1002，退避重试后成功
 *   blocked     提交撞 1027 内容审核，重试也没用
 *   badrequest  提交撞 2013 参数无效
 *   taskfail    任务走到 Fail 终态
 * 注入只作用在这一层的网络出口，轮询状态机与失败分类照常执行。
 */
class MockVideoTaskApi implements VideoTaskApi {
  readonly name = 'mock'
  readonly model = 'mock-video'
  private readonly tasks = new Map<string, MockTask>()
  private seq = 0
  private submits = 0

  async submit(input: SubmitInput): Promise<string> {
    this.submits += 1
    const inject = process.env.INJECT
    if (inject === 'ratelimit' && this.submits === 1) {
      throw new MiniMaxError(1002, '触发限流（注入）', '/v1/video_generation')
    }
    if (inject === 'blocked') {
      throw new MiniMaxError(1027, '内容涉及敏感信息（注入）', '/v1/video_generation')
    }
    if (inject === 'badrequest') {
      throw new MiniMaxError(2013, '参数无效（注入）', '/v1/video_generation')
    }
    this.seq += 1
    const taskId = `mock-task-${String(this.seq).padStart(3, '0')}`
    this.tasks.set(taskId, { polls: 0, input, stuck: inject === 'timeout' })
    return taskId
  }

  async query(taskId: string): Promise<{ status: TaskStatus; fileId?: string }> {
    const task = this.tasks.get(taskId)
    if (!task) throw new MiniMaxError(2013, `未知 task_id ${taskId}`, '/v1/query/video_generation')
    task.polls += 1
    if (task.stuck) return { status: task.polls === 1 ? 'Preparing' : 'Queueing' }
    if (process.env.INJECT === 'taskfail' && task.polls >= 3) return { status: 'Fail' }
    // 真实排队通常要几分钟，这里用四次轮询把同一条状态链走完。
    if (task.polls === 1) return { status: 'Preparing' }
    if (task.polls === 2) return { status: 'Queueing' }
    if (task.polls === 3) return { status: 'Processing' }
    return { status: 'Success', fileId: `mock-file-${taskId}` }
  }

  async retrieve(fileId: string): Promise<string> {
    return `mock://download/${fileId}`
  }

  async download(url: string, outPath: string): Promise<void> {
    const taskId = url.replace('mock://download/mock-file-', '')
    const task = this.tasks.get(taskId)
    const seconds = Math.max(1, Math.round(task?.input.durationSec ?? 6))
    await mkdir(dirname(outPath), { recursive: true })
    // 占位视频带音轨，时长照 durationSec，方便 D6 直接拿去拼接。
    await ffmpeg(
      [
        '-f',
        'lavfi',
        '-i',
        `testsrc2=s=1080x1920:r=24:d=${seconds}`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=420:d=${seconds}`,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        outPath,
      ],
      { quiet: true }
    )
  }
}

// ---------- 真实实现：字段与枚举照官方文档，改之前先去文档核对 ----------

type BaseResp = { base_resp?: { status_code?: number; status_msg?: string } }

function config() {
  const apiKey = process.env.MINIMAX_API_KEY
  if (!apiKey) throw new Error('缺少 MINIMAX_API_KEY（或用 MOCK=1 离线运行）')
  return { apiKey, baseUrl: process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.cn' }
}

async function call<T extends BaseResp>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown }
): Promise<T> {
  const { apiKey, baseUrl } = config()
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  if (!res.ok) throw new MiniMaxError(res.status, `HTTP ${res.status}`, path)
  const json = (await res.json()) as T
  const code = json.base_resp?.status_code ?? 0
  // 注意：HTTP 200 不代表成功，业务错误码在 base_resp.status_code 里。
  if (code !== 0) throw new MiniMaxError(code, json.base_resp?.status_msg ?? '', path)
  return json
}

/**
 * v1（Hailuo 系列）。同一家还有一套 v2，端点、查询参数形式与状态枚举都不同，
 * 本课统一只写 v1，不要把两套混在一起。
 */
class MiniMaxVideoTaskApi implements VideoTaskApi {
  readonly name = 'minimax'
  readonly model = process.env.MINIMAX_VIDEO_MODEL ?? 'MiniMax-Hailuo-2.3'

  async submit(input: SubmitInput): Promise<string> {
    const json = await call<BaseResp & { task_id?: string }>('/v1/video_generation', {
      method: 'POST',
      body: {
        model: this.model,
        prompt: input.prompt,
        duration: Math.round(input.durationSec),
        resolution: input.resolution ?? '768P',
        ...(input.firstFrame ? { first_frame_image: await toRemoteImage(input.firstFrame) } : {}),
      },
    })
    if (!json.task_id) throw new Error('视频接口没有返回 task_id')
    return json.task_id
  }

  async query(taskId: string) {
    // 查询是 query 参数，不是路径参数。
    const json = await call<BaseResp & { status?: string; file_id?: string }>(
      `/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`,
      { method: 'GET' }
    )
    return { status: (json.status ?? 'Processing') as TaskStatus, fileId: json.file_id }
  }

  async retrieve(fileId: string): Promise<string> {
    // file_id 一律按字符串透传：官方两个页面把它分别标成 string 与 int64，
    // 做数值转换会在长 id 上丢精度，拿到一个查不到的 id。
    const json = await call<BaseResp & { file?: { download_url?: string } }>(
      `/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`,
      { method: 'GET' }
    )
    const url = json.file?.download_url
    if (!url) throw new Error('取件接口没有返回 download_url')
    return url
  }

  async download(url: string, outPath: string): Promise<void> {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`下载失败 ${res.status}`)
    await mkdir(dirname(outPath), { recursive: true })
    await writeFile(outPath, Buffer.from(await res.arrayBuffer()))
  }
}

/**
 * v2（H3 系列）。同一家厂商的第二套视频接口——**能力雷同，形状全不一样**：
 *   - 提示词与首帧不再是平级字段，塞进 `content[]` 用 `role` 区分
 *   - 查询是**路径参数**，状态在 `task.status` 且**全小写**
 *   - **没有取件这一步**：查询成功时 `task.content.url` 直接就是下载地址
 *   - 创建响应里连 `base_resp` 都没有，只有 `{ task_id }`（实测）
 * 于是 `retrieve()` 在这里退化成「把 query 已经拿到的地址原样返回」。
 * **这就是抽象层存在的意义**：把形状差异吸收在实现类里，上层那四步的调用顺序一个字都不用改。
 */
class MiniMaxV2VideoTaskApi implements VideoTaskApi {
  readonly name = 'minimax'
  readonly model = process.env.MINIMAX_VIDEO_MODEL ?? 'MiniMax-H3'

  /** v2 的 query 直接给下载地址，这里存下来给 retrieve 用。 */
  private urls = new Map<string, string>()

  async submit(input: SubmitInput): Promise<string> {
    const content: Record<string, unknown>[] = [{ type: 'text', text: input.prompt }]
    if (input.firstFrame) {
      content.push({
        type: 'image_url',
        image_url: { url: await toRemoteImage(input.firstFrame) },
        role: 'first_frame',
      })
    }
    const json = await call<BaseResp & { task_id?: string }>('/v2/video_generation', {
      method: 'POST',
      body: {
        model: this.model,
        content,
        resolution: input.resolution ?? '768P',
        duration: Math.round(input.durationSec),
        ratio: '9:16',
      },
    })
    if (!json.task_id) throw new Error('v2 视频接口没有返回 task_id')
    return json.task_id
  }

  async query(taskId: string) {
    const json = await call<BaseResp & { task?: { status?: string; content?: { url?: string } } }>(
      `/v2/query/video_generation/${encodeURIComponent(taskId)}`,
      { method: 'GET' }
    )
    const raw = json.task?.status ?? 'running'
    const url = json.task?.content?.url
    if (url) this.urls.set(taskId, url)
    // 把 v2 的小写枚举映射回上层用的那套，映射表就是两套形状的对照表本身。
    const status: TaskStatus =
      raw === 'succeeded'
        ? 'Success'
        : raw === 'failed' || raw === 'cancelled'
          ? 'Fail'
          : raw === 'queued'
            ? 'Queueing'
            : 'Processing'
    return { status, fileId: url ? taskId : undefined }
  }

  async retrieve(taskId: string): Promise<string> {
    const url = this.urls.get(taskId)
    if (!url) throw new Error('v2 没有取件步骤，但 query 也没给出 task.content.url')
    return url
  }

  async download(url: string, outPath: string): Promise<void> {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`下载失败 ${res.status}`)
    await mkdir(dirname(outPath), { recursive: true })
    await writeFile(outPath, Buffer.from(await res.arrayBuffer()))
  }
}

export function createVideoTaskApi(): VideoTaskApi {
  if (process.env.MOCK === '1') return new MockVideoTaskApi()
  // 按模型名分流：H3 系列是 v2 接口，其余（Hailuo 系列）是 v1。
  const model = process.env.MINIMAX_VIDEO_MODEL ?? 'MiniMax-Hailuo-2.3'
  return /^MiniMax-H3/i.test(model) ? new MiniMaxV2VideoTaskApi() : new MiniMaxVideoTaskApi()
}
