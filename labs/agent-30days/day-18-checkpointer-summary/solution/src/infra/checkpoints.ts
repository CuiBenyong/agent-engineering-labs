// 检查点存储的端口与两个实现（SOP §7.8 规则四）：
//   内存版  = LangGraph 自带的 MemorySaver，用来讲通原理，`MOCK=1` 下走它
//   真实版  = 自己写的 PgSaver，落到 Postgres 的 graph_checkpoints 表
// 上层的图、节点、摘要逻辑一行都不知道自己接的是哪一个——这是端口/适配器的全部意义。
//
// PgSaver 实现的是 LangGraph 的 BaseCheckpointSaver 抽象类，四个必须实现的方法是：
//   getTuple  取一个检查点（不给 checkpoint_id 就取这条线最新的那个）
//   list      按时间倒序列出检查点，getStateHistory 与分叉靠它
//   put       写一个检查点
//   putWrites 写「挂在某个检查点上、还没被下一步消费掉的写入」——本章的关键，见下

import { BaseCheckpointSaver, MemorySaver } from '@langchain/langgraph'
import type { Checkpoint, CheckpointMetadata, CheckpointTuple } from '@langchain/langgraph'
import type { RunnableConfig } from '@langchain/core/runnables'
import { Pool } from 'pg'

/** LangGraph 没有从主入口导出这两个类型，形状照它的契约写一遍即可。 */
type CheckpointListOptions = {
  limit?: number
  before?: RunnableConfig
  filter?: Record<string, unknown>
}
type PendingWrite = [string, unknown]

export const CHECKPOINT_TABLE = 'graph_checkpoints'

/** 一行 graph_checkpoints 的 state 列里装的东西。表结构只有 5 列，可变的部分全塞这一个 jsonb。 */
interface StoredState {
  ns: string
  checkpoint: unknown
  metadata: unknown
  /** 挂在这个检查点上的 pending writes：[taskId, channel, value]。D17 的 Send 就在这里 */
  writes: [string, string, unknown][]
}

const DDL = `
create table if not exists ${CHECKPOINT_TABLE} (
  thread_id     text        not null,
  checkpoint_id text        not null,
  parent_id     text,
  state         jsonb       not null,
  created_at    timestamptz not null default now(),
  primary key (thread_id, checkpoint_id)
);
create index if not exists ${CHECKPOINT_TABLE}_thread_idx
  on ${CHECKPOINT_TABLE} (thread_id, checkpoint_id desc);
`

export class PgSaver extends BaseCheckpointSaver {
  constructor(private readonly pool: Pool) {
    super()
  }

  async setup(): Promise<void> {
    await this.pool.query(DDL)
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  /** 序列化走 LangGraph 自己的 serde，再解成 JSON 存进 jsonb。
   *  好处是 Send 这类带类型的对象会被存成可读的构造器记录，肉眼能看懂库里存了什么。 */
  private async toJson(value: unknown): Promise<unknown> {
    const [, bytes] = await this.serde.dumpsTyped(value)
    return JSON.parse(new TextDecoder().decode(bytes))
  }

  private async fromJson<T>(value: unknown): Promise<T> {
    const bytes = new TextEncoder().encode(JSON.stringify(value))
    return (await this.serde.loadsTyped('json', bytes)) as T
  }

  private async toTuple(row: {
    thread_id: string
    checkpoint_id: string
    parent_id: string | null
    state: StoredState
  }): Promise<CheckpointTuple> {
    const { thread_id, checkpoint_id, parent_id, state } = row
    const tuple: CheckpointTuple = {
      config: { configurable: { thread_id, checkpoint_ns: state.ns, checkpoint_id } },
      checkpoint: await this.fromJson<Checkpoint>(state.checkpoint),
      metadata: await this.fromJson<CheckpointMetadata>(state.metadata),
      pendingWrites: await Promise.all(
        (state.writes ?? []).map(
          async ([taskId, channel, value]) =>
            [taskId, channel, await this.fromJson(value)] as [string, string, unknown]
        )
      ),
    }
    if (parent_id) {
      tuple.parentConfig = {
        configurable: { thread_id, checkpoint_ns: state.ns, checkpoint_id: parent_id },
      }
    }
    return tuple
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id as string | undefined
    if (!threadId) return undefined
    const ns = (config.configurable?.checkpoint_ns as string) ?? ''
    const id = config.configurable?.checkpoint_id as string | undefined

    // 不带 checkpoint_id 就取这条线最新的一个；带了就精确取那一个——分叉靠的正是后者。
    const { rows } = id
      ? await this.pool.query(
          `select * from ${CHECKPOINT_TABLE} where thread_id = $1 and checkpoint_id = $2 and state->>'ns' = $3`,
          [threadId, id, ns]
        )
      : await this.pool.query(
          `select * from ${CHECKPOINT_TABLE} where thread_id = $1 and state->>'ns' = $2
             order by checkpoint_id desc limit 1`,
          [threadId, ns]
        )
    return rows[0] ? this.toTuple(rows[0]) : undefined
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = config.configurable?.thread_id as string | undefined
    if (!threadId) return
    const ns = (config.configurable?.checkpoint_ns as string) ?? ''
    const before = options?.before?.configurable?.checkpoint_id as string | undefined
    const { rows } = await this.pool.query(
      `select * from ${CHECKPOINT_TABLE}
        where thread_id = $1 and state->>'ns' = $2 and ($3::text is null or checkpoint_id < $3)
        order by checkpoint_id desc
        limit $4`,
      [threadId, ns, before ?? null, options?.limit ?? 100]
    )
    for (const row of rows) yield await this.toTuple(row)
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id as string
    if (!threadId) throw new Error('写检查点缺少 thread_id：configurable.thread_id 是必填的')
    const ns = (config.configurable?.checkpoint_ns as string) ?? ''
    const state: StoredState = {
      ns,
      checkpoint: await this.toJson(checkpoint),
      metadata: await this.toJson(metadata),
      writes: [],
    }
    // 同一个 checkpoint_id 可能被重写（比如手动 updateState），所以是 upsert 而不是 insert。
    // 注意 writes 用 coalesce 保住已有的：put 之后还可能有 putWrites 补进来。
    await this.pool.query(
      `insert into ${CHECKPOINT_TABLE} (thread_id, checkpoint_id, parent_id, state)
       values ($1, $2, $3, $4)
       on conflict (thread_id, checkpoint_id) do update
         set state = $4 || jsonb_build_object('writes', ${CHECKPOINT_TABLE}.state->'writes'),
             parent_id = excluded.parent_id`,
      [threadId, checkpoint.id, (config.configurable?.checkpoint_id as string) ?? null, state]
    )
    return {
      configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpoint.id },
    }
  }

