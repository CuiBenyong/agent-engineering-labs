/**
 * 今天新增的三条斜杠命令。本天新增。
 *
 * 为什么单独一个文件而不是直接加进 commands.ts：那个文件已经 282 行，
 * 而本课的单文件上限是 350。命令表本来就是**数据**，数据按主题分文件、
 * 在总表里展开一下即可——D6 把命令从 repl.ts 搬出来时定的就是这条规矩，
 * 今天只是把它再往下分了一层。
 *
 * `/remember` 是记忆的**第一条写入路径**，也是今天两条路径里更该先有的那条：
 * 用户自己知道哪些坑值得记，而且他写下的东西他自己记得、能自己删。
 * 模型自动沉淀（`remember` 工具）是第二条，它省事，但它写的东西没人认领。
 */
import type { Command } from '../commands.js'
import { REPO_DIR } from '../seed.js'
import { SOURCE_LABEL, forget, load, write } from './store.js'
import { MEMORY_AGING_DAYS, MEMORY_BUDGET_CHARS, MEMORY_TOP_N, check } from './retrieve.js'
import { STATUS_LABEL, refreshMemory } from './index.js'

export const MEMORY_COMMANDS: Command[] = [
  {
    name: 'remember',
    help: '把一条事实写进长期记忆（/remember 这个仓库的测试要用 node --test）',
    run: async (args, session) => {
      if (!args) {
        session.out('  用法：/remember 这个仓库的测试要用 node --test，不要用 npm test')
        return true
      }
      const outcome = await write({ text: args, source: 'command' })
      if (!outcome.ok) {
        // 三类拦截的理由原样打给用户。**密钥那一类的话术里没有原文** ——见 memory/redact.ts
        session.out(`  ✘ 没有写入：${outcome.verdict.note}`)
        return true
      }
      if (outcome.duplicateOf) {
        session.out(`  这条已经记过了（${outcome.duplicateOf}），没有新增文件。`)
        return true
      }
      session.out(
        `  ✔ 已记下 ${outcome.memory.id}（关键词 ${outcome.memory.keys.slice(0, 6).join('、')}）。` +
          '下一次相关的话题会自动把它带进上下文。'
      )
      // 写完立刻按当前这句话重算一次槽位：否则用户得再说一句才看得见效果
      const refresh = await refreshMemory(session.messages, args)
      for (const row of refresh.report) session.out(`  ${row}`)
      return true
    },
  },
  {
    name: 'memory',
    help: '列出全部记忆与它们的核对状态；/memory 加一句话则演示这句话会命中哪几条',
    run: async (args, session) => {
      const memories = await load()
      if (args) {
        // 只算不改：把槽位刷到一个临时数组上，当前会话的上下文一个字不动
        const probe = await refreshMemory([...session.messages], args, { memories })
        for (const row of probe.report) session.out(`  ${row}`)
        session.out(
          `  判据：路径命中 3 分/个、关键词命中 2 分/个、用户写下的再加 1 分；` +
            `0 分不注入，最多 ${MEMORY_TOP_N} 条、${MEMORY_BUDGET_CHARS} 字符。`
        )
        return true
      }
      const checked = await check(memories, REPO_DIR)
      if (checked.length === 0) {
        session.out('  记忆目录是空的（/remember 写一条，或者让模型自己用 remember 工具沉淀）')
        return true
      }
      // 三行一条：谁写的 + 什么时候 + 核对状态、正文、核对说明。
      // **核对状态必须和正文并列显示** —— 一条锚点已经失效的记忆看起来和好记忆一模一样
      for (const { memory, status, note } of checked) {
        session.out(
          `  [${memory.id}] ${SOURCE_LABEL[memory.source]} · ${memory.at.slice(0, 10)} · ` +
            `${STATUS_LABEL[status]}\n      ${memory.text}\n      ${note}`
        )
      }
      session.out(
        `  锚点失效的不注入，只等你处理；没有锚点的超过 ${MEMORY_AGING_DAYS} 天会带一句「可能已经过期」。`
      )
      return true
    },
  },
  {
    name: 'forget',
    help: '删掉一条记忆（/forget m3）',
    run: async (args, session) => {
      const id = args.trim()
      if (!id) {
        session.out('  用法：/forget m3（/memory 看有哪些）')
        return true
      }
      // 删了个不存在的要说出来。**静默成功的删除是最难查的一类 bug** ——
      // 用户以为删掉了，下一轮那条记忆又出现在上下文里
      const gone = await forget(id)
      session.out(gone ? `  已删除 ${id}` : `  没有 ${id} 这条记忆，什么都没删（/memory 看有哪些）`)
      if (gone) {
        // 槽位里可能正挂着刚被删掉的那条，立刻重算
        await refreshMemory(session.messages, '')
      }
      return true
    },
  },
]
