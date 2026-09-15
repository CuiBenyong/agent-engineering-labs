/**
 * 今天的离线剧本。每天都会按当天要展示的现象重写这个文件，所以它不冻结。
 *
 * D2 只演示流式渲染，所以剧本里没有工具调用，但有一段足够长的文本——
 * 短文本切不出几片，看不出打字机的效果。
 */
import type { MockScene } from './providers/mock.js'

const LONG_ANSWER =
  '流式不是体验糖，它解决的是首字延迟。模型在开口之前可能要先想很久，' +
  '如果你等一整段生成完再打印，这段时间对用户就是一片静默的黑屏。' +
  '把响应改成一片片到达、一片片渲染，用户在第二秒就能看到字在动，' +
  '而总耗时一点没变。这就是今天要做的全部事情：解析、翻译、渲染，三层各管一段。'

/**
 * 带围栏代码块的一段回答。它的作用是把渲染层最难的那种输入喂进来：
 * ``` 这三个反引号会被切在不同分片里，中间那一帧只有 `` ——
 * 渲染器要是这时候就按行内代码上色，屏幕会闪一下再变回去。
 */
const ANSWER_WITH_CODE =
  '按空行切事件是关键，一条事件可以有多行 `data`。最小的解析器长这样：\n' +
  '```ts\n' +
  'buffer += decoder.decode(chunk, { stream: true })\n' +
  'const boundary = buffer.indexOf("\\n\\n")\n' +
  '```\n' +
  '注意 **半行报文** 要留到下一块再拼，否则你会丢掉分片边界上的那几个字。'

const SCENES: Array<{ match: RegExp; scene: MockScene }> = [
  {
    match: /代码块|code block|解析器/i,
    scene: { name: 'codeblock', steps: [{ text: ANSWER_WITH_CODE }] },
  },
  {
    match: /流式|streaming|首字/i,
    scene: { name: 'streaming', steps: [{ text: LONG_ANSWER }] },
  },
  {
    match: /你是谁|who are you/i,
    scene: {
      name: 'identity',
      steps: [
        {
          text:
            '我是 mca，一个正在被你亲手造出来的终端 Coding Agent。' +
            '今天我学会了边想边说：你看到的每几个字都是刚到达的一片。',
        },
      ],
    },
  },
]

const FALLBACK: MockScene = {
  name: 'fallback',
  steps: [{ text: LONG_ANSWER }],
}

export function pickScene(userText: string, _toolResults: number): MockScene {
  return SCENES.find((entry) => entry.match.test(userText))?.scene ?? FALLBACK
}
