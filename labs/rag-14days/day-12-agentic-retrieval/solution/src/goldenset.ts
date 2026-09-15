import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 标准答案集（golden set）的加载，逐字沿用 D8。20 道题是第二周六天的共同基准，
 * **一个字都不许改**——改了今天的数字就没法跟 D8 的基线比。
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
