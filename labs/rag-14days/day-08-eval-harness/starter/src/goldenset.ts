import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 标准答案集（golden set）与人工抽检标注的加载。
 *
 * 两份文件都放在 lab 根目录的 `eval/` 下，starter 与 solution 共用同一份——
 * 评估集是这门课后面六天的共同基准，谁都不许在自己的目录里偷偷改一版。
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

/** 人工抽检的一条标注：我自己读完问题、上下文和答案之后的判断 */
export interface HumanLabel {
  questionId: string
  /** 这个回答有没有超出材料乱说 */
  faithful: boolean
  /** 为什么这么判，尤其是跟裁判不一致的时候 */
  note: string
}

export function loadGoldenSet(): Question[] {
  const questions = JSON.parse(
    readFileSync(join(EVAL_DIR, 'golden-set.json'), 'utf8')
  ) as Question[]
  const ids = new Set(questions.map((q) => q.id))
  if (ids.size !== questions.length) throw new Error('golden set 里有重复的题号')
  return questions
}

export function loadHumanLabels(): HumanLabel[] {
  return JSON.parse(readFileSync(join(EVAL_DIR, 'human-labels.json'), 'utf8')) as HumanLabel[]
}

/** 覆盖度体检：三类题各有多少。评估集第一件要看的事不是分数，是它到底覆盖了什么 */
export function coverage(questions: Question[]): Record<Question['type'], number> {
  return {
    single: questions.filter((q) => q.type === 'single').length,
    multi: questions.filter((q) => q.type === 'multi').length,
    none: questions.filter((q) => q.type === 'none').length,
  }
}
