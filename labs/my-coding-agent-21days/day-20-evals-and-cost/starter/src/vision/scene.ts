/**
 * 今天那一场离线剧本：照着一张界面截图改文案。本天新增。
 *
 * 为什么它不在 mock-script.ts 里：那个文件到第十八天已经贴着本课 350 行的单文件上限，
 * 而今天这一场连注释三十多行。**文件到了上限就拆**，是这门课从第六天起的纪律。
 *
 * 这一场要展示的现象只有一个，但它是今天的招牌：**贴一张图进去，仓库里的代码真的被改了。**
 *
 * 必须说清楚的一句：**离线剧本里"模型看见了什么"是写死的台词。** 我们没法让一段剧本
 * 真的去看图。今天可复现的是图两侧的链路——嗅探、校验、base64 编码、进 content 数组、
 * 在日志与摘要里被摘掉；不可复现的是模型的视力，那要用真实 key 跑一次 /vision probe。
 */
import type { MockScene } from '../providers/mock.js'

const OLD_SUBMIT = "  submit: '提交',"
const NEW_SUBMIT = "  submit: '保存并提交',"

/**
 * 照着一张界面截图改文案。
 *
 * 第一步刻意是 read_file 而不是直接 edit_file：照图改代码最容易出的错，
 * 是模型按图里的样子**重写**整个文件，把图上看不见的东西一起改掉。
 * 先读原文、再精确替换，改动范围才由原文决定，而不是由那张图决定。
 */
export const SHOT_FLOW: MockScene = {
  name: 'shot-flow',
  steps: [
    {
      text: '截图收到了：顶上一条标题栏，中间是主按钮。我先看看这份文案在代码里怎么写的。',
      toolCalls: [{ id: 'call_shot_read', name: 'read_file', args: { path: 'src/ui.js' } }],
    },
    {
      text: '按截图里主按钮的写法，把 submit 的文案改掉，其余一个字不动。',
      toolCalls: [
        {
          id: 'call_shot_edit',
          name: 'edit_file',
          args: { path: 'src/ui.js', old_string: OLD_SUBMIT, new_string: NEW_SUBMIT },
        },
      ],
    },
    {
      text: '改完了：src/ui.js 里 submit 的文案从「提交」改成「保存并提交」，cancel 没动。',
    },
  ],
}
