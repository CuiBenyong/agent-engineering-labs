/**
 * 今天的离线剧本。每天按当天要展示的现象重写，所以它不冻结。
 *
 * D6 要展示六类故障各自走到哪条路，所以剧本本身也按 INJECT 分岔：
 * 每种注入配一段剧本，让「模型收到失败之后会怎么做」这件事看得见。
 *
 * 注意剧本只决定「模型说了什么、要调什么工具」，故障是别的层注入的：
 *   限流与断流在 providers/mock.ts（冻结）、参数非法也在那里（把 args 截断）
 *   工具失败在 tools/edit-file.ts、命令超时在 tools/command.ts
 * 这个分工是有意的：注入点写在它该发生的那一层，剧本只负责演出对应的反应。
 */
import type { MockScene } from './providers/mock.js'

const OLD_DIVIDE = `export function divide(a, b) {
  return a / b
}`

const NEW_DIVIDE = `export function divide(a, b) {
  if (b === 0) throw new Error('divide by zero')
  return a / b
}`

const FIX_DIVIDE = {
  id: 'call_edit_src',
  name: 'edit_file',
  args: { path: 'src/calc.js', old_string: OLD_DIVIDE, new_string: NEW_DIVIDE },
}
const RUN_TESTS = { id: 'call_test', name: 'run_command', args: { command: 'node --test' } }
const READ_CALC = { id: 'call_read', name: 'read_file', args: { path: 'src/calc.js' } }

/** 基准任务，没有注入时走这一条。也是 INJECT=rate_limit 时走的那一条（限流由网关层注入） */
const FIX_TESTS: MockScene = {
  name: 'fix-tests',
  steps: [
    { text: '我先跑一遍测试看现状。', toolCalls: [RUN_TESTS] },
    { text: '除零那个用例失败了，我读一下实现。', toolCalls: [READ_CALC] },
    { text: '给 divide 加上除零保护。', toolCalls: [FIX_DIVIDE] },
    { text: '再跑一次确认。', toolCalls: [{ ...RUN_TESTS, id: 'call_test_2' }] },
    { text: '四个用例全绿，修完了。' },
  ],
}

/** INJECT=tool_error：第一次写入失败，回灌之后原样重试一次就成了 */
const TOOL_ERROR: MockScene = {
  name: 'tool-error',
  steps: [
    { text: '我先跑一遍测试看现状。', toolCalls: [RUN_TESTS] },
    { text: '除零那个用例失败了，我读一下实现。', toolCalls: [READ_CALC] },
    { text: '给 divide 加上除零保护。', toolCalls: [FIX_DIVIDE] },
    {
      // 失败结果里写着「文件没有任何改动，请原样重试」，所以这一步就是原样重试
      text: '写入失败了，而且结果里说文件没有被改动，那就原样再试一次。',
      toolCalls: [{ ...FIX_DIVIDE, id: 'call_edit_src_retry' }],
    },
    { text: '这次写进去了，跑测试确认。', toolCalls: [{ ...RUN_TESTS, id: 'call_test_2' }] },
    { text: '全绿。写入失败属于「换个时机就好」的一类，所以原样重试是对的。' },
  ],
}

/**
 * INJECT=bad_args：网关把每一次的参数都截断成非法 JSON。
 * 这一段是故意让它自纠失败的——四次换工具、四次都发坏，最后向用户抬头。
 * 它证明的是另一件事：**回灌不是万能的，所以必须有硬上限兜底。**
 */
const BAD_ARGS: MockScene = {
  name: 'bad-args',
  steps: [
    { text: '先跑一下测试。', toolCalls: [RUN_TESTS] },
    { text: '参数好像没发全，我换成直接读文件。', toolCalls: [READ_CALC] },
    {
      text: '还是不行，我列一下文件。',
      toolCalls: [{ id: 'call_glob', name: 'glob', args: { pattern: '**/*.js' } }],
    },
    {
      text: '再搜一次看看。',
      toolCalls: [{ id: 'call_grep', name: 'grep', args: { pattern: 'divide' } }],
    },
    { text: '这几次的工具参数都发坏了，我先停下来告诉你，而不是继续试。' },
  ],
}

/**
 * INJECT=loop：一模一样的调用连发三次，第三次会被打转检测挡下来。
 * 三次的 id 是不同的（真实网关每次都会给新 id），参数原文完全相同——
 * 这正是打转检测的判据：比参数不比 id。
 */
const LOOPING: MockScene = {
  name: 'looping',
  steps: [
    { text: '我读一下实现。', toolCalls: [{ ...READ_CALC, id: 'call_read_1' }] },
    { text: '我再确认一下这个文件。', toolCalls: [{ ...READ_CALC, id: 'call_read_2' }] },
    { text: '再看一眼那段代码。', toolCalls: [{ ...READ_CALC, id: 'call_read_3' }] },
    { text: '你说得对，我已经用同样的参数读过三次了。结论是 divide 缺除零保护，加一个 if 就行。' },
  ],
}

/** INJECT=timeout：命令卡住被杀掉，结果里带着「把命令拆小」，模型据此选择不重试 */
const TIMEOUT: MockScene = {
  name: 'timeout',
  steps: [
    { text: '我跑一下测试。', toolCalls: [RUN_TESTS] },
    { text: '命令超时被杀掉了。同一条命令再跑一次只会再超时，所以我先把情况报给你。' },
  ],
}

/**
 * INJECT=truncated：流吐到第三片就断。
 * 第一步的文本故意写长，保证断点落在「已经吐过字」之后——这时候不许重试。
 */
const TRUNCATED: MockScene = {
  name: 'truncated',
  steps: [
    {
      text: '我来看一下这个仓库的结构，先跑测试确认失败的用例是哪一个，然后再读实现。',
      toolCalls: [RUN_TESTS],
    },
    { text: '接着修。' },
  ],
}

/** 演示取消：一条会跑很久的命令，用来验证按下取消之后子进程真的被杀掉 */
const LONG_COMMAND: MockScene = {
  name: 'long-command',
  steps: [
    {
      text: '这条命令要跑一会儿。',
      toolCalls: [
        {
          id: 'call_long',
          name: 'run_command',
          args: {
            // 里面那个 setTimeout 是安全阀：万一取消链路没写通，它自己十五秒后也会退，
            // 不至于在你机器上留一个永远转着的孤儿进程
            command:
              'node -e "setTimeout(() => process.exit(0), 15000); setInterval(() => {}, 500)"',
            timeout_ms: 10_000,
          },
        },
      ],
    },
    { text: '命令没跑完。' },
  ],
}

const inject = process.env.INJECT ?? ''

/** 按注入选剧本；rate_limit 不在表里，因为它要走基准任务那一条（重试成功之后一切照常） */
const BY_INJECT: Record<string, MockScene> = {
  tool_error: TOOL_ERROR,
  bad_args: BAD_ARGS,
  loop: LOOPING,
  timeout: TIMEOUT,
  truncated: TRUNCATED,
}

export function pickScene(userText: string, _toolResults: number): MockScene {
  const injected = BY_INJECT[inject]
  if (injected) return injected
  if (/长命令|卡住|不要停/.test(userText)) return LONG_COMMAND
  return FIX_TESTS
}
