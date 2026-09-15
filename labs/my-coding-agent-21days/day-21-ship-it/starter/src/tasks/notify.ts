/**
 * 通知队列。本天新增，也是今天第二难的那件事（第一难是否决语义）。
 *
 * 难在哪：**REPL 是一个单线程的终端，而后台任务会在任意时刻说话。**
 * 一个终端在任何时刻只可能处于三种状态之一，三种状态能不能插话完全不同：
 *
 *   ① 正在流式输出       绝对不能插。打字机效果是一个字一个字往同一行写的，
 *                        中间插一行会把那段话撕成两半，而且 Markdown 的增量
 *                        渲染状态（在不在代码块里）也会跟着乱掉。
 *   ② 正在等审批 / 提问   不能插。用户正盯着一个问题准备回答，这时候冒一行
 *                        「任务完成」，他多半会把它当成问题的一部分。
 *   ③ 正在等用户输入      **可以插，但有条件**：只有输入行是空的时候才行。
 *                        用户已经敲了半行字的话，插一行就会把他敲的东西冲掉——
 *                        终端里没有「把用户没打完的字先存起来」这回事。
 *
 * 所以这个队列的默认动作是**攒着**，只在两个安全时刻放出来：提示符即将重新出现之前，
 * 以及「正在等输入且输入行是空的」这一刻。这就是「不打断对话」的全部含义——
 * 它不是「更礼貌地打印」，是**把打印时机挪到一个终端状态允许的地方**。
 */
export interface Notice {
  taskId: string
  text: string
}

/** 消费端（REPL）提供的三件事：往哪打、怎么重画提示符、现在能不能插话 */
export interface NoticeSink {
  out(line: string): void
  redraw(): void
  canInterrupt(): boolean
}

export class NoticeQueue {
  private readonly pending: Notice[] = []
  /** 要在下一轮告诉模型的那几条。它和给人看的那几条是两条独立的路 */
  private readonly forModel: Notice[] = []
  private sink: NoticeSink | null = null

  attach(sink: NoticeSink): void {
    this.sink = sink
  }

  push(notice: Notice): void {
    this.forModel.push(notice)
    // 能插话就当场打，插完把提示符重画回来；不能就攒着
    if (this.sink?.canInterrupt()) {
      this.sink.out(`\n${notice.text}`)
      this.sink.redraw()
      return
    }
    this.pending.push(notice)
  }

  /** 在安全时刻倒出来。返回倒了几条，方便自检断言「攒住了」而不是「丢了」 */
  flush(out: (line: string) => void): number {
    const count = this.pending.length
    while (this.pending.length > 0) out(this.pending.shift()?.text ?? '')
    return count
  }

  /**
   * 取出要告诉模型的那几条，取完就清。
   *
   * **给人看和给模型看必须分开攒**：人看到的那条已经打在屏幕上了，可屏幕上的字
   * 不在消息数组里，模型看不见。少了这一条，用户会遇到一个很别扭的现象——
   * 他明明看到「任务完成」，一问模型却说「还在跑」。
   */
  drainForModel(): string {
    if (this.forModel.length === 0) return ''
    const rows = this.forModel.splice(0, this.forModel.length).map((notice) => notice.text)
    return `后台任务的最新状态（系统自动附上，不是用户说的）：\n${rows.join('\n')}`
  }

  get size(): number {
    return this.pending.length
  }
}
