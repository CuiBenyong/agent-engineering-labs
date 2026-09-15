// 本章最值钱的三十行：并行写同一个字段时，reducer 决定了你拿到的是一份工作区还是一堆历史版本。
//
// reducer 的契约：`(旧值, 这一轮所有节点写入的增量) => 新值`。它必须是纯函数——
// 不能原地改旧值，因为 LangGraph 会拿旧值去算检查点（D18），改坏了连回滚都没得回。

import type { Task } from './state'

/**
 * D15 用的那个 reducer：把新写入原样接在后面。
 *
 * 单节点顺序执行时它没问题；一旦 Planner 扇出（fan-out）成三个 Executor 并行写同一个
 * workspace，你会拿到「三条 pending + 三条 done」六条记录，同一个 id 出现两次，
 * 而且 done 那三条的先后顺序取决于谁先跑完——每次跑都可能不一样。
 * 下游任何一句 `workspace.find(t => t.id === id)` 都可能拿到那条过期的 pending。
 */
export function concatWorkspace(old: Task[], next: Task[]): Task[] {
  return old.concat(next)
}

/**
 * 按 id 原地更新，没见过的 id 追加到末尾——并行写共享工作区该配的就是这一个。
 *
 * 它之所以安全，前提是**每个子任务只有一个写者**：一轮 fan-out 里 t-2 只会被负责 t-2 的
 * 那个 Executor 写。如果哪天两个节点会写同一条记录的不同字段，你需要的就不是「整条替换」，
 * 而是字段级的合并（各写各的字段），否则后写的那份会把前一份的字段抹掉。
 */
export function upsertWorkspace(old: Task[], next: Task[]): Task[] {
  // 练习 1：按 id 原地更新——next 里的每条子任务，old 里已经有同 id 的就替换掉，没有的追加到末尾。
  // 注意 reducer 必须是纯函数：先 `old.slice()` 拷一份再改，不要原地改 old，
  // 否则 D18 拿旧状态去算检查点时会对不上。
  // 挖空默认：和 concat 一模一样。跑一次自检你会看到 3 件子任务在工作区里留下 6 条记录、
  // 每个 id 两份，而且按 id 查到的第一条是那个过期的 pending 版本。
  return old.concat(next)
}

/**
 * 每个 id 只留最后写入的那一版。
 *
 * 这个函数就是「没配对 reducer」欠下的债：只要通道还是 concat，**每一处读工作区的代码**
 * 都得先调它一次——扇出前要读、评审前要读、汇总时要读，漏一处就会拿到过期版本。
 * 换成 upsertWorkspace 之后它是个恒等函数，留在这里只是为了让两种 reducer 能跑同一份业务代码。
 */
export function latestById(tasks: Task[]): Task[] {
  const byId = new Map<string, Task>()
  for (const task of tasks) byId.set(task.id, task)
  return [...byId.values()]
}

/** 工作区里出现了几个重复 id——这就是「没配对 reducer」的可见症状。 */
export function duplicateIds(tasks: Task[]): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const task of tasks) {
    if (seen.has(task.id)) dup.add(task.id)
    seen.add(task.id)
  }
  return [...dup].sort()
}
