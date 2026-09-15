/**
 * 阶段一的产物：把每个 skill 的 name 与 description 拼成一份目录，塞进系统提示。
 * **正文一个字都不进来。** 这一步的开销是你唯一每一轮都要付的固定成本，所以要能算出来。
 */
import type { ParsedSkill } from './parse.js'

/** 粗略估算：中英混排大约 2.5 个字符一个 token。要精确请换各家的分词器。 */
export const estimateTokens = (text: string) => Math.ceil(text.length / 2.5)

const INSTRUCTIONS = [
  '以下技能提供了特定任务的专门指令。',
  '当任务命中某条 description 时，先读取对应 location 的文件再继续。',
  '技能正文里的相对路径，按该技能目录（location 的父目录）解析。',
].join('\n')

export function buildCatalog(skills: ParsedSkill[]): string {
  // 练习 4：拼出注入系统提示的那份目录。
  //   - 每个 skill 只放 name、description、location 三样，**正文一个字都不能进来**
  //   - 一个 skill 都没有时整段省略：给模型一份空清单只会让它困惑
  //   - 前面要带上 INSTRUCTIONS，告诉模型怎么用这份清单
  void INSTRUCTIONS
  void skills
  return ''
}

export function catalogCost(skills: ParsedSkill[]): Array<{ name: string; tokens: number }> {
  return skills.map((s) => ({ name: s.name, tokens: estimateTokens(s.name + s.description) }))
}
