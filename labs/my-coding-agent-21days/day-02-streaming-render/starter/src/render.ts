/**
 * 终端渲染层（D2 正式版）。它只订阅 AgentEvent，完全不知道 SSE 与网关报文的存在。
 *
 * D1 的版本是「攒完再打」：等一轮结束才把整段文本一次性输出。今天换成真正的
 * 增量渲染，三个要处理的问题都写在下面：
 *
 *   1. 一行文本会跨很多个分片到达，所以「行」是渲染的最小定型单位，
 *      未完成的行只能先按原样显示，等换行符到达才定型（styleInline）。
 *   2. 围栏代码块的 ``` 自己也会被切开：只收到 `` 的时候不能按行内代码渲染，
 *      否则屏幕会闪一下再变回去（looksUnsettled 就是干这个的）。
 *   3. 管道里没有光标。真终端用「回到行首 + 清行 + 重画」做打字机；
 *      非 TTY（CI、管道、别的 Agent 的 shell）退化成纯追加，不发任何光标控制符。
 */
import type { AgentEvent } from './kernel/types.js'

const RESET = '\u001b[0m'
const DIM = '\u001b[2m'
const BOLD = '\u001b[1m'
const CYAN = '\u001b[36m'
/** 回到行首并清掉整行：打字机重画的唯一手段 */
const CLEAR_LINE = '\r\u001b[2K'

/**
 * 这一行还可能被后续字符改变含义吗？
 *
 * 只要还可能变，就先按原样显示，不套任何样式。三种「还会变」的情况：
 *   - 只收到一两个反引号：它可能长成行内代码，也可能长成围栏
 *   - 反引号个数是奇数：行内代码还没闭合
 *   - 结尾停在星号上：加粗标记还没闭合
 */
export function looksUnsettled(line: string): boolean {
  // TODO(1)：判断这一行是否「还可能变」。三种要返回 true 的情况：
  //   - trimStart 之后整行只有一到两个反引号（它可能长成 ``` 围栏）
  //   - 整行的反引号个数是奇数（行内代码没闭合）
  //   - 行尾停在一到两个星号上（加粗没闭合）
  // 提示：现在这个默认值会让未完成的 `` 立刻被当成行内代码，
  // 你会在自检的第 4 项看到「误上色」的帧数不是 0。
  void line
  return false
}

/** 一行定型之后才上样式。故意只支持三种标记：标题、行内代码、加粗 */
export function styleInline(line: string): string {
  if (/^#{1,6}\s/.test(line)) return `${BOLD}${line}${RESET}`
  return line
    .replace(/`([^`]+)`/g, `${CYAN}$1${RESET}`)
    .replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${RESET}`)
}

