import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * D8 定稿的 20 题标准答案集，本天原样复用，一个字不改。
 *
 * 这一天要证明的是「查询侧的手法有没有净收益」，而收益只能相对同一把尺子来说。
 * 换题等于换尺子，那样得出的「涨了 5 个点」谁都不能信。
 */

const EVAL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'eval')

export interface Question {
  id: string
  question: string
  /** 能回答这一问的文档；`none` 类是空数组 */
  answerDocIds: string[]
  /**
   * single：单篇即可答（列出多篇时任意一篇进上下文就算命中）
   * multi ：必须凑齐全部答案文档才算命中
   * none  ：语料里根本没有答案，正确行为是拒答
   */
  type: 'single' | 'multi' | 'none'
}

export function loadGoldenSet(): Question[] {
  const questions = JSON.parse(
    readFileSync(join(EVAL_DIR, 'golden-set.json'), 'utf8')
  ) as Question[]
  const ids = new Set(questions.map((q) => q.id))
  if (ids.size !== questions.length) throw new Error('golden set 里有重复的题号')
  return questions
}
