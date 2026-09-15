/**
 * 钩子的选中、执行与报账。本天新增。
 *
 * 这个文件只做三件事，但每一件都有一个非做不可的理由：
 *
 *   1. 选中：按事件与工具名过滤。**顺序就是注册顺序**，不排序、不并发。
 *      并发跑钩子是一个很有诱惑力的优化，但格式化与跑测试都在动同一个工作区，
 *      并发的结果是测试读到一个改了一半的文件——偶发、不可复现、查起来要命。
 *   2. 超时与异常：**钩子永远不许把异常抛到循环外面。** 一个写坏的钩子最坏的后果
 *      应该是「它自己失败了」，不是「Agent 挂了」。这条和第十六天对坏技能包的处理、
 *      第十五天对掉线 server 的处理是同一条纪律。
 *   3. 报账：每个钩子跑了多久必须打出来。理由见 formatHookRun 上面那段。
 */
import type { HookDef, HookInput, HookOutcome } from './types.js'

export interface HookRunItem {
  hook: HookDef
  outcome: HookOutcome
  ms: number
}

export interface HookRun {
  items: HookRunItem[]
  /** 有阻断型钩子失败时，这里是它给出的理由；没有就是 null */
  denied: string | null
  /** 要回灌给模型的文本，已按顺序拼好 */
  feed: string[]
  /** 这一批钩子一共花了多久。它就是「钩子拖慢了多少」的那个数 */
  totalMs: number
}

/** 按事件与工具名选中钩子。工具名为空时只可能命中 session_start / session_end */
export function selectHooks(hooks: HookDef[], event: string, tool?: string): HookDef[] {
  return hooks.filter((hook) => {
    if (hook.event !== event) return false
    if (!hook.tools) return true
    return tool !== undefined && hook.tools.includes(tool)
  })
}

/**
 * 跑一个钩子，最多等 timeoutMs。
 *
 * 超时的处理是**当成失败**而不是当成成功：一个跑不完的检查没有告诉你任何事情，
 * 把它算成通过等于在最需要它的时候（工作区大到检查跑不完）悄悄关掉了它。
 *
 * 注意超时之后钩子里那个 Promise 并没有被取消——JavaScript 没法从外面掐断一个
 * 正在 await 的函数。**所以钩子自己也要能被打断**：本课的两个耗时钩子跑的都是
 * 子进程，超时时间传给了子进程自己的超时参数（见 builtin.ts），这里的 race
 * 只是最后一道保险。把这件事写清楚，免得有人以为 race 真的能停住什么。
 */
async function runOne(
  hook: HookDef,
  input: HookInput
): Promise<{ outcome: HookOutcome; ms: number }> {
  const startedAt = Date.now()
  const timeout = new Promise<HookOutcome>((resolve) => {
    setTimeout(
      () => resolve({ ok: false, note: `超时（超过 ${hook.timeoutMs}ms 还没跑完）` }),
      hook.timeoutMs
    ).unref()
  })
  try {
    const outcome = await Promise.race([hook.run(input), timeout])
    return { outcome, ms: Date.now() - startedAt }
  } catch (error) {
    // 钩子自己抛异常也只是「这个钩子失败了」。兜在这里，循环那边一行都不用改
    const message = error instanceof Error ? error.message : String(error)
    return { outcome: { ok: false, note: `钩子抛异常：${message}` }, ms: Date.now() - startedAt }
  }
}

/** 依次跑一批钩子。阻断型钩子一旦失败就不再往下跑——后面的检查已经没有意义了 */
export async function runHooks(hooks: HookDef[], input: HookInput): Promise<HookRun> {
  const items: HookRunItem[] = []
  const feed: string[] = []
  let denied: string | null = null
  let totalMs = 0

  for (const hook of hooks) {
    const { outcome, ms } = await runOne(hook, input)
    items.push({ hook, outcome, ms })
    totalMs += ms
    if (outcome.feed) feed.push(outcome.feed)
    if (!outcome.ok && hook.blocking) {
      denied = `${hook.name}：${outcome.note}`
      break
    }
  }

  return { items, denied, feed, totalMs }
}

/**
 * 报账。**耗时那一栏不是装饰，它是今天最该被看见的成本。**
 *
 * 钩子的代价是它会拖慢每一次编辑，而且这个代价是**乘以编辑次数**的：
 * 一次编辑多花 400 毫秒看起来不值一提，一个任务改二十次文件就是八秒，
 * 而用户只会觉得「这东西今天怎么这么慢」，不会想到是自己加的那个钩子。
 * 把每一次的毫秒数打在屏幕上，这笔账才有人算。
 */
export function formatHookRun(run: HookRun, event: string): string[] {
  if (run.items.length === 0) return []
  const rows = run.items.map(
    (item) =>
      `[hook] ${item.outcome.ok ? '✔' : '✘'} ${item.hook.name} ${item.ms}ms — ${item.outcome.note}`
  )
  if (run.denied) rows.push(`[hook] 这次 ${event} 被拦下了：${run.denied}`)
  else if (run.items.length > 1)
    rows.push(`[hook] ${event} 共 ${run.items.length} 个钩子，合计 ${run.totalMs}ms`)
  return rows
}
