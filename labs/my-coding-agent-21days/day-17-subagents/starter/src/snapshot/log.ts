/**
 * 快照索引：哪个文件在什么时候是哪个哈希。本天新增。
 *
 * 格式与第七天的会话事件日志**完全同源**：JSONL、只追加、永不改写、带自增的 seq。
 * 理由一模一样（追加写只有一种失败模式：最后一行可能不完整），所以这里不重讲，
 * 只说两件本天特有的事。
 *
 * 一、**它是一条独立的时间线。** 会话日志记「说过什么」，快照日志记「文件是什么」。
 *    两者各有自己的 seq，互不引用。第十四天全部机制的地基就是这条独立性：
 *    只回滚文件不动对话、只回滚对话不动文件，都要求这两条线本来就没绑在一起。
 *
 * 二、**每条记录都带 mtimeMs。** 哈希回答「内容是什么」，mtime 回答「谁最后碰过它」。
 *    两个都要：内容改了又改回来的时候哈希一样，只有 mtime 会告诉你这个文件被动过。
 *
 * 一条快照记录里的 hash 为 null 表示**那一刻这个文件不存在**（create_file 的「改之前」）。
 * 这个 null 不是缺省值，它是要被回滚用到的信息：回到那一刻就意味着把文件删掉。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { SNAPSHOT_DIR } from './store.js'

export const CHECKPOINTS_FILE = path.join(SNAPSHOT_DIR, 'checkpoints.jsonl')

/** 一条快照记录。phase 说明它是哪一刻拍的 */
export interface Checkpoint {
  seq: number
  ts: string
  /** baseline：mca 接手时仓库长什么样；before / after：一次写工具执行的前后 */
  phase: 'baseline' | 'before' | 'after'
  /** 哪个工具触发的。baseline 是 mca 自己 */
  tool: string
  /** 相对沙盒仓库的路径 */
  path: string
  /** 内容哈希。null 表示那一刻文件不存在 */
  hash: string | null
  size: number
  /** 文件的修改时间。null 表示文件不存在 */
  mtimeMs: number | null
}

export type NewCheckpoint = Omit<Checkpoint, 'seq' | 'ts'>

export class CheckpointLog {
  private seq: number

  constructor(seq = 0) {
    this.seq = seq
  }

  static async open(): Promise<CheckpointLog> {
    const read = await readCheckpoints()
    return new CheckpointLog(read.checkpoints.at(-1)?.seq ?? 0)
  }

  get nextSeq(): number {
    return this.seq + 1
  }

  async append(entry: NewCheckpoint): Promise<Checkpoint> {
    this.seq += 1
    const full: Checkpoint = { seq: this.seq, ts: new Date().toISOString(), ...entry }
    await fs.mkdir(SNAPSHOT_DIR, { recursive: true })
    await fs.appendFile(CHECKPOINTS_FILE, `${JSON.stringify(full)}\n`, 'utf8')
    return full
  }
}

export interface CheckpointRead {
  checkpoints: Checkpoint[]
  /** 读到第几行停下来了（1 起）。null 表示整个文件都是好的 */
  stoppedAtLine: number | null
}

/** 读全部快照记录。坏行处理与第七天一样：停在坏行之前，不跳过、不修补 */
export async function readCheckpoints(): Promise<CheckpointRead> {
  let raw: string
  try {
    raw = await fs.readFile(CHECKPOINTS_FILE, 'utf8')
  } catch {
    return { checkpoints: [], stoppedAtLine: null }
  }
  const lines = raw.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const checkpoints: Checkpoint[] = []
  for (let i = 0; i < lines.length; i += 1) {
    try {
      const parsed = JSON.parse(lines[i] as string) as Checkpoint
      if (typeof parsed.seq !== 'number' || typeof parsed.path !== 'string') {
        return { checkpoints, stoppedAtLine: i + 1 }
      }
      checkpoints.push(parsed)
    } catch {
      return { checkpoints, stoppedAtLine: i + 1 }
    }
  }
  return { checkpoints, stoppedAtLine: null }
}

/**
 * 「回到第 N 条快照那一刻」，每个文件该是什么哈希。
 *
 * 算法只有一句话：**对每个文件，取 seq 小于等于 N 的最后一条记录。** 没有任何一条
 * 记录的文件不在结果里（mca 从没碰过它，也就没有理由去动它）。
 *
 * 这个函数是全天最该被单元测试钉住的一段——回滚的正确性全靠它，而它是纯函数。
 */
export function stateAt(checkpoints: Checkpoint[], seq: number): Map<string, Checkpoint> {
  const state = new Map<string, Checkpoint>()
  for (const entry of checkpoints) {
    if (entry.seq > seq) break
    state.set(entry.path, entry)
  }
  return state
}

/** 每个文件最新的那条记录，也就是「按 mca 的记录，磁盘现在该是什么样」 */
export function latestState(checkpoints: Checkpoint[]): Map<string, Checkpoint> {
  return stateAt(checkpoints, Number.MAX_SAFE_INTEGER)
}

/**
 * 终端上列出时间线。baseline 那一批折叠成一行——它们通常有几十条，逐条列出来
 * 会把真正要看的那几条写入记录挤到屏幕外面去。
 *
 * 折叠要按**连续段**来分：同一个工作区跑第二次 mca 会再拍一批基线，两批之间隔着
 * 上一次的写入记录。把全部 baseline 合成一段，打出来的编号区间是错的。
 */
export function formatCheckpoints(checkpoints: Checkpoint[]): string[] {
  const rows: string[] = []
  let run: Checkpoint[] = []
  const flush = (): void => {
    if (run.length === 0) return
    rows.push(`#${run[0]?.seq}–${run.at(-1)?.seq} baseline  mca 接手时的 ${run.length} 个文件`)
    run = []
  }
  for (const entry of checkpoints) {
    if (entry.phase === 'baseline') {
      run.push(entry)
      continue
    }
    flush()
    const what = entry.hash ? `${entry.hash} ${entry.size} 字符` : '（文件不存在）'
    rows.push(`#${entry.seq} ${entry.phase.padEnd(6)} ${entry.tool} ${entry.path}  ${what}`)
  }
  flush()
  return rows
}