  /**
   * 存「已经算出来、但下一个超步还没消费」的写入。
   *
   * 这是本章最容易被忽略的一半：**D17 的 Send 携带的子任务参数就存在这里**，
   * 通道名是 LangGraph 内部的 `__pregel_tasks`，而不是 checkpoint.channel_values 里的业务字段。
   * 也就是说，只实现 getTuple/list/put 而漏掉 putWrites 的 checkpointer，
   * 恢复时会丢掉所有待执行的扇出——图看起来「跑完了」，其实一件活都没派出去。
   */
  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const threadId = config.configurable?.thread_id as string
    const checkpointId = config.configurable?.checkpoint_id as string
    if (!threadId || !checkpointId)
      throw new Error('写 pending writes 缺少 thread_id 或 checkpoint_id')
    const encoded = await Promise.all(
      writes.map(async ([channel, value]) => [taskId, channel, await this.toJson(value)])
    )
    await this.pool.query(
      `update ${CHECKPOINT_TABLE}
          set state = jsonb_set(state, '{writes}', (state->'writes') || $3::jsonb)
        where thread_id = $1 and checkpoint_id = $2`,
      [threadId, checkpointId, JSON.stringify(encoded)]
    )
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.pool.query(`delete from ${CHECKPOINT_TABLE} where thread_id = $1`, [threadId])
  }

  /** 只为教学：把库里这条线的检查点原样读出来，让读者看见 jsonb 里到底存了什么。 */
  async rawRows(
    threadId: string
  ): Promise<{ checkpoint_id: string; parent_id: string | null; state: StoredState }[]> {
    const { rows } = await this.pool.query(
      `select checkpoint_id, parent_id, state from ${CHECKPOINT_TABLE}
        where thread_id = $1 order by checkpoint_id asc`,
      [threadId]
    )
    return rows
  }
}

// ---------------------------------------------------------------------------
// 唯一的选择点。有 DATABASE_URL 就用 Postgres，没有就用内存版——
// 业务代码永远只调 createSaver()，两条路跑的是同一份图。
// ---------------------------------------------------------------------------

/** 内存版必须是单例：它代表的是「进程外的存储」，不是「这一个图对象」。
 *  重建图对象来模拟进程重启时，saver 必须还是同一个，否则测的就不是恢复了。 */
let memorySingleton: MemorySaver | undefined

export interface SaverHandle {
  saver: BaseCheckpointSaver
  kind: 'memory' | 'postgres'
  close: () => Promise<void>
}

export async function createSaver(): Promise<SaverHandle> {
  const url = process.env.DATABASE_URL
  if (!url) {
    memorySingleton ??= new MemorySaver()
    return { saver: memorySingleton, kind: 'memory', close: async () => {} }
  }
  const saver = new PgSaver(new Pool({ connectionString: url }))
  await saver.setup()
  return { saver, kind: 'postgres', close: () => saver.close() }
}
