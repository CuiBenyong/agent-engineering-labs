export type Case = {
  query: string
  /** true = 应该触发被测 skill；false = 不该触发 */
  shouldTrigger: boolean
  split: 'train' | 'validation'
  /**
   * 这条查询表达的意图信号。**只有离线模拟用得到它**：
   * MOCK=1 时用它跟各个 skill 的描述做匹配，模拟模型在发现阶段的选择。
   * 去掉 MOCK=1 走真模型时，这一栏完全不参与判定。
   */
  signals: string[]
  /** 给人看的标注，说明这一条在测什么 */
  note: string
}

/**
 * 14 条带标注查询：7 正 7 负，按大约六比四拆成训练集（8 条）与验证集（6 条）。
 * 两个集合的正负比例都接近 1 比 1，拆完就固定，不要每轮重洗。
 */
export const CASES: Case[] = [
  // ---- 训练集：只有它的失败项可以指导你改描述 ----
  {
    query: '帮我按规范写一下这次的提交信息',
    shouldTrigger: true,
    split: 'train',
    signals: ['提交信息', '规范'],
    note: '正例·术语说法，最容易命中的一条',
  },
  {
    query: '这几个文件我要提交了',
    shouldTrigger: true,
    split: 'train',
    signals: ['准备提交', '暂存区'],
    note: '正例·纯口语，不含任何专业词',
  },
  {
    query: 'commit message 怎么写比较好',
    shouldTrigger: true,
    split: 'train',
    signals: ['commit message'],
    note: '正例·中英混排',
  },
  {
    query: '刚改完 src/order 下面这几个文件，顺手把改动说明也写了吧',
    shouldTrigger: true,
    split: 'train',
    signals: ['提交代码', '起个说明'],
    note: '正例·长上下文，需求埋在一串背景里',
  },
  {
    query: '这次改动该不该现在提交',
    shouldTrigger: false,
    split: 'train',
    signals: ['提交', '改动'],
    note: '近似负例·共享提交与改动，但目标动词是决策不是生成',
  },
  {
    query: '帮我把这份 CSV 转成 JSON',
    shouldTrigger: false,
    split: 'train',
    signals: ['CSV'],
    note: '近似负例·该被 csv-check 接走',
  },
  {
    query: '这次版本改了哪些接口，帮我发个公告出去',
    shouldTrigger: false,
    split: 'train',
    signals: ['公告', '改了'],
    note: '近似负例·该被 release-notes 接走',
  },
  {
    query: '把这个函数重构一下，太长了',
    shouldTrigger: false,
    split: 'train',
    signals: ['重构'],
    note: '负例·纯代码修改请求',
  },

  // ---- 验证集：全程不参与改写决策，只用来挑最终选哪一版 ----
  {
    query: '这次改动该怎么描述',
    shouldTrigger: true,
    split: 'validation',
    signals: ['起个说明', '改动'],
    note: '正例·口语，措辞与训练集那条口语不同',
  },
  {
    query: '暂存区里的东西我想提上去，帮我起个说明',
    shouldTrigger: true,
    split: 'validation',
    signals: ['暂存区', '起个说明'],
    note: '正例·换了一套完全不同的说法',
  },
  {
    query: '写个 commit',
    shouldTrigger: true,
    split: 'validation',
    signals: ['commit message'],
    note: '正例·极短，只有三个字',
  },
  {
    query: '帮我看看这个提交历史里哪几次是重复的',
    shouldTrigger: false,
    split: 'validation',
    signals: ['提交'],
    note: '近似负例·共享提交，但目标是分析历史，最考验边界句',
  },
  {
    query: '这份表格的表头对不对',
    shouldTrigger: false,
    split: 'validation',
    signals: ['表头', 'CSV'],
    note: '负例·该被 csv-check 接走',
  },
  {
    query: '解释一下 git rebase 和 merge 的区别',
    shouldTrigger: false,
    split: 'validation',
    signals: ['rebase'],
    note: '负例·同属 Git 领域但完全是另一件事',
  },
]
