/**
 * 今天的离线剧本。每天都会按当天要展示的现象重写这个文件，所以它不冻结。
 *
 * D4 是全课第一次真的改代码，所以剧本走完一条完整的闭环：
 *   跑测试（红）→ 读代码 → 精确替换 → 再跑测试（绿）→ 给结论
 *
 * 这条闭环之后每天都会复用（D6 演示自纠、D7 演示恢复、D14 演示回滚），
 * 所以它的每一步都必须是真的：真的起子进程跑 node --test，真的把文件写回磁盘。
 */
import type { MockScene } from './providers/mock.js'

const OLD_DIVIDE = `export function divide(a, b) {
  return a / b
}`

const NEW_DIVIDE = `export function divide(a, b) {
  if (b === 0) throw new Error('divide by zero')
  return a / b
}`

const FIX_TESTS: MockScene = {
  name: 'fix-tests',
  steps: [
    {
      text: '我先跑一遍测试，看哪个用例是红的。',
      toolCalls: [{ id: 'call_test_1', name: 'run_command', args: { command: 'node --test' } }],
    },
    {
      text: '除零那个用例失败了。我读一下 divide 的实现。',
      toolCalls: [{ id: 'call_read_1', name: 'read_file', args: { path: 'src/calc.js' } }],
    },
    {
      text: 'divide 直接返回 a 除以 b，除数为 0 时会安静地返回 Infinity。我给它加上除零保护。',
      toolCalls: [
        {
          id: 'call_edit_1',
          name: 'edit_file',
          args: { path: 'src/calc.js', old_string: OLD_DIVIDE, new_string: NEW_DIVIDE },
        },
      ],
    },
    {
      text: '改完了，再跑一次测试确认。',
      toolCalls: [{ id: 'call_test_2', name: 'run_command', args: { command: 'node --test' } }],
    },
    {
      text:
        '四个用例全绿了。改动只有一处：divide 在除数为 0 时抛错，' +
        '其余行为没动，所以另外三个用例不受影响。',
    },
  ],
}

/** 演示编辑失败：old_string 与文件里的内容不一致（少了一个空格） */
const STALE_EDIT: MockScene = {
  name: 'stale-edit',
  steps: [
    {
      text: '我直接把除零保护加上。',
      toolCalls: [
        {
          id: 'call_edit_stale',
          name: 'edit_file',
          args: {
            path: 'src/calc.js',
            old_string: 'export function divide(a,b) {\n  return a / b\n}',
            new_string: NEW_DIVIDE,
          },
        },
      ],
    },
    {
      text: '找不到那段内容，看来我记错了原文。先读一遍再改。',
      toolCalls: [{ id: 'call_read_2', name: 'read_file', args: { path: 'src/calc.js' } }],
    },
    {
      text: '原来参数之间有个空格。这次按读到的原文改。',
      toolCalls: [
        {
          id: 'call_edit_retry',
          name: 'edit_file',
          args: { path: 'src/calc.js', old_string: OLD_DIVIDE, new_string: NEW_DIVIDE },
        },
      ],
    },
    { text: '这次改成功了：失败的原因是原文对不上，工具没有猜，也没有动文件。' },
  ],
}

/** 演示输出上限与长命令：让它打一大堆东西出来 */
const NOISY: MockScene = {
  name: 'noisy',
  steps: [
    {
      text: '我跑一条输出很多的命令。',
      toolCalls: [
        {
          id: 'call_noisy',
          name: 'run_command',
          args: {
            command: 'node -e "for (let i = 0; i < 20000; i++) console.log(\'line\', i)"',
          },
        },
      ],
    },
    {
      text: '输出被截断了，只回灌了前面一段——这正是我们要的：命令的输出不该由它决定花多少 token。',
    },
  ],
}

const SCENES: Array<{ match: RegExp; scene: MockScene }> = [
  { match: /输出很多|噪音|截断/i, scene: NOISY },
  { match: /直接改|不读就改|对不上/i, scene: STALE_EDIT },
  { match: /测试|修|test|绿/i, scene: FIX_TESTS },
]

export function pickScene(userText: string, _toolResults: number): MockScene {
  return SCENES.find((entry) => entry.match.test(userText))?.scene ?? FIX_TESTS
}
