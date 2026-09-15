// 产物缓存：内容寻址。键由「环节 + 模型 + 规格 + 提示词」算出来，命中就直接复用文件。
//
// 键怎么设计是 D8 的题目（工作流引擎的幂等键），这里只关心两件事：
// 命中率能省多少钱、以及没命中时怎么退回去重新生成。

import { copyFile, mkdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, extname, join } from 'node:path'

export type CacheStat = { hits: number; misses: number }

export class ArtifactCache {
  readonly stat: CacheStat = { hits: 0, misses: 0 }

  constructor(private readonly dir: string) {}

  key(parts: Record<string, string | number | boolean | undefined>): string {
    const canonical = Object.keys(parts)
      .sort()
      .map((k) => `${k}=${parts[k] ?? ''}`)
      .join('|')
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
  }

  /**
   * 命中就把缓存文件复制到 outPath 并返回 true；没命中返回 false，由调用方去真的生成，
   * 生成完再调 put() 存进来。刻意不接管生成逻辑——缓存层不该知道怎么调 provider。
   */
  async take(key: string, outPath: string): Promise<boolean> {
    // 练习 2：实现缓存命中。
    //   用 pathFor(key, outPath) 算出缓存文件路径，stat() 得到就说明命中，
    //   把它 copyFile 到 outPath 并 this.stat.hits += 1 后返回 true；
    //   stat 抛错就是没命中，this.stat.misses += 1 并返回 false。
    // 现在恒定返回 false：缓存永远不命中，阶段 ③ ④ 的花费一分钱都降不下来，
    // 面板上「缓存命中 0 / 11」就是没做完的信号。
    void key
    void outPath
    void stat
    void copyFile
    void mkdir
    void dirname
    this.stat.misses += 1
    return false
  }

  async put(key: string, outPath: string): Promise<void> {
    const cached = this.pathFor(key, outPath)
    await mkdir(dirname(cached), { recursive: true })
    await copyFile(outPath, cached)
  }

  private pathFor(key: string, outPath: string): string {
    return join(this.dir, `${key}${extname(outPath)}`)
  }
}
