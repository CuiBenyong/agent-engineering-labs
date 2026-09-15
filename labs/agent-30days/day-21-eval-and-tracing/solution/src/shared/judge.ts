// LLM-as-judge：用模型给模型的输出打分。这个文件的一多半篇幅在防它的失效模式，
// 而不是在「怎么调用它」——调用只有一行，可信度全在那一多半里。

import { ALT_JUDGE_MODEL, callModel, CHAT_MODEL } from '../infra/model'

/** 低于 3 分算失败（本课固定口径）。 */
export const PASS_SCORE = 3

/** 评分提示词是**有版本的资产**：换一个字，同一份产出的分数就可能变。所以每条评分记录都要
 *  带上版本号，而且**分数只在同一套提示词内部可比**——v1 的 4.2 分与 v2 的 4.2 分毫无可比性。 */
export type RubricVersion = 'v1' | 'v2'

export const RUBRICS: Record<RubricVersion, string> = {
  // v1：第一版几乎所有人都会这么写。它没有可核对的东西，只能让模型凭「读起来怎么样」打分
  v1: '请你作为客服质量评审，给下面这段回复打 1 到 5 分，看它是否专业、完整、让用户满意。',
  // v2：把主观判断换成客观核对——评分标准里写死「必须出现哪几件事实」
  v2: '请逐条核对下面的必备信息清单，命中几条就按比例给分：全部命中 5 分，一条都没有 1 分。只看清单，不看文采与篇幅。',
}

export interface Verdict {
  score: number
  reason: string
  rubricVersion: RubricVersion
  judgeModel: string
}

export interface JudgeOptions {
  output: string
  /** v2 的必备信息清单。它就是这一条 golden 的期望，人写一次、之后每次评估复用 */
  checklist: string[]
  rubricVersion?: RubricVersion
  /** 谁来当 judge。默认换一个模型——同源偏差的第一道解药 */
  judgeModel?: string
  /** 被评的那份产出是谁写的。记下来才判得出这次是不是同源评分 */
  targetModel?: string
}

/** 拼 judge 提示词。版本、谁在评、评的是谁的产出、核对清单，四段都显式写进去：
 *  前三段是**这条评分记录的坐标**，没有它们，一批分数放在一起就说不清是不是同一把尺子。 */
export function buildJudgePrompt(options: Required<JudgeOptions>): string {
  const rubric = RUBRICS[options.rubricVersion]
  const checklist = options.rubricVersion === 'v2' ? options.checklist.join('|') : ''
  return [
    `RUBRIC: ${options.rubricVersion}`,
    `JUDGE_MODEL: ${options.judgeModel}`,
    `TARGET_MODEL: ${options.targetModel}`,
    rubric,
    `CHECKLIST: ${checklist}`,
    'OUTPUT:',
    options.output,
  ].join('\n')
}

/** 解析。模型只承诺给一段文本，不承诺给对的文本，所以解析失败要有确定的落点。 */
export function parseVerdict(raw: string): { score: number; reason: string } {
  const score = Number(raw.match(/SCORE:\s*([1-5])/)?.[1])
  const reason = raw.match(/REASON:\s*(.*)/)?.[1]?.trim() ?? ''
  // 解析不出来一律算最低分：判不出好坏时宁可当它没通过，也不要静默放行
  return Number.isFinite(score)
    ? { score, reason }
    : { score: 1, reason: `评分解析失败：${raw.slice(0, 40)}` }
}

export async function judge(options: JudgeOptions): Promise<Verdict> {
  // 三个默认值都必须显式落到记录里：没写下来的口径，等于没有口径。
  // 默认 judge 就换一个模型——同源偏差的第一道解药，不该靠调用方记得传参数。
  const filled: Required<JudgeOptions> = {
    output: options.output,
    checklist: options.checklist,
    rubricVersion: options.rubricVersion ?? 'v2',
    judgeModel: options.judgeModel ?? ALT_JUDGE_MODEL,
    targetModel: options.targetModel ?? CHAT_MODEL,
  }
  const raw = await callModel('judge', buildJudgePrompt(filled), filled.judgeModel)
  const { score, reason } = parseVerdict(raw)
  return { score, reason, rubricVersion: filled.rubricVersion, judgeModel: filled.judgeModel }
}

// ---------------------------------------------------------------------------
// 校准：judge 自己也要被量。留一小批人工标注，每次改评分提示词都拿它对一遍。
// 一致率掉下来，说明这次改的不是「更严格」，是「换了一把尺子」。
// ---------------------------------------------------------------------------

export interface Calibration {
  agreed: number
  total: number
  disagreements: string[]
}

/** 一致率按**结论**（过 / 不过）算，不按分数差算：分数差 1 分无所谓，结论翻了就是事故。 */
export function calibrate(
  labelled: { id: string; humanScore: number; verdict: Verdict }[]
): Calibration {
  const disagreements: string[] = []
  for (const row of labelled) {
    const humanPass = row.humanScore >= PASS_SCORE
    const judgePass = row.verdict.score >= PASS_SCORE
    if (humanPass !== judgePass)
      disagreements.push(`${row.id}（人工 ${row.humanScore} 分／judge ${row.verdict.score} 分）`)
  }
  return { agreed: labelled.length - disagreements.length, total: labelled.length, disagreements }
}
