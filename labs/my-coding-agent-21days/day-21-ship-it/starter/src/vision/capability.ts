/**
 * 能力探测与降级。本天最该记住的一节。
 *
 * **不支持图片的模型不会报错，它会编一个答案。** 2026-09-07 用真实 key 在一个
 * OpenAI 兼容网关上实测：同一张纯红色的图发给四个模型，四个都正常返回、没有任何错误，
 * 其中一个把这张纯红图说成了蓝绿色。
 *
 * 这条实测结论把「能力探测」这件事的做法整个改掉了：
 *
 *   ✘ 发一张图，没报错就算支持        —— 会把编答案的模型判成支持
 *   ✘ 看模型 id 里有没有 vision 字样   —— 模型 id 的形状随网关变（第一天讲过）
 *   ✘ 查一张自己维护的支持清单        —— 清单会过期，而过期时没有任何东西会报错
 *   ✔ **发一张答案已知的图，核对它答得对不对**
 *
 * 最后这条之所以成立，是因为图是我们自己生成的（见 png.ts）：颜色由我们指定，
 * 所以「正确答案」是我们已知的事实，不是另一个需要相信的东西。
 * 这就是**可验证的判据**——判据必须能被独立核对，否则它只是换了个地方的猜测。
 *
 * 探针图故意每次随机换一种颜色：固定一种颜色时，一个瞎蒙的模型有不小的概率蒙对。
 */
import type { ChatProvider } from '../providers/types.js'
import type { Message } from '../kernel/types.js'
import { solidPng } from './png.js'

export type Support = 'unknown' | 'yes' | 'no'

export interface VisionState {
  support: Support
  /** auto 按探测结果走；off 是用户手动强制走文字降级 */
  mode: 'auto' | 'off'
  note: string
}

export function createVisionState(): VisionState {
  return { support: 'unknown', mode: 'auto', note: '还没探测过' }
}

/** 探针色：颜色之间隔得足够远，答错就是真的没看见，不是「说法不同」 */
export const PROBE_COLORS = [
  { rgb: [220, 30, 30] as [number, number, number], words: ['红', 'red'] },
  { rgb: [30, 120, 220] as [number, number, number], words: ['蓝', 'blue'] },
  { rgb: [40, 170, 70] as [number, number, number], words: ['绿', 'green'] },
  { rgb: [240, 200, 40] as [number, number, number], words: ['黄', 'yellow'] },
]

export const PROBE_QUESTION = '这张图是一整块纯色。它是什么颜色？只回答一个颜色词，不要解释。'

export interface ProbeOutcome {
  ok: boolean
  expected: string
  answer: string
  note: string
}

/**
 * 跑一次探测：生成一张纯色图，问它什么颜色，核对答案。
 *
 * 探针图取 128x128 而不是更小——校验那一层的下限是 64，探针自己当然要过得了自己的闸。
 */
export async function probeVision(
  provider: ChatProvider,
  pick = PROBE_COLORS[
    Math.floor(Math.random() * PROBE_COLORS.length)
  ] as (typeof PROBE_COLORS)[number]
): Promise<ProbeOutcome> {
  const png = solidPng(128, 128, pick.rgb)
  const message: Message = {
    role: 'user',
    content: [
      { type: 'text', text: PROBE_QUESTION },
      { type: 'image', mediaType: 'image/png', base64: png.toString('base64') },
    ],
  }

  let answer = ''
  try {
    for await (const delta of provider.stream({ messages: [message] })) {
      if (delta.type === 'text') answer += delta.text
    }
  } catch (error) {
    // 网关直接报错是**好消息**：至少它说了实话。同样判为不支持，但理由不一样
    return {
      ok: false,
      expected: pick.words[0] as string,
      answer: '',
      note: `发图时网关报错：${(error as Error).message}`,
    }
  }

  const said = answer.trim().toLowerCase()
  const ok = pick.words.some((word) => said.includes(word))
  return {
    ok,
    expected: pick.words[0] as string,
    answer: answer.trim().slice(0, 40),
    note: ok
      ? `答对了（问纯${pick.words[0]}图，它说「${answer.trim().slice(0, 20)}」）`
      : `答错了（问纯${pick.words[0]}图，它说「${answer.trim().slice(0, 20) || '（没说话）'}」）——` +
        '它没报错，但它看不见这张图',
  }
}

/**
 * 这一轮要不要发图。有图的轮次才会调它，探一次就记住。
 *
 * 离线剧本模式直接判为支持并跳过探测：剧本是写死的台词，拿它探能力测不出任何东西，
 * 反而会把一场离线演示判成「模型看不见」。**探测要有意义，前提是对面真的在思考。**
 */
export async function ensureVision(provider: ChatProvider, state: VisionState): Promise<void> {
  if (state.mode === 'off' || state.support !== 'unknown') return
  if (provider.id === 'mock') {
    state.support = 'yes'
    state.note = '离线剧本模式：跳过探测（探测必须真的发一张图出去才有意义）'
    return
  }
  const outcome = await probeVision(provider)
  state.support = outcome.ok ? 'yes' : 'no'
  state.note = outcome.note
}

/** 这一轮到底发不发图 */
export function willSendImages(state: VisionState): boolean {
  return state.mode === 'auto' && state.support !== 'no'
}

/** 一行状态说明，/vision 与每轮报账共用 */
export function describeVision(state: VisionState): string {
  if (state.mode === 'off') return '图片输入：已被 /vision off 关掉，这一轮走文字降级'
  const label = { unknown: '未探测', yes: '支持', no: '不支持' }[state.support]
  return `图片输入：${label}（${state.note}）`
}
