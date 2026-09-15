/**
 * 会话事件日志。本天新增，是全课唯一的持久化格式（D14 的快照与它互相独立）。
 *
 * 三条设计决定，后面十四天都按它们写：
 *
 * 一、**只追加，永不改写。** 写入的唯一手段是 appendFile，也就是以 O_APPEND 打开再写。
 *    这不只是「简单」：追加写的失败模式只有一种——最后一行可能不完整；而改写的失败模式
 *    有无数种，随便一次崩溃都可能让你拿到一个语法上合法、语义上错乱的文件。
 *
 * 二、**一行一个 JSON（JSONL），不用单个大 JSON 数组。** 数组要求你每次都把整个文件
 *    读出来、改完再整体写回去——那就不是追加了，而且文件一大就慢。JSONL 的代价是
 *    「读的时候要自己拼」，收益是「写的时候只碰文件末尾」。
 *
 * 三、**每行三个必备字段：seq、ts、type。** seq 用来定位与分叉，ts 用来审计，
 *    type 决定后面还有什么字段。三个字段就够了，多加字段是以后的自己在还债。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Message, ToolResult } from '../kernel/types.js'

export const SESSIONS_DIR = path.resolve(process.cwd(), 'work/sessions')

/**
 * 五种事件。**只有 message 参与重建消息数组**，其余三种是审计与展示用的
 * （见 replay.ts 里的说明），fork 只记血缘。
 */
export type SessionEvent =
  | { seq: number; ts: string; type: 'message'; message: Message }
  | { seq: number; ts: string; type: 'tool_end'; id: string; result: ToolResult }
  | {
      seq: number
      ts: string
      type: 'usage'
      promptTokens: number
      completionTokens: number
      cachedTokens: number
    }
  | { seq: number; ts: string; type: 'error'; message: string }
  | { seq: number; ts: string; type: 'fork'; from: string; atSeq: number }

export type NewEvent =
  | { type: 'message'; message: Message }
  | { type: 'tool_end'; id: string; result: ToolResult }
  | { type: 'usage'; promptTokens: number; completionTokens: number; cachedTokens: number }
  | { type: 'error'; message: string }
  | { type: 'fork'; from: string; atSeq: number }

const EVENT_TYPES = new Set(['message', 'tool_end', 'usage', 'error', 'fork'])

/**
 * 会话 id 形如 s-20260907-100000-ab12：日期时间加四位随机。
 * 带时间是为了让目录按文件名排序就等于按时间排序；带随机是因为同一秒里可能开两个会话。
 */
export function newSessionId(now: Date = new Date()): string {
  const iso = now.toISOString()
  const day = iso.slice(0, 10).replace(/-/g, '')
  const time = iso.slice(11, 19).replace(/:/g, '')
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0')
  return `s-${day}-${time}-${rand}`
}

export function sessionPath(id: string): string {
  return path.join(SESSIONS_DIR, `${id}.jsonl`)
}

/** 一个会话的写入端。它只会往文件末尾加东西 */
export class SessionLog {
  private seq: number
  /** 已经写进日志的消息条数：用来判断消息数组里哪几条是新的 */
  private recorded: number

  /** 别直接 new：用 create / open / forkSession 三个入口，它们负责建目录与定 seq */
  constructor(
    readonly id: string,
    seq: number,
    recorded: number
  ) {
    this.seq = seq
    this.recorded = recorded
  }

  static async create(id: string = newSessionId()): Promise<SessionLog> {
    await fs.mkdir(SESSIONS_DIR, { recursive: true })
    await fs.writeFile(sessionPath(id), '', { flag: 'a' }) // 只创建，不清空
    return new SessionLog(id, 0, 0)
  }

  /** 接着写一个已有会话：seq 从最后一条完整事件之后继续 */
  static async open(id: string): Promise<{ log: SessionLog; read: ReadResult }> {
    const read = await readEvents(id)
    const last = read.events.at(-1)
    const messages = read.events.filter((e) => e.type === 'message').length
    return { log: new SessionLog(id, last?.seq ?? 0, messages), read }
  }

  get nextSeq(): number {
    return this.seq + 1
  }

  async append(event: NewEvent): Promise<SessionEvent> {
    this.seq += 1
    const full = { seq: this.seq, ts: new Date().toISOString(), ...event } as SessionEvent
    // 一次 appendFile 就是一次 O_APPEND 写。同一个文件被两个进程追加时，
    // 小于一个块的写入不会互相插进对方中间——这是我们敢让 --resume 直接接着写的前提
    await fs.appendFile(sessionPath(this.id), `${JSON.stringify(full)}\n`, 'utf8')
    return full
  }

  /**
   * 把消息数组里还没落盘的那几条写进去。
   *
   * 为什么按「数组长度差」来判断，而不是让循环回调告诉我们：因为循环里往数组 push
   * 的位置有五处（助手文本、带调用的助手消息、工具结果、被拒的结果、上限说明），
   * 每处都加一行记录，早晚会漏一处。**按差量落盘只有一处代码，漏不了。**
   */
  async flushMessages(messages: Message[]): Promise<number> {
    let written = 0
    while (this.recorded < messages.length) {
      const message = messages[this.recorded] as Message
      await this.append({ type: 'message', message })
      this.recorded += 1
      written += 1
    }
    return written
  }
}

