/**
 * /hooks：列出挂着哪些钩子，以及一个总开关。本天新增。
 *
 * **总开关不是可选的。** 钩子是一层会悄悄改变每次工具调用行为的东西，
 * 一旦某个钩子写坏了（比如误拦一类本该放行的路径），用户必须有办法当场关掉它
 * 再继续干活，而不是「去改代码、重启、重来一次」。这条和第十六天 /skills 的
 * 理由是同一个：**看不见的机制必须至少可查、可关。**
 */
import type { Command } from '../commands.js'

export const HOOK_COMMANDS: Command[] = [
  {
    name: 'hooks',
    help: '列出挂着的钩子；/hooks off 全部关掉，/hooks on 打开',
    run: (args, session) => {
      const arg = args.trim().toLowerCase()
      if (arg === 'off' || arg === 'on') {
        session.hooks.enabled = arg === 'on'
        session.out(
          `  钩子已${session.hooks.enabled ? '打开' : '关闭'}（关闭期间工具调用不再经过任何检查）`
        )
        return true
      }
      session.out(`  总开关：${session.hooks.enabled ? '开' : '关'}`)
      for (const hook of session.hooks.hooks) {
        const scope = hook.tools ? hook.tools.join('、') : '全部工具'
        session.out(
          `  ${hook.name}  ${hook.event}  ${hook.blocking ? '阻断' : '只警告'}  ${hook.timeoutMs}ms  作用于 ${scope}`
        )
      }
      session.out(
        '  阻断的含义按触发点不同：pre_tool 是「工具不执行」，post_tool 是「这次调用判成失败」'
      )
      return true
    },
  },
]
