/**
 * 自检要用的素材与跑一轮的样板。本天新增，从 selftest.ts 拆出来。
 *
 * 为什么拆：那个文件写完十七项断言是 374 行，超过本课的单文件上限 350。
 * 而这里的东西和断言本来就是两层——**断言是「今天该成立什么」，素材是「怎么摆好现场」**。
 * 第九天的 instructions/fixtures.ts 拆的也是同一类东西，形状照抄它。
 *
 * 手写记忆文件这件事顺便有个好处：**它同时也在验存储层那个手写解析器。**
 * put 写出去的是 serialize 的结果，load 读回来的是 parseMemory 的结果，
 * 两边对不上自检立刻红。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { BASE_PROMPT, newSession, type Session } from '../commands.js'
import { run } from '../kernel/loop.js'
import { renderTurn, type RenderSummary } from '../render.js'
import { createProvider } from '../providers/index.js'
import { SessionLog } from '../session/log.js'
import { recordTurn } from '../session/record.js'
import { REPO_DIR } from '../seed.js'
import type { Message } from '../kernel/types.js'
import { instructionSources, loadInstructions } from '../instructions/index.js'
import { MEMORY_DIR, serialize, type Memory } from './store.js'
import { refreshMemory } from './index.js'

/** 手写一条记忆文件。at 可以指定，用来造「一条很旧的记忆」 */
export async function put(memory: Memory): Promise<void> {
  await fs.mkdir(MEMORY_DIR, { recursive: true })
  await fs.writeFile(path.join(MEMORY_DIR, `${memory.id}.md`), serialize(memory), 'utf8')
}

export function memoryOf(partial: Partial<Memory> & { id: string; text: string }): Memory {
  return {
    source: 'model',
    at: new Date().toISOString(),
    keys: [],
    paths: [],
    ...partial,
  }
}

export async function wipeMemory(): Promise<void> {
  await fs.rm(MEMORY_DIR, { recursive: true, force: true })
}

/** 把记忆目录里每个文件的原文拼起来。断言「密钥一个字节都没落盘」要用它 */
export async function dumpMemoryFiles(): Promise<string> {
  const names = await fs.readdir(MEMORY_DIR).catch(() => [] as string[])
  const bodies = await Promise.all(
    names.map((name) => fs.readFile(path.join(MEMORY_DIR, name), 'utf8'))
  )
  return bodies.join('')
}

export interface TurnResult {
  summary: RenderSummary
  messages: Message[]
  refreshed: Awaited<ReturnType<typeof refreshMemory>>
}

/** 开一条会话。**每次调用都是一条全新的会话**：新日志、新消息数组、空历史 */
export async function openSession(): Promise<Session> {
  const instructions = await loadInstructions({ ...instructionSources(), base: BASE_PROMPT })
  return newSession(() => {}, await SessionLog.create(), { instructions })
}

/**
 * 在给定会话里跑一轮，跑法和 REPL 完全一致：**先刷记忆槽位，再压用户消息。**
 * 顺序反了就验不出今天的东西——槽位得在这一轮的请求里，不是下一轮。
 *
 * 审批一律按「这次可以」回答：今天验的不是审批，而今天新增的 remember 不是只读工具。
 */
export async function turn(session: Session, userText: string): Promise<TurnResult> {
  const refreshed = await refreshMemory(session.messages, userText)
  session.messages.push({ role: 'user', content: userText })
  const summary = await renderTurn(
    recordTurn(
      session.log,
      session.messages,
      run({
        provider: createProvider(),
        registry: session.registry,
        messages: session.messages,
        cwd: REPO_DIR,
        gate: {
          state: session.permissions,
          approve: async () => ({ approved: true, scope: 'session' }),
        },
      })
    ),
    () => {},
    { tty: false }
  )
  return { summary, messages: session.messages, refreshed }
}
