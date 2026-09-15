/**
 * 今天的离线剧本。每天都会按当天要展示的现象重写这个文件，所以它不冻结。
 *
 * D3 要展示的是「模型自己用三个只读工具读懂一个陌生仓库」，所以剧本按步走：
 *   第 0 步：先 glob 看有哪些文件
 *   第 1 步：拿到文件清单后 grep 找那个可疑的函数
 *   第 2 步：拿到行号后 read_file 看上下文
 *   第 3 步：给结论
 *
 * 步号取自「已有的工具结果条数」而不是轮数——这样注入故障（比如 bad_args 让一次
 * 调用失败）之后，剧本仍然停在正确的那一步，不会错位。
 */
import type { MockScene } from './providers/mock.js'

const EXPLORE: MockScene = {
  name: 'explore',
  steps: [
    {
      text: '我先看看这个仓库里有哪些文件。',
      toolCalls: [{ id: 'call_glob_1', name: 'glob', args: { pattern: '**/*.js' } }],
    },
    {
      text: '看到 src 与 test 两个目录。我找一下除法相关的函数。',
      toolCalls: [
        { id: 'call_grep_1', name: 'grep', args: { pattern: 'divide', glob: '**/*.js' } },
      ],
    },
    {
      text: '命中在 src/calc.js 与测试里。我读一下实现。',
      toolCalls: [{ id: 'call_read_1', name: 'read_file', args: { path: 'src/calc.js' } }],
    },
    {
      text:
        '看懂了：divide 直接返回 a 除以 b，除数为 0 时会安静地返回 Infinity，' +
        '而测试要求它抛错，所以那个用例是红的。今天我只有读权限，改不了——' +
        '明天拿到编辑与命令工具之后再动手。',
    },
  ],
}

/** 演示结果截断：读一个故意生成的大文件 */
const BIG_FILE: MockScene = {
  name: 'bigfile',
  steps: [
    {
      text: '我读一下那个生成出来的大文件。',
      toolCalls: [
        { id: 'call_read_big', name: 'read_file', args: { path: 'src/generated.js', limit: 9999 } },
      ],
    },
    {
      text: '结果太大被截断了，中间那段没给我。要看中间就得带 offset 再读一次。',
    },
  ],
}

/** 演示工具名不存在：模型编了一个工具 */
const UNKNOWN_TOOL: MockScene = {
  name: 'unknown',
  steps: [
    {
      text: '我试试直接改文件。',
      toolCalls: [
        { id: 'call_edit_1', name: 'edit_file', args: { path: 'src/calc.js', old: 'a / b' } },
      ],
    },
    {
      text: '原来今天还没有编辑工具，只有三个只读的。那我先把代码读明白。',
      toolCalls: [{ id: 'call_read_2', name: 'read_file', args: { path: 'src/calc.js' } }],
    },
    { text: '读完了，问题在 divide 缺少除零保护。' },
  ],
}

const SCENES: Array<{ match: RegExp; scene: MockScene }> = [
  { match: /大文件|截断|generated/i, scene: BIG_FILE },
  { match: /改一下|改文件|修/i, scene: UNKNOWN_TOOL },
  { match: /仓库|看看|读懂|divide|测试/i, scene: EXPLORE },
]

export function pickScene(userText: string, _toolResults: number): MockScene {
  return SCENES.find((entry) => entry.match.test(userText))?.scene ?? EXPLORE
}
