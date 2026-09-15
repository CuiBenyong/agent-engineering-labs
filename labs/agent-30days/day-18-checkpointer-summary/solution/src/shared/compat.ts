// 检查点的第三笔代价：**恢复时的版本兼容**。
//
// 检查点里存的是「当时那个版本的代码眼里的状态形状」。你改一次字段名、加一次必填字段，
// 库里已经躺着的旧检查点就跟新代码对不上了——而它们不会消失，用户随时可能点进去继续。
// 这不是理论问题：一条只活了一天的对话线，在你发版之后就是一条「老检查点」。
//
// 最坏的地方在于**它多数时候不抛错**：旧行里没有的字段读出来是 undefined，
// 拼进文案就是 "undefined"，参与算术就是 NaN，一路静默走到用户面前。

import type { Attachment, Task } from './state'

/** 当前代码认识的状态版本。每次改状态形状都要 +1，并在下面补一条迁移。 */
export const STATE_VERSION = 2

/** v1 时代的附件：引用字段叫 url，后来为了和「内容」区分开改名成 ref。 */
interface LegacyAttachment {
  id: string
  kind: 'image' | 'audio' | 'file'
  url?: string
  ref?: string
  caption?: string
}

/** v1 时代的子任务：还没有 toolCalls，预算是在 Executor 内部数的。 */
interface LegacyTask {
  id: string
  goal: string
  result?: string
  toolCalls?: number
  status: 'pending' | 'running' | 'done' | 'failed'
}

/**
 * 把一份旧检查点里的状态迁到当前形状。
 *
 * 三条纪律：
 * 1. **在读的那一侧迁移**，不要写脚本批量刷库——库里的检查点可能有几千万条，
 *    而其中绝大多数再也不会被打开，刷它们是纯浪费；读时迁移只对真的被恢复的那条付钱。
 * 2. **迁移函数只补默认值和改名，不做业务判断**。它要是会失败，你就没法恢复了。
 * 3. **旧字段读完就丢**，不要为了「保险」两个字段一起留——留着就会有代码去读旧的那个。
 */
export function migrateAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return []
  return (raw as LegacyAttachment[]).map((a) => ({
    id: a.id,
    kind: a.kind,
    // v1 → v2：url 改名成 ref。改名是最容易出静默 bug 的一种迁移，
    // 因为不迁移也不报错，只是每处读 ref 的地方都拿到 undefined。
    ref: a.ref ?? a.url ?? '',
    caption: a.caption,
  }))
}

export function migrateWorkspace(raw: unknown): Task[] {
  if (!Array.isArray(raw)) return []
  return (raw as LegacyTask[]).map((t) => ({
    id: t.id,
    goal: t.goal,
    result: t.result,
    // v1 没有这个字段。不补默认值，`toolCalls + 1` 就是 NaN，
    // 于是 `NaN >= TOOL_BUDGET` 恒为 false——预算上限在恢复出来的那条线上彻底失效。
    toolCalls: t.toolCalls ?? 0,
    status: t.status,
  }))
}

/** 迁移前的样子——自检里拿它演示「不迁移会怎样」。 */
export function attachmentRefs(attachments: { ref?: string }[]): string[] {
  return attachments.map((a) => String(a.ref))
}
