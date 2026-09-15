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
  // TODO(1)：把这个数组换成以 index 为键的 Map，并正确归并分片。三个要点：
  //   - 不要假设 index 从 0 开始（离线剧本故意从 1 开始，实测真实模型两种起点都见过）
  //   - id 与 name 只在第一片出现，后面的分片不带，所以只在有值时才覆盖
  //   - argsDelta 是累加（+=）不是覆盖；并行调用的分片是交错到达的，
  //     所以「累加到最后一个 slot 上」也是错的
  // 提示：下面这个默认实现把 index 当成数组下标。index 从 1 起时，
  // 下标 0 是一个空洞，于是你会看到一个名字为空的工具调用被送去执行，
  // 终端上出现「没有名为  的工具」。自检第 1、2 项会亮叉。
  private readonly slots: Array<Partial | undefined> = []

  push(delta: { index: number; id?: string; name?: string; argsDelta?: string }): void {
    const slot = this.slots[delta.index] ?? { index: delta.index, args: '' }
    if (delta.id) slot.id = delta.id
    if (delta.name) slot.name = delta.name
    if (delta.argsDelta) slot.args += delta.argsDelta
    this.slots[delta.index] = slot
  }

  get size(): number {
    return this.slots.length
  }

  drain(): ToolCall[] {
    const calls = Array.from(this.slots, (slot, position) => ({
      id: slot?.id ?? `call_${position}`,
      name: slot?.name ?? '',
      args: slot?.args ?? '',
    }))
    this.slots.length = 0
    return calls
  }
}
