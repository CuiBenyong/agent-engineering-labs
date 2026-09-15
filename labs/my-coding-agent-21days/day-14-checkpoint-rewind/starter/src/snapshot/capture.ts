/**
 * 拍快照：基线一次，每次写工具执行前后各一次。本天新增。
 *
 * 采集又是那层**透明包装**（第七天的落盘、第十二天的用量取样、第十三天的改动核对
 * 都是它）：事件原样传下去，路过时顺手拍一张。这已经是第四次用同一个形状，
 * 值得记住它的判据——**只观察、不改变事件流的东西，都该长成这样。**
 *
 * 为什么「前后各拍一次」而不是只拍改完的样子：
 *   - 只拍「改之后」，你能回到每一次改完的状态，但**回不到第一次改之前**——
 *     而那恰恰是「撤销这次任务」最常要的那个状态。
 *   - 只拍「改之前」，最后一次改完的样子没人记，回滚会莫名其妙丢掉最新一次改动。
 * 两张一起拍，代价只是多一条索引记录（内容一样时对象库自动去重，见 store.ts），
 * 收益是**每一次写入的两端都可达**。
 *
 * 还有一个不显眼但必须做对的点：**「改之前」要在工具真的动手之前拍。**
 * 所以它挂在 tool_start 上，不是在 tool_end 里补拍——tool_end 时文件已经改了，
 * 那时候读到的「改之前」是假的。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AgentEvent } from '../kernel/types.js'
import { walkFiles, resolveInside } from '../tools/fs.js'
import { putBlob } from './store.js'
import { CheckpointLog } from './log.js'

/** 会改文件的工具。它们的参数里有 path，那就是要拍的那个文件 */
const WRITE_TOOLS = new Set(['edit_file', 'create_file'])

/** 读一个文件的内容与 mtime。文件不存在时返回 null——那是要被记下来的信息 */
async function peek(
  cwd: string,
  relative: string
): Promise<{ content: string; mtimeMs: number } | null> {
  try {
    const target = resolveInside(cwd, relative)
    const [content, stat] = await Promise.all([fs.readFile(target, 'utf8'), fs.stat(target)])
    return { content, mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}

async function snap(
  log: CheckpointLog,
  cwd: string,
  relative: string,
  phase: 'baseline' | 'before' | 'after',
  tool: string
): Promise<void> {
  const seen = await peek(cwd, relative)
  if (!seen) {
    await log.append({ phase, tool, path: relative, hash: null, size: 0, mtimeMs: null })
    return
  }
  const { hash } = await putBlob(seen.content)
  await log.append({
    phase,
    tool,
    path: relative,
    hash,
    size: seen.content.length,
    mtimeMs: seen.mtimeMs,
  })
}

/**
 * 基线：mca 接手时仓库长什么样。
 *
 * 它让「回到什么都还没发生的时候」变成一个真实可达的状态。少了基线，最早能回到的
 * 是「第一次写入之前的那一个文件」，而任务往往动了好几个文件。
 *
 * 只拍一次：会话开始时。**不要每轮重拍**——重拍会把 Agent 自己的改动记成新基线，
 * 于是「未记录的改动」这条检查永远查不出东西。
 */
export async function captureBaseline(log: CheckpointLog, cwd: string): Promise<number> {
  const files = await walkFiles(cwd)
  for (const relative of files) await snap(log, cwd, relative, 'baseline', 'mca')
  return files.length
}

/** 透明包装：写工具执行前后各拍一张 */
export async function* watchSnapshots(
  log: CheckpointLog,
  cwd: string,
  events: AsyncIterable<AgentEvent>
): AsyncGenerator<AgentEvent> {
  const pending = new Map<string, { tool: string; path: string }>()

  // TODO(2)：现在**只拍「改之后」**。少一半记录、少一半代码，代价是
  // 「第一次改之前」那个状态谁都没记——而它恰恰是「撤销这次任务」最常要的那一个。
  // 补上 before 那一张。两个要求：
  //   一、挂在 tool_start 上，**不要**在 tool_end 里补拍——那时文件已经被改了，
  //      读到的「改之前」是假的。生成器在 yield 处挂住，所以 tool_start 这一刻
  //      循环还没恢复执行，工具也就还没动手。
  //   二、把 id 记进 pending，tool_end 才知道这次调用动的是哪个文件。
  for await (const event of events) {
    if (event.type === 'tool_start' && WRITE_TOOLS.has(event.call.name)) {
      const relative = pathOf(event.call.args)
      if (relative) pending.set(event.call.id, { tool: event.call.name, path: relative })
    }
    if (event.type === 'tool_end') {
      const waiting = pending.get(event.id)
      // 只有真的执行成功了才拍「改之后」：被审批门挡下、执行失败的调用没有改动任何东西，
      // 给它们拍一张会在时间线上留下一个看起来发生过、其实没发生的节点
      if (waiting && event.result.ok) {
        await snap(log, cwd, waiting.path, 'after', waiting.tool)
      }
      pending.delete(event.id)
    }
    yield event
  }
}

/** 从工具参数里取 path。参数解析不了就不拍——那次调用也执行不了 */
function pathOf(args: string): string | null {
  try {
    const parsed = JSON.parse(args || '{}') as Record<string, unknown>
    const relative = typeof parsed.path === 'string' ? parsed.path : ''
    // 顺手挡住跑出工作目录的路径：快照不该跟着工具去仓库外面写东西
    return relative && !path.isAbsolute(relative) ? relative : null
  } catch {
    return null
  }
}
