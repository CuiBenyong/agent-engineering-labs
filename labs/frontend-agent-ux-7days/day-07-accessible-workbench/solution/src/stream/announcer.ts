/**
 * 流式内容的屏幕阅读器播报。
 *
 * 这一节的结论是反直觉的：**把实时区域指向流式渲染的那个元素是错的**，
 * 而那恰恰是最多人会做的第一反应。
 *
 * 两个陷阱：
 *   aria-atomic 为 true  → 每来一个增量就重念整段，用户听到的是不断从头开始的噪音
 *   aria-atomic 为 false → 高频 DOM 变化会被屏幕阅读器整个跳过，什么都听不到
 *
 * 而且 NVDA、JAWS、VoiceOver 三家对高频变化的处理各不相同，
 * 所以「在我的机器上能用」在这里特别不可靠。
 *
 * 正确做法：**流式期间静默，按句子完成时分段播报**。
 * 视觉用户逐字看到内容，屏幕阅读器用户按句子听到内容，
 * 两者节奏相当，而且都不会被噪音淹没。
 */

/** 句末标点：中英文都要覆盖。 */
const SENTENCE_END = /[。！？；.!?;]\s*/

export type AnnouncerOptions = {
  /** 把一段完成的文字交给实时区域 */
  emit: (text: string) => void
  /**
   * 兜底：超过这个长度还没遇到句末标点就强制播报一段。
   * 没有它的话，一段没有标点的长文本会一直不播报。
   */
  maxChars?: number
}

export type Announcer = {
  /** 喂入到目前为止的**完整文本**（不是增量） */
  update: (fullText: string) => void
  /** 流结束时调用，把剩下的尾巴播报出去 */
  finish: () => void
  reset: () => void
  /** 统计用：已经播报了几段 */
  readonly announced: number
}

export function createAnnouncer(options: AnnouncerOptions): Announcer {
  const { emit, maxChars = 120 } = options

  /** 已经播报到原文的哪个位置。只播报新增部分，绝不重复播报。 */
  let consumed = 0
  let count = 0
  /** 最后一次看到的全文，finish 时用它收尾。 */
  let lastSeen = ''

  function flush(fullText: string, force: boolean) {
    lastSeen = fullText
    let rest = fullText.slice(consumed)

    while (rest.length > 0) {
      const match = SENTENCE_END.exec(rest)

      if (match) {
        const end = match.index + match[0].length
        const sentence = rest.slice(0, end).trim()
        if (sentence) {
          emit(sentence)
          count += 1
        }
        consumed += end
        rest = rest.slice(end)
        continue
      }

      // 没遇到句末标点：超长或收尾时强制切一段，否则等下一批增量。
      if (force || rest.length >= maxChars) {
        const sentence = rest.trim()
        if (sentence) {
          emit(sentence)
          count += 1
        }
        consumed += rest.length
      }
      return
    }
  }

  return {
    update(fullText: string) {
      flush(fullText, false)
    },
    finish() {
      flush(lastSeen, true)
    },
    reset() {
      consumed = 0
      count = 0
      lastSeen = ''
    },
    get announced() {
      return count
    },
  }
}
