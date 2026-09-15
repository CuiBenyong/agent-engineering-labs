/**
 * 任务清单的数据模型。本天新增。
 *
 * 三个决定，每一个都是「少即是多」：
 *
 * 一、**状态只有三种**：待做、进行中、已完成。多了模型就乱——它会开始纠结
 *    「阻塞」和「待做」的区别，而这个纠结要花 token，还会让它把一条卡住的任务
 *    标成阻塞然后就此绕过去。三种状态里没有「放弃」的位置，这是故意的：
 *    做不了的事要说出来，不是悄悄改个状态。
 *
 * 二、**一次只允许一个进行中。** 这条约束比在提示词里写「请专注」管用得多，
 *    因为它是硬的：违规的整表会被拒绝并回灌一条纠正，模型下一轮就改对了。
 *    为什么这条值得用一个不变量来保证——一个 Agent 同时「进行中」三件事，
 *    实际表现是三件都做了一点点、一件都没做完，而清单上看起来很忙。
 *
 * 三、**清单是易失的，不落盘。** 它是这一次任务的工作面，不是事实（那是记忆，
 *    第十一天）也不是过程（那是会话日志，第七天）。任务结束清单就没有意义了，
 *    存下来只会让下一次对话看到一份过期的待办。
 */

export const TODO_STATUSES = ['pending', 'in_progress', 'done'] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]

export const STATUS_LABEL: Record<TodoStatus, string> = {
  pending: '待做',
  in_progress: '进行中',
  done: '已完成',
}

export const STATUS_MARK: Record<TodoStatus, string> = {
  pending: '☐',
  in_progress: '▶',
  done: '☑',
}

export interface TodoItem {
  id: string
  text: string
  status: TodoStatus
}

/** 一次写入的结果。失败时 note 就是要回灌给模型的纠正 */
export interface TodoWrite {
  ok: boolean
  note: string
  /** 这次写入实际改动了几项（整表替换时算新增 + 状态变化） */
  changed: number
}

export function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === 'string' && (TODO_STATUSES as readonly string[]).includes(value)
}

/**
 * 清单本体。
 *
 * revision 是这个类里最不显眼但最重要的字段：**它是「有没有进展」的唯一度量。**
 * 第六天的打转检测看的是「有没有重复调用」，那会漏掉「每次调用都稍有不同但一直在原地」；
 * 而 revision 多少轮没有变化，是一个跟具体工具无关的停滞信号。stall.ts 只读它。
 */
export class TodoList {
  private items: TodoItem[] = []
  private version = 0
  /** 已完成又被重新打开的次数，按任务 id 记。同一条反复重开是另一种打转 */
  private readonly reopened = new Map<string, number>()

  get revision(): number {
    return this.version
  }

  get all(): TodoItem[] {
    return this.items.map((item) => ({ ...item }))
  }

  get active(): TodoItem | undefined {
    const found = this.items.find((item) => item.status === 'in_progress')
    return found ? { ...found } : undefined
  }

  /** 某一条被重开过几次 */
  reopenCount(id: string): number {
    return this.reopened.get(id) ?? 0
  }

  get maxReopen(): number {
    let max = 0
    for (const count of this.reopened.values()) max = Math.max(max, count)
    return max
  }

  get counts(): Record<TodoStatus, number> {
    const counts: Record<TodoStatus, number> = { pending: 0, in_progress: 0, done: 0 }
    for (const item of this.items) counts[item.status] += 1
    return counts
  }

  /**
   * 整表替换。适合「我重新想了一遍，计划长这样」。
   *
   * 校验放在这里而不是工具里，是因为不变量属于数据，不属于调用方：
   * 第十三天的计划模式也会写这份清单，它不该再抄一遍校验。
   */
  replace(next: Array<{ id?: string; text: string; status: TodoStatus }>): TodoWrite {
    const running = next.filter((item) => item.status === 'in_progress')
    if (running.length > 1) {
      return {
        ok: false,
        changed: 0,
        note:
          `一次只能有一个任务是 in_progress，你给了 ${running.length} 个：` +
          `${running.map((item) => item.text).join('、')}。` +
          '清单没有被改动。请只把当前真正在做的那一条设为 in_progress，其余保持 pending。',
      }
    }

    const before = new Map(this.items.map((item) => [item.id, item.status]))
    const items: TodoItem[] = next.map((item, i) => ({
      id: item.id?.trim() || `t${i + 1}`,
      text: item.text.trim(),
      status: item.status,
    }))
    const ids = new Set(items.map((item) => item.id))
    if (ids.size !== items.length) {
      return {
        ok: false,
        changed: 0,
        note: 'id 有重复，清单没有被改动。要么全部不给 id，要么给唯一的 id。',
      }
    }

    let changed = 0
    for (const item of items) {
      const was = before.get(item.id)
      if (was !== item.status) changed += 1
      if (was === 'done' && item.status !== 'done') this.bumpReopen(item.id)
    }
    this.items = items
    this.version += 1
    return { ok: true, changed, note: describe(items) }
  }

  /**
   * 单项状态更新。适合「第二条做完了」这种最常见的一步。
   *
   * 为什么两种写法都要有：只给整表替换，模型每改一个状态都要重发整张表——
   * 一张十条的清单每次几百个 token，而且它有不小的概率在重发时改错别的条目的文字。
   * 只给单项更新，它又没法在中途重新规划。**两种写法覆盖的是两种不同的动作。**
   */
  setStatus(id: string, status: TodoStatus): TodoWrite {
    const item = this.items.find((entry) => entry.id === id)
    if (!item) {
      return {
        ok: false,
        changed: 0,
        note:
          `清单里没有 id 为 ${id} 的任务。现在的清单是：${describe(this.items)}。` +
          '要新增任务请用整表替换（items 参数）。',
      }
    }
    if (status === 'in_progress') {
      const running = this.items.find((entry) => entry.status === 'in_progress')
      if (running && running.id !== id) {
        return {
          ok: false,
          changed: 0,
          note:
            `「${running.text}」还是 in_progress，一次只能有一个进行中。` +
            '清单没有被改动。请先把它标成 done 或 pending，再开始下一条。',
        }
      }
    }
    if (item.status === status) {
      // 不算改动：revision 不动，于是停滞检测不会被「反复写同一个状态」骗过去
      return {
        ok: true,
        changed: 0,
        note: `「${item.text}」本来就是 ${STATUS_LABEL[status]}，没有改动。`,
      }
    }
    if (item.status === 'done' && status !== 'done') this.bumpReopen(item.id)
    item.status = status
    this.version += 1
    return { ok: true, changed: 1, note: `「${item.text}」→ ${STATUS_LABEL[status]}` }
  }

  clear(): void {
    this.items = []
    this.reopened.clear()
    this.version += 1
  }

  private bumpReopen(id: string): void {
    this.reopened.set(id, (this.reopened.get(id) ?? 0) + 1)
  }
}

/** 回灌给模型的一句话摘要。要短：它每一轮都在上下文里 */
function describe(items: TodoItem[]): string {
  if (items.length === 0) return '（清单是空的）'
  return items.map((item) => `${item.id} ${STATUS_LABEL[item.status]} ${item.text}`).join('；')
}
