/**
 * 工具注册表。今天它是空的——注册表先于工具存在，是为了让循环从第一天起
 * 就不认识任何具体工具，只认识「注册表里有什么」。D3 会往里塞第一批只读工具。
 */
import type { ToolDef } from './types.js'

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>()

  register(tool: ToolDef): void {
    if (this.tools.has(tool.name)) throw new Error(`工具重名：${tool.name}`)
    this.tools.set(tool.name, tool)
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name)
  }

  list(): ToolDef[] {
    return [...this.tools.values()]
  }

  get size(): number {
    return this.tools.size
  }
}
