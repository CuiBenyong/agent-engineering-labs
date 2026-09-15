/**
 * INJECT=dirty：在 mca 拍好基线之后、回滚之前，往仓库里塞一段「用户自己手写的改动」。
 * 本天新增。
 *
 * 为什么注入点在这一层：全课的 INJECT 口径是「注入写在它该发生的那一层」，
 * 而这一条模拟的不是网关故障、也不是工具故障，是**工作区状态**——
 * 它属于快照层要处理的世界。
 *
 * 注入的时机比内容更重要：它必须发生在基线之后。基线是「mca 接手时仓库长什么样」，
 * 注入在基线之前就成了基线的一部分，那么「未记录的改动」这条检查永远查不出东西
 * ——这正是自检要钉住的那条判据。
 */
import fs from 'node:fs/promises'
import { resolveInside } from '../tools/fs.js'

const inject = process.env.INJECT ?? ''

/**
 * 用户自己在改的那一段。它从没进过任何一次快照，所以回滚会让它永久消失。
 *
 * 故意选 README.md：**它是 Agent 这次任务不会碰的文件。** 这一点是必须的——
 * 如果注入到 Agent 接下来要改的那个文件上，写工具执行前那张「改之前」的快照
 * 会把这段手写内容一起记下来，于是它就变成「记录过的」了，检查也就查不出东西。
 * 现实里也是这个形状：你在写文档，它在改代码，两边同时动着一个工作区。
 */
const HAND_WRITTEN = `
## 我自己在写的一节

这一段是我手打的，还没提交。回滚要是把它冲掉，我没有任何办法找回来。
`

export interface DirtyInjection {
  applied: boolean
  path: string
}

export async function applyDirtyInjection(cwd: string): Promise<DirtyInjection> {
  if (inject !== 'dirty') return { applied: false, path: '' }
  const relative = 'README.md'
  const target = resolveInside(cwd, relative)
  await fs.appendFile(target, HAND_WRITTEN, 'utf8')
  return { applied: true, path: relative }
}
