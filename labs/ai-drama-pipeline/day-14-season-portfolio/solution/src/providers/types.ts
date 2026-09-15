// 全课公共数据契约与四类 provider 接口。
// 这一层在 D1 定稿，D2–D14 原样复制，不改签名。

export type ShotSize = 'wide' | 'medium' | 'close'

export type Character = {
  id: string
  name: string
  appearance: string
  personality: string
  /** MiniMax 系统音色 id，例如 badao_shaoye */
  voiceId: string
  /** 定妆基准图的相对路径，D3 之后才有 */
  referenceImage?: string
}

export type Scene = { id: string; name: string; description: string }

export type Line = { characterId: string; text: string }

export type Shot = {
  id: string
  sceneId: string
  shotSize: ShotSize
  durationSec: number
  characters: string[]
  visual: string
  camera: string
  dialogue: Line[]
}

export type TimelineEntry = {
  shotId: string
  startMs: number
  endMs: number
  clipPath: string
  voicePath?: string
  subtitle?: string
}

export type CostEntry = {
  runId: string
  nodeId: string
  provider: 'minimax' | 'mock'
  kind: 'text' | 'image' | 'video' | 'tts'
  model: string
  units: number
  costCny: number
  cached: boolean
  at: string
}

// ---------- 四类 provider ----------

export type TextResult = { text: string; promptTokens: number; completionTokens: number }

export interface TextProvider {
  readonly name: string
  readonly model: string
  complete(input: { system?: string; user: string; temperature?: number }): Promise<TextResult>
}

export type ImageResult = { path: string; costCny: number }

export interface ImageProvider {
  readonly name: string
  readonly model: string
  /** aspectRatio 本课固定 9:16；referenceImage 传公网 URL 或 base64 data URL */
  generate(input: {
    prompt: string
    outPath: string
    aspectRatio?: string
    seed?: number
    referenceImage?: string
  }): Promise<ImageResult>
}

export type VideoResult = { path: string; costCny: number }

export interface VideoProvider {
  readonly name: string
  readonly model: string
  /** 异步任务：内部完成提交、轮询、取件、下载四步，对调用方表现为一次 await */
  generate(input: {
    prompt: string
    outPath: string
    durationSec: number
    firstFrame?: string
    resolution?: string
    onProgress?: (stage: string) => void
  }): Promise<VideoResult>
}

export type TtsResult = {
  path: string
  durationMs: number
  usageCharacters: number
  costCny: number
}

export interface TtsProvider {
  readonly name: string
  readonly model: string
  synthesize(input: {
    text: string
    voiceId: string
    outPath: string
    emotion?: string
    speed?: number
  }): Promise<TtsResult>
}

export type Providers = {
  text: TextProvider
  image: ImageProvider
  video: VideoProvider
  tts: TtsProvider
}