export interface ReadResult {
  events: SessionEvent[]
  /** 读到第几行停下来了（1 起）。null 表示整个文件都是好的 */
  stoppedAtLine: number | null
  /** 停下来的原因，给用户看 */
  reason: string | null
}

/**
 * 读一个会话的全部事件。
 *
 * **读到坏行就停在前一行，不跳过、不修补。** 理由是坏行几乎只有一种来因：
 * 进程在写最后一行的中途被杀掉了。这种情况下「前面那些行」是完整可信的，
 * 而「坏行之后」不存在。跳过坏行去读后面，等于假设文件中间会坏——
 * 追加写不会产生那种情况，一旦真的产生，说明文件被别的东西动过，那时候更不该猜。
 */
export async function readEvents(id: string): Promise<ReadResult> {
  let raw: string
  try {
    raw = await fs.readFile(sessionPath(id), 'utf8')
  } catch {
    return { events: [], stoppedAtLine: null, reason: `没有找到会话 ${id}` }
  }

  const lines = raw.split('\n')
  // 最后一个元素是末尾换行后的空串；文件正常结束时它就该是空的
  if (lines.at(-1) === '') lines.pop()

  const events: SessionEvent[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseLine(lines[i] as string, events.at(-1)?.seq ?? 0)
    if (!parsed.ok) {
      return { events, stoppedAtLine: i + 1, reason: parsed.reason }
    }
    events.push(parsed.event)
  }
  return { events, stoppedAtLine: null, reason: null }
}

function parseLine(
  line: string,
  prevSeq: number
): { ok: true; event: SessionEvent } | { ok: false; reason: string } {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { ok: false, reason: '这一行不是完整的 JSON（通常是上次写到一半被中断了）' }
  }
  if (typeof value !== 'object' || value === null) return { ok: false, reason: '这一行不是对象' }
  const event = value as Partial<SessionEvent>
  if (typeof event.seq !== 'number' || typeof event.ts !== 'string') {
    return { ok: false, reason: '缺少 seq 或 ts' }
  }
  if (event.seq <= prevSeq) return { ok: false, reason: `seq 没有递增（${event.seq}）` }
  if (typeof event.type !== 'string' || !EVENT_TYPES.has(event.type)) {
    return { ok: false, reason: `不认识的事件类型 ${String(event.type)}` }
  }
  return { ok: true, event: event as SessionEvent }
}

/**
 * 分叉：把原会话前 atSeq 条事件复制到一个新文件，再记一条 fork 事件。
 *
 * **复制到新文件而不是原地截断**，理由是原地截断是一次改写：写到一半崩了，你会
 * 同时失去原会话和分叉。复制的代价只是多占一份磁盘，而分叉出来的历史本来也该独立演化。
 */
export async function forkSession(
  from: string,
  atSeq: number,
  id: string = newSessionId()
): Promise<{ log: SessionLog; copied: number }> {
  const source = await readEvents(from)
  const kept = source.events.filter((event) => event.seq <= atSeq)
  if (kept.length === 0) throw new Error(`会话 ${from} 里没有 seq 小于等于 ${atSeq} 的事件`)

  await fs.mkdir(SESSIONS_DIR, { recursive: true })
  const body = kept.map((event) => `${JSON.stringify(event)}\n`).join('')
  await fs.writeFile(sessionPath(id), body, 'utf8')

  // seq 不重新编号：保留原编号，才能拿分叉点的 seq 直接对回母会话
  const log = new SessionLog(
    id,
    kept.at(-1)?.seq ?? 0,
    kept.filter((e) => e.type === 'message').length
  )
  await log.append({ type: 'fork', from, atSeq })
  return { log, copied: kept.length }
}

export interface SessionInfo {
  id: string
  events: number
  /** 最后一条事件的时间，没有事件就用文件的修改时间 */
  updatedAt: string
  broken: boolean
}

/** 列出全部会话，最近的在前 */
export async function listSessions(): Promise<SessionInfo[]> {
  let names: string[]
  try {
    names = await fs.readdir(SESSIONS_DIR)
  } catch {
    return []
  }
  const infos: SessionInfo[] = []
  for (const name of names.filter((n) => n.endsWith('.jsonl'))) {
    const id = name.slice(0, -'.jsonl'.length)
    const read = await readEvents(id)
    const stat = await fs.stat(sessionPath(id))
    infos.push({
      id,
      events: read.events.length,
      updatedAt: read.events.at(-1)?.ts ?? stat.mtime.toISOString(),
      broken: read.stoppedAtLine !== null,
    })
  }
  // id 里带了时间，所以按 id 倒序就是按时间倒序——这是那个命名规则的第二个用处
  return infos.sort((a, b) => (a.id < b.id ? 1 : -1))
}

/** 最近一个会话的 id，供 --resume 不带参数时使用 */
export async function latestSessionId(): Promise<string | null> {
  return (await listSessions())[0]?.id ?? null
}