/** 一行是围栏吗（``` 或 ```ts） */
export function isFence(line: string): boolean {
  return /^\s*```/.test(line)
}

/**
 * 增量 Markdown 渲染器。喂进来的是任意长度的文本片，吐出去的是终端字节。
 * 它自己不认识 SSE、不认识事件，只认识「又来了几个字符」。
 */
export class MarkdownStream {
  private line = ''
  private codeBlocks = 0
  private inCode = false

  constructor(
    private readonly write: (chunk: string) => void,
    /** 真终端才做光标控制；管道里纯追加 */
    private readonly tty: boolean
  ) {}

  push(delta: string): void {
    for (const ch of delta) {
      if (ch === '\n') {
        this.commitLine()
      } else {
        this.line += ch
        // 非 TTY 没有光标，只能来一个字符写一个字符——这也是「增量」，只是没有样式
        if (!this.tty) this.write(ch)
      }
    }
    if (this.tty) this.redraw()
  }

  /** 一轮结束：把最后一行（可能没有换行符）定型 */
  end(): void {
    if (this.line) this.commitLine()
  }

  get stats(): { codeBlocks: number; inCode: boolean } {
    return { codeBlocks: this.codeBlocks, inCode: this.inCode }
  }

  /** 未定型的当前行：重画一次。样式要等定型，所以这里可能是原样文本 */
  private redraw(): void {
    const body = this.inCode || looksUnsettled(this.line) ? this.line : styleInline(this.line)
    this.write(`${CLEAR_LINE}${this.inCode ? DIM + body + RESET : body}`)
  }

  private commitLine(): void {
    const line = this.line
    this.line = ''

    // TODO(2)：处理围栏行（isFence 为真）。要做三件事：
    //   - 进入代码块时把 codeBlocks 加一（自检要断言代码块个数）
    //   - 翻转 inCode
    //   - 围栏行本身用 DIM 输出，然后 return，不要再走下面的行内样式
    // 提示：漏掉这一段的后果不是报错，是代码块里的星号和反引号被当成 Markdown 渲染。
    if (isFence(line)) {
      this.emitLine(line)
      return
    }
    this.emitLine(this.inCode ? `${DIM}${line}${RESET}` : styleInline(line))
  }

  private emitLine(styled: string): void {
    // TTY：清掉刚才那半行的重画结果，用定型版本覆盖。非 TTY：字符已经追加过了，只补换行
    this.write(this.tty ? `${CLEAR_LINE}${styled}\n` : '\n')
  }
}

export interface RenderSummary {
  /** 所有 text 增量拼接起来的真值，用来验证渲染没丢字 */
  text: string
  deltas: number
  firstDeltaMs: number | null
  totalMs: number
  codeBlocks: number
  /** 被用户打断了 */
  interrupted: boolean
  /** 出错了：这里存的是给人看的一句话，不是堆栈 */
  error: string | null
}

/**
 * 把一轮 AgentEvent 渲染到终端。
 *
 * 注意它对每种事件的处理都很短——因为渲染层的职责就只有「把语义翻成屏幕上的字」。
 * 一旦这里出现了 if (delta.choices...) 这种东西，说明网关的报文格式漏进来了。
 */
export async function renderTurn(
  events: AsyncIterable<AgentEvent>,
  out: (chunk: string) => void,
  options: { tty?: boolean } = {}
): Promise<RenderSummary> {
  const tty = options.tty ?? Boolean(process.stdout.isTTY)
  const stream = new MarkdownStream(out, tty)
  const startedAt = Date.now()

  let text = ''
  let deltas = 0
  let firstDeltaMs: number | null = null
  let usageLine = ''
  let interrupted = false
  let error: string | null = null

  for await (const event of events) {
    switch (event.type) {
      case 'text':
        deltas += 1
        firstDeltaMs ??= Date.now() - startedAt
        text += event.delta
        stream.push(event.delta)
        break
      case 'usage':
        usageLine = `输入 ${event.promptTokens} token，输出 ${event.completionTokens} token`
        break
      case 'error':
        error = event.message
        break
      case 'done':
        if (event.reason === 'aborted') interrupted = true
        break
      case 'tool_start':
      case 'tool_end':
        break
    }
  }
  stream.end()

  // 收尾顺序很重要：先把已经收到的文本定型，再补一行说明发生了什么。
  // 断流与打断都不该把已经生成的内容丢掉——用户看过的东西不能凭空消失。
  // TODO(4)：收尾。error 与 interrupted 各补一行说明，让用户知道刚才发生了什么。
  //   - error：把 event.message 那句人话打出来，并说明上面收到的部分保留了
  //   - interrupted：说明已打断，以及保住了多少个字符
  // 提示：现在什么都不打印，于是断流和正常结束在屏幕上长得一模一样——
  // 自检第 6 项起的子进程会因为找不到「流在中途断开」而亮叉。
  void error
  void interrupted

  const totalMs = Date.now() - startedAt
  const stats = [
    `${deltas} 个分片`,
    firstDeltaMs === null ? '无首字' : `首字 ${firstDeltaMs}ms`,
    `总计 ${totalMs}ms`,
    usageLine,
  ]
    .filter(Boolean)
    .join(' · ')
  out(`${DIM}（${stats}）${RESET}\n`)

  return {
    text,
    deltas,
    firstDeltaMs,
    totalMs,
    codeBlocks: stream.stats.codeBlocks,
    interrupted,
    error,
  }
}
