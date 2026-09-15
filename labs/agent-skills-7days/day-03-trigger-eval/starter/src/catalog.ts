/** 被测 skill 与两个「陪跑」skill 的元数据。 */
export type SkillMeta = { name: string; description: string }

/** 被测 skill 的名字。判定命中与否，就是看模型有没有选中这个名字。 */
export const TARGET = 'commit-message'

/**
 * 两版描述。v1 只写了术语说法；v2 按训练集的失败项改过：
 * 补了日常说法这一「类」（不是把失败查询原话抄进来），并在末尾加了一句边界。
 */
export const DESCRIPTIONS: Record<string, string> = {
  v1: '按团队规范生成 Conventional Commits 格式的提交信息。当用户要写 commit message 或提交信息时使用。',
  v2:
    '按团队规范写 Git 提交信息。当用户要提交代码、写 commit message、整理暂存区的改动，' +
    '或者用日常说法表示这批文件准备提交、想给这次改动起个说明时使用，即使他没有提到规范或格式。' +
    '只负责生成提交描述文本，不负责决定该不该提交、不执行 git 命令、也不评价代码本身。',
}

/**
 * 陪跑 skill。没有它们，负例就没有「被别人接走」的可能，
 * 近似负例也就测不出边界——这是第一次做触发测试时最容易漏掉的一步。
 */
export const DECOYS: SkillMeta[] = [
  {
    name: 'csv-check',
    description:
      '校验一份 CSV 的表头与列类型是否符合约定。当用户要导入 CSV、检查数据文件、或者问这个表格能不能用时使用。',
  },
  {
    name: 'release-notes',
    description:
      '把一份接口变更说明整理成发布公告。当用户要写发布说明、changelog、版本公告时使用；只整理已有条目，不判断该不该发布。',
  },
]

/** 把被测描述与陪跑拼成客户端在发现阶段看到的那份目录。 */
export function buildCatalog(version: string): SkillMeta[] {
  return [{ name: TARGET, description: DESCRIPTIONS[version] ?? '' }, ...DECOYS]
}
