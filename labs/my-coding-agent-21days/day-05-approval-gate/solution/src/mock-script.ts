/**
 * 今天的离线剧本。每天都会按当天要展示的现象重写这个文件，所以它不冻结。
 *
 * D5 要展示的是「三态规则各走一条分支」，所以剧本故意先走一条会被拒的路：
 *   跑测试（规则 allow，直接过）
 *   → 读代码（只读，直接过）
 *   → 改测试文件（规则 deny，被拒并回灌原因）
 *   → 改被测代码（没有规则命中，停下来问一句）
 *   → 再跑测试
 *   → 结论
 *
 * 「改测试让它变绿」是模型真实存在的偷懒倾向，所以它既是好教材也是好规则示例。
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
      text: '我先跑一遍测试。',
      toolCalls: [{ id: 'call_test_1', name: 'run_command', args: { command: 'node --test' } }],
    },
    {
      text: '除零那个用例失败了。我读一下实现。',
      toolCalls: [{ id: 'call_read_1', name: 'read_file', args: { path: 'src/calc.js' } }],
    },
    {
      text: '最快的办法是把那个用例改掉。',
      toolCalls: [
        {
          id: 'call_edit_test',
          name: 'edit_file',
          args: {
            path: 'test/calc.test.js',
            old_string: "test('divide by zero should throw', () => {",
            new_string: "test.skip('divide by zero should throw', () => {",
          },
        },
      ],
    },
    {
      text: '不能改测试，那就改被测代码——给 divide 加上除零保护。',
      toolCalls: [
        {
          id: 'call_edit_src',
          name: 'edit_file',
          args: { path: 'src/calc.js', old_string: OLD_DIVIDE, new_string: NEW_DIVIDE },
        },
      ],
    },
    {
      text: '再跑一次确认。',
      toolCalls: [{ id: 'call_test_2', name: 'run_command', args: { command: 'node --test' } }],
    },
    {
      text:
        '四个用例全绿。中间那次被拒是对的：改测试能让它变绿，但那不是修好了，' +
        '只是把验收标准调低了。',
    },
  ],
}

/** 演示「拒绝之后模型换只读路径」：被拒后它不再尝试写，而是把发现报告给用户 */
const DENIED_ONLY: MockScene = {
  name: 'denied-only',
  steps: [
    {
      text: '我把那个锁文件改一下。',
      toolCalls: [
        {
          id: 'call_edit_lock',
          name: 'edit_file',
          args: { path: 'pnpm-lock.yaml', old_string: 'a', new_string: 'b' },
        },
      ],
    },
    {
      text: '锁文件不许手改，那我只看不动：先确认它在不在。',
      toolCalls: [{ id: 'call_glob_lock', name: 'glob', args: { pattern: '*.yaml' } }],
    },
    {
      text: '沙盒里本来就没有锁文件。这件事需要你自己用包管理器来做，我不再尝试写它。',
    },
  ],
}

const SCENES: Array<{ match: RegExp; scene: MockScene }> = [
  { match: /锁文件|lock/i, scene: DENIED_ONLY },
  { match: /测试|修|test|绿/i, scene: FIX_TESTS },
]

export function pickScene(userText: string, _toolResults: number): MockScene {
  return SCENES.find((entry) => entry.match.test(userText))?.scene ?? FIX_TESTS
}
