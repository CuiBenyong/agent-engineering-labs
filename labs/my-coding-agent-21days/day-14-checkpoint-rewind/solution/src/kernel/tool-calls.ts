/**
 * 流式工具调用分片的归并。本天新增。
 *
 * 网关把一次工具调用切成很多片送来：第一片通常带 id 与函数名，后面几片各带一段
 * 参数文本，拼起来才是合法 JSON。归并的唯一依据是分片上的 index。
 *
 * ★ 这里有一个实测踩到的坑，必须用字典而不是数组：
 *   2026-09-07 同一个模型（claude-haiku-4-5-20251001）在同一家网关上的两次运行，
 *   两个并行调用的 index 起点分别是 1 和 2、以及 0 和 1。
 *   所以「index 从 0 开始」不是一条可以依赖的规则；按到达顺序 push 进数组更是错的，
 *   因为并行调用的分片是交错到达的。
 *   （不要把这条读成「某家从 1 开始」——起点不可假设，我们只是实测见过两种。）
 */
import type { ToolCall } from './types.js'

interface Partial {
  index: number
  id?: string
  name?: string
  args: string
}

/** 按 index 归并的累加器。喂进分片，最后取出调用列表 */
export class ToolCallAccumulator {
  /** 用 Map 而不是数组：index 可能从任意数字开始，也可能不连续 */
  private readonly byIndex = new Map<number, Partial>()

  push(delta: { index: number; id?: string; name?: string; argsDelta?: string }): void {
    const slot = this.byIndex.get(delta.index) ?? { index: delta.index, args: '' }
    // id 与 name 只在第一片出现，后面的分片不带，所以只在有值时覆盖
    if (delta.id) slot.id = delta.id
    if (delta.name) slot.name = delta.name
    if (delta.argsDelta) slot.args += delta.argsDelta
    this.byIndex.set(delta.index, slot)
  }

  get size(): number {
    return this.byIndex.size
  }

  /**
   * 取出归并结果。按 index 升序排，保证「模型给出的第一个调用」排在前面——
   * 不是按到达顺序，因为并行调用的分片是交错到达的。
   */
  drain(): ToolCall[] {
    const calls = [...this.byIndex.values()]
      .sort((a, b) => a.index - b.index)
      .map((slot, position) => ({
        // id 缺失也要给一个：工具结果消息必须能指回某个调用
        id: slot.id ?? `call_${slot.index}_${position}`,
        name: slot.name ?? '',
        args: slot.args,
      }))
    this.byIndex.clear()
    return calls
  }
}
