import { ATTACK_CASES, NORMAL_TASKS, type AttackCase } from '../core/corpus.js'
import { LEVELS, type DefenseLevel } from '../defense/levels.js'
import { attackSucceeded, runAgent, taskCompleted } from '../agent/run.js'

export interface LevelScore {
  level: DefenseLevel
  name: string
  /** 攻击成功率 */
  asr: number
  /** 正常任务完成率 */
  utility: number
  /** 哪几条攻击得手了 */
  succeeded: string[]
  /** 哪几条正常任务被挡了（检测器误伤） */
  falsePositives: string[]
}

export function scoreLevel(level: DefenseLevel, attacks: AttackCase[]): LevelScore {
  const succeeded: string[] = []
  for (const attack of attacks) {
    const result = runAgent(level, attack)
    if (attackSucceeded(result, attack)) succeeded.push(attack.id)
  }

  const falsePositives: string[] = []
  let done = 0
  for (const task of NORMAL_TASKS) {
    const result = runAgent(level, task)
    if (taskCompleted(result, task)) done += 1
    else falsePositives.push(task.id)
  }

  return {
    level,
    name: LEVELS[level].name,
    asr: succeeded.length / attacks.length,
    utility: done / NORMAL_TASKS.length,
    succeeded,
    falsePositives,
  }
}

export function scoreAll(attacks: AttackCase[] = ATTACK_CASES): LevelScore[] {
  return LEVELS.map((l) => scoreLevel(l.level, attacks))
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`.padStart(4)

/** 中日韩字符按两列宽计算，否则表格在终端里会错位。 */
function padDisplay(text: string, width: number): string {
  const used = [...text].reduce((n, ch) => n + (/[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1), 0)
  return text + ' '.repeat(Math.max(0, width - used))
}

export function renderTable(scores: LevelScore[], attackCount: number): string {
  const lines: string[] = []
  lines.push(`攻击用例 ${attackCount} 条，正常任务 ${NORMAL_TASKS.length} 条`)
  lines.push('')
  lines.push(`档位  ${padDisplay('防御', 16)}  ASR   utility  得手的攻击`)
  lines.push('─'.repeat(72))
  for (const s of scores) {
    const name = padDisplay(s.name, 16)
    const succeeded = s.succeeded.length > 0 ? s.succeeded.join(' ') : '（无）'
    lines.push(`  L${s.level}  ${name}  ${pct(s.asr)}   ${pct(s.utility)}   ${succeeded}`)
    if (s.falsePositives.length > 0) {
      lines.push(`      └─ 被误伤的正常任务：${s.falsePositives.join(' ')}`)
    }
  }
  return lines.join('\n')
}
