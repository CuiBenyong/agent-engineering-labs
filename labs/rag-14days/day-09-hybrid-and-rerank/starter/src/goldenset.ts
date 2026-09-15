import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 标准答案集（golden set）的加载。来自 D8，本天一个字都不改——
 * 今天要证明「混合检索比单路强多少」，尺子必须和 D8 是同一把，否则数字没法比。
 */

/** 评估文件在 lab 根目录，从当前文件往上两级定位；用 process.cwd() 会随你在哪敲命令而变 */
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

export function coverage(questions: Question[]): Record<Question['type'], number> {
  return {
    single: questions.filter((q) => q.type === 'single').length,
    multi: questions.filter((q) => q.type === 'multi').length,
    none: questions.filter((q) => q.type === 'none').length,
  }
}
