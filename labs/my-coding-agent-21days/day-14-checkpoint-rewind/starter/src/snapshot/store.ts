/**
 * 内容寻址的对象库。本天新增。
 *
 * **一个文件的内容存在哪儿，由它自己的哈希决定。** 于是同样的内容只会占一份磁盘，
 * 而「同样的内容」在这门课的场景里出现得比你想的多：
 *   - 一次 edit_file 的「改之后」，就是下一次 edit_file 的「改之前」——四次快照三份对象
 *   - 改了又改回来（很常见，模型试一条路不成再退回去），第三次快照复用第一份对象
 *   - 一次任务里被读了十遍但只改了一次的文件，只有两份对象
 *
 * 为什么不做增量（只存 diff）：diff 要有基准，基准要有链，链断了整串都恢复不了；
 * 而快照的用途恰恰是「出事了要能恢复」，那是最不该有链式依赖的时候。
 * 全文存储的代价是磁盘，而源码文件只有几 KB——**这门课的场景里磁盘从来不是瓶颈。**
 *
 * 一个必须点明的边界：**哈希只认内容，不认文件名。** 所以对象库自己不知道
 * 哪个哈希属于哪个文件，那件事记在 checkpoints.jsonl 里（见 log.ts）。
 * 这条分工是内容寻址的全部好处所在：存储层去重，索引层记语义。
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const SNAPSHOT_DIR = path.resolve(process.cwd(), 'work/snapshots')
export const OBJECTS_DIR = path.join(SNAPSHOT_DIR, 'objects')

/** 内容哈希。取前 16 个十六进制字符，够短得能打在终端上，也够长不会撞 */
export function hashOf(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16)
}

/** 顺序编号，给下面那个「一次快照存一份」的实现用 */
let counter = 0

// TODO(1)：现在是**按顺序编号存**——一次快照写一份新文件，名字是 1、2、3……
// 这是最直白的实现，也是最费的：一次 edit_file 的「改之后」就是下一次的「改之前」，
// 同一段内容会被存两遍；模型试一条路不成再改回来，第三份又是同一段内容。
// 改成**内容寻址**：文件名就是 hashOf(content)，写之前先看一眼在不在，
// 在就直接返回（fresh 为 false）。这样「同样的内容只占一份磁盘」是白拿的，
// 而且不需要任何一张「谁和谁一样」的表——**哈希本身就是那张表**。
export async function putBlob(content: string): Promise<{ hash: string; fresh: boolean }> {
  counter += 1
  const hash = String(counter)
  await fs.mkdir(OBJECTS_DIR, { recursive: true })
  const temp = path.join(OBJECTS_DIR, `${hash}.tmp-${process.pid}`)
  await fs.writeFile(temp, content, 'utf8')
  await fs.rename(temp, path.join(OBJECTS_DIR, hash))
  return { hash, fresh: true }
}

export async function getBlob(hash: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(OBJECTS_DIR, hash), 'utf8')
  } catch {
    return null
  }
}

export interface StoreStats {
  objects: number
  bytes: number
}

export async function storeStats(): Promise<StoreStats> {
  let objects = 0
  let bytes = 0
  let names: string[]
  try {
    names = await fs.readdir(OBJECTS_DIR)
  } catch {
    return { objects: 0, bytes: 0 }
  }
  for (const name of names) {
    if (name.includes('.tmp-')) continue
    objects += 1
    bytes += (await fs.stat(path.join(OBJECTS_DIR, name))).size
  }
  return { objects, bytes }
}
