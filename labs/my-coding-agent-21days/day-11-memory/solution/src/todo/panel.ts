/**
 * 把清单画在终端的固定区域里。本天新增，也是今天最容易写坏的一段。
 *
 * 问题的形状：一个终端只有一条光标，而现在有两个东西要用它——**流式文本一直在往下长，
 * 清单要待在一个不动的地方。** 直接 write 一行清单，它会被下一片文本挤上去，
 * 半秒之后屏幕上就是十几张不同版本的清单。
 *
 * 本课的做法（面板在底部，四个动作）：
 *
 *   show()   保存光标位置 → 换行 → 画清单。光标停在清单末尾
 *   hide()   恢复到保存的位置 → 清掉从这里到屏幕末尾的一切。清单没了，正文那半行还在
 *   写正文   夹在 hide() 与 show() 之间，于是每一片文本落地时清单都不在场
 *   redraw   清单变了就 hide + show 一次，位置不变、内容换新
 *
 * 为什么放底部而不是顶部：顶部要算「正文已经滚了多少行」，而正文会自动换行，
 * 行数由终端宽度决定——你得知道用户的窗口有多宽，还得处理他中途拉窗口。
 * **底部只需要知道清单自己有几行**，这是唯一一个你真的知道的数字。
 *
 * 非 TTY（管道、CI、别的 Agent 的 shell）没有光标可用，退化成「变了就整块打一遍」。
 * 这条退化和第二天的打字机是同一个口径：**没有光标就不发光标控制符**，
 * 而不是发出去让它变成一串乱码。
 */
import { STATUS_MARK, STATUS_LABEL, type TodoList } from './list.js'

const DIM = '\u001b[2m'
const BOLD = '\u001b[1m'
const RESET = '\u001b[0m'
/** DEC 的保存 / 恢复光标。只有一个槽位，所以同一时刻只能有一个面板 */
const SAVE = '\u001b[s'
const RESTORE = '\u001b[u'
/** 从光标处清到屏幕末尾 */
const CLEAR_BELOW = '\u001b[0J'

/** 面板的纯文本行。抽成函数是为了让自检能直接断言，不必去读终端字节 */
export function renderRows(list: TodoList): string[] {
  const items = list.all
  if (items.length === 0) return []
  const counts = list.counts
  const rows = [`─ 任务清单 ${counts.done}/${items.length} 已完成 ─`]
  for (const item of items) {
    const line = `${STATUS_MARK[item.status]} ${item.text}`
    rows.push(item.status === 'in_progress' ? `${line}  ← ${STATUS_LABEL[item.status]}` : line)
  }
  return rows
}

export class TodoPanel {
  private visible = false

  constructor(
    private readonly list: TodoList,
    private readonly write: (chunk: string) => void,
    private readonly tty: boolean
  ) {}

  /** 画出来。非 TTY 下这就是「整块打一遍」 */
  show(): void {
    const rows = renderRows(this.list)
    if (rows.length === 0) return
    if (!this.tty) {
      this.write(`${rows.join('\n')}\n`)
      return
    }
    this.write(`${SAVE}\n${DIM}${rows[0]}${RESET}\n`)
    for (const row of rows.slice(1)) {
      this.write(row.includes('←') ? `${BOLD}${row}${RESET}\n` : `${DIM}${row}${RESET}\n`)
    }
    this.visible = true
  }

  /** 擦掉。非 TTY 下什么都不做——已经打出去的字擦不回来，这是事实不是缺陷 */
  hide(): void {
    if (!this.tty || !this.visible) return
    this.write(`${RESTORE}${CLEAR_BELOW}`)
    this.visible = false
  }

  /** 内容变了：擦掉旧的，画新的。位置不动 */
  redraw(): void {
    this.hide()
    this.show()
  }

  /**
   * 包一层写入函数：任何一次正文输出都夹在 hide 与 show 之间。
   *
   * 这一层是整个面板能成立的关键。渲染层完全不知道有面板这回事——
   * 它拿到的只是一个「写字符串」的函数，和第二天一样。
   */
  wrap(out: (chunk: string) => void): (chunk: string) => void {
    if (!this.tty) return out
    return (chunk: string) => {
      this.hide()
      out(chunk)
      this.show()
    }
  }
}
