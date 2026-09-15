/**
 * 结构化提问的数据结构与解析。本天新增，是纯函数，不碰终端也不碰模型。
 *
 * 为什么反问要做成一个**工具**，而不是让模型在正文里问一句：
 *
 *   一、正文里的问句没有边界。模型说完「你是想让它抛错还是返回 null？」之后，
 *      循环拿到的是 finish_reason: stop，它和「我答完了」长得一模一样。
 *      于是程序无法区分「这一轮结束了」与「这一轮在等人」——只有人能看出区别，
 *      而人恰恰是最不该被要求看出区别的那一方（他会以为 Agent 卡住了）。
 *   二、答案回不到正确的位置。用户下一句话会变成一条新的用户消息，
 *      而模型的问题在上一条助手消息里；中间隔着一整轮，答案和问题的绑定只能靠模型自己回忆。
 *      做成工具之后，答案是一条 role 为 tool、toolCallId 指回那次提问的消息——**绑定是结构上的**。
 *   三、问不清楚。自由文本的问题永远是「你想怎么做？」这种没法回答的形状。
 *      给它一个带 options 的 schema，它就必须把「有哪几种做法」先想清楚才问得出来。
 *
 * 第三条是收益最大的一条，而它是 schema 白拿的：**工具的参数表就是提问的质量下限。**
 */

export interface QuestionOption {
  /** 回灌给模型的值。要短、要稳定，别把整句话当值 */
  value: string
  /** 给人看的一行说明 */
  label: string
}

export interface Question {
  question: string
  /** 没有选项就是开放问题。有选项时终端渲染成可选列表 */
  options?: QuestionOption[]
  /** 直接回车时选哪一个（必须是某个 option 的 value） */
  default?: string
  /** 允许多选。多选时用逗号或空格分隔 */
  multi?: boolean
}

/** 一次提问的结果。note 是给人看的一句话，answers 是回灌给模型的值 */
export interface Answer {
  answers: string[]
  note: string
}

/**
 * 把模型给的参数收成一个 Question。
 *
 * 这里做的是**收窄**而不是校验：模型给的 options 可能是字符串数组，也可能是对象数组，
 * 也可能给了一个不在 options 里的 default。全部就地纠正，不要因为格式不完美就拒绝提问——
 * 提问被拒绝的后果是它退回去自己猜，那比一个格式松散的问题糟得多。
 */
export function normalizeQuestion(raw: unknown): Question | null {
  const bag = (raw ?? {}) as Record<string, unknown>
  const question = String(bag.question ?? '').trim()
  if (!question) return null

  const options: QuestionOption[] = []
  if (Array.isArray(bag.options)) {
    for (const item of bag.options) {
      if (typeof item === 'string') {
        options.push({ value: item, label: item })
        continue
      }
      const entry = (item ?? {}) as Record<string, unknown>
      const value = String(entry.value ?? entry.label ?? '').trim()
      if (!value) continue
      options.push({ value, label: String(entry.label ?? value).trim() })
    }
  }

  const wanted = String(bag.default ?? '').trim()
  // default 必须是真的存在的那个选项，否则回车会选出一个不存在的东西
  const fallback = options.some((option) => option.value === wanted) ? wanted : undefined

  return {
    question,
    ...(options.length > 0 ? { options } : {}),
    ...(fallback ? { default: fallback } : {}),
    ...(bag.multi === true ? { multi: true } : {}),
  }
}

/** 渲染成终端上的几行。选项前面带序号，默认项标出来 */
export function formatQuestion(question: Question): string[] {
  const lines = [`需要你决定：${question.question}`]
  question.options?.forEach((option, index) => {
    const mark = option.value === question.default ? '（回车默认）' : ''
    lines.push(`  ${index + 1}. ${option.label}${mark}`)
  })
  const many = question.multi ? '可以多选，用逗号分隔；' : ''
  if (question.options) lines.push(`${many}回一个序号或选项名，也可以直接打字给别的答案。`)
  return lines
}

/**
 * 把用户回的一行解析成答案。
 *
 * 三条口径，都是被「用户会怎么回」逼出来的：
 *   1. **空回答不等于没答案。** 有默认项就取默认项，没有默认项才算跳过——
 *      跳过也要明确回灌「用户没有回答」，不能装作他选了第一个。
 *   2. **序号与选项名都收。** 人在终端里最自然的输入是「2」，而模型给的 value 才是它认的键。
 *   3. **不认识的输入原样当答案。** 选项是模型列的，它常常列不全；把「都不是，我要第三种」
 *      原样回灌回去，比逼用户在三个错选项里挑一个有用得多。
 */
export function parseAnswer(raw: string | null, question: Question): Answer {
  const line = (raw ?? '').trim()
  const options = question.options ?? []

  // TODO(2)：这里现在有两个毛病，都是「看着够用、一到终端里就不够」。
  //   一、空回答直接算「没答」，把 default 白写了。用户在终端里最常做的动作就是
  //      直接回车，他心里想的是「按你说的默认那个来」。
  //   二、只按 value 认答案，不认序号。而人在终端里最自然的输入是「2」。
  // 把这两条补上：空回答有 default 就取 default（没有才算跳过），
  // 每一段输入先试序号（1 起，注意越界）、再试 value 与 label。
  if (!line) {
    return { answers: [], note: '用户没有回答这个问题' }
  }

  const pieces = question.multi ? line.split(/[,，\s]+/).filter(Boolean) : [line]
  const picked: string[] = []
  const free: string[] = []

  for (const piece of pieces) {
    const hit = options.find((option) => option.value === piece)
    if (hit) picked.push(hit.value)
    else free.push(piece)
  }

  if (picked.length === 0) {
    return { answers: [line], note: `用户给的是自由回答：${line}` }
  }
  const answers = [...picked, ...free]
  return {
    answers,
    note:
      free.length > 0
        ? `选了 ${picked.join('、')}，另外补了：${free.join(' ')}`
        : `选了 ${picked.join('、')}`,
  }
}
