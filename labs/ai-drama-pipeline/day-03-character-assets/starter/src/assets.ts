// 资产库：一个标识、一份元数据、一个文件，外加一次去重。
// 索引落在 assets/index.json，进程重启后仍然认得已经生成过的东西。

import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { writeJson } from './run.js'

export type AssetKind = 'character' | 'scene' | 'prop'

export type AssetRecord = {
  /** 资产 id，由 assetKey() 算出，同时也是去重键 */
  id: string
  kind: AssetKind
  /** 归属的角色 / 场景 id，方便按人按景检索 */
  ownerId: string
  /** 变体名：base / front / side / smile / night… */
  variant: string
  /** 生成用的完整提示词，出问题时能复现 */
  prompt: string
  /** 相对 run 目录的文件路径 */
  path: string
  /** 生成这张图时用了哪张参考图（没有就是 undefined） */
  referenceImage?: string
  seed?: number
  costCny: number
  at: string
}

/**
 * 去重键 = 内容标识，不是文件名。
 * 更完整的缓存键设计（版本号、模型 id、失效策略）留到 D8 的工作流引擎。
 */
export function assetKey(input: {
  kind: AssetKind
  ownerId: string
  variant: string
  prompt: string
  referenceImage?: string
  seed?: number
}): string {
  // 练习 1：把「所有会改变画面的东西」都放进哈希——变体名、完整提示词、参考图路径、seed，
  //         用 createHash('sha1') 取前 12 位，前面拼上 kind。
  // 提示：下面这个默认实现只认 kind 和 ownerId，于是同一个角色的三个变体会撞成同一件资产。
  //       先原样跑一次，看到「登记的资产件数远少于生成次数」这个现象，再动手改。
  void createHash
  return `${input.kind}-${input.ownerId}`
}

export class AssetLibrary {
  private readonly items = new Map<string, AssetRecord>()
  /** 本次运行里命中缓存的次数，用来在结尾证明去重真的发生了 */
  hits = 0
  misses = 0

  constructor(private readonly indexPath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.indexPath, 'utf8')
      for (const item of JSON.parse(raw) as AssetRecord[]) this.items.set(item.id, item)
    } catch {
      // 第一次跑没有索引文件，属于正常情况
    }
  }

  find(id: string): AssetRecord | undefined {
    // 练习 2：在已登记的资产里按 id 查一次，查到就返回，让调用方跳过这次生成。
    // 提示：默认实现永远查不到，于是第 4 步「同一批场景再跑一遍」会把每张图重新生成一次，
    //       报告里那行「重新生成了 N 张（应为 0）」就是你的验收信号。
    void id
    return undefined
  }

  /** 按角色取它的基准图；D3 的派生步骤靠它拿参考图。 */
  baseOf(ownerId: string): AssetRecord | undefined {
    for (const item of this.items.values()) {
      if (item.ownerId === ownerId && item.variant === 'base') return item
    }
    return undefined
  }

  list(): AssetRecord[] {
    return [...this.items.values()]
  }

  register(record: AssetRecord): void {
    this.items.set(record.id, record)
  }

  async save(): Promise<void> {
    await writeJson(this.indexPath, this.list())
  }
}
