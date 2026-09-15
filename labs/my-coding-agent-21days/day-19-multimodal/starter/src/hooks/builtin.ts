/**
 * 本课自带的四个钩子。本天新增。
 *
 * 挑这四个是有讲究的，它们正好覆盖了「钩子该干什么」的四个格子：
 *
 *   record-reads       post_tool 不阻断 只记一笔，给下面那个守卫用
 *   read-before-write  pre_tool  阻断   一条模型不该有机会违反的规矩
 *   format-after-write post_tool 不阻断 一件模型不必知道、做了就行的杂活
 *   test-after-write   post_tool 阻断   一个必须让模型知道结果的确定性判据
 *   workspace-check    session_start    一次性的环境前提检查
 *   leftover-tasks     session_end      收摊时的提醒
 *
 * 挑它们的判据是同一条：**一条规则如果你能用一个 if 判断出来，它就不该交给模型去记。**
 * 提示词能让模型「通常」做对，钩子让它「总是」做对——这两个词之间的差距，
 * 就是今天这一整套机制存在的全部理由。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { HookDef, HookInput, HookOutcome } from './types.js'
import type { TaskManager } from '../tasks/manager.js'

/** 会写文件的两个工具。和快照那一层用的是同一份名单（snapshot/capture.ts） */
const WRITE_TOOLS = ['edit_file', 'create_file']

/** 跑一条命令并拿回输出。刻意不复用 run_command 工具：那个工具带着 INJECT 的故障注入 */
function execCapture(
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<{ code: number | null; text: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let text = ''
    const take = (chunk: Buffer) => {
      if (text.length < 4000) text += chunk.toString('utf8').slice(0, 4000 - text.length)
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    const timer = setTimeout(() => {
      // 钩子的超时必须落到子进程上。run.ts 里那个 race 停不住任何东西，
      // 它只保证调用方不会一直等下去——真正杀掉进程的是这一行
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* 已经退了 */
        }
      }
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, text: `启动失败：${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, text })
    })
  })
}

function pathOf(input: HookInput): string {
  const value = input.args?.path
  return typeof value === 'string' ? value : ''
}

/**
 * 一与二：**先读后改**。一个记录者加一个守卫，靠闭包共用一个集合。
 *
 * 这条规矩现在就写在系统提示里（「改文件之前必须先 read_file 确认原文」），
 * 而模型大部分时候会遵守——**问题就出在「大部分时候」**：它偶尔凭记忆直接改，
 * 撞上一个已经被别人动过的文件，精确替换要么失败、要么替换错地方。
 * 把同一句话做成钩子，它就是百分之百。**这一对钩子是今天最该看懂的东西：
 * 一条规矩从提示词搬到代码里，可靠性从「通常」变成「总是」，代价是十几行。**
 *
 * 顺带说清它和第五天权限规则的分工，免得两者混起来：
 * **权限规则回答「谁有权做这件事」，钩子回答「这件事此刻做得对不对」。**
 * 权限规则是按工具名与路径匹配的静态表，它表达不了「这个文件本轮读过没有」——
 * 那依赖会话此刻的状态。凡是判据依赖状态或内容的，都只能是钩子。
 *
 * 它需要一个外部的状态（读过哪些文件），所以**用工厂函数把依赖闭包进去**，
 * HookInput 与 HookDef 一个字段都没加（第十三天定的规矩，十五、十六天都照它写）。
 */
export function createReadBeforeWrite(): HookDef[] {
  const seen = new Set<string>()
  return [
    {
      name: 'record-reads',
      event: 'post_tool',
      tools: ['read_file'],
      blocking: false,
      timeoutMs: 500,
      async run(input: HookInput): Promise<HookOutcome> {
        // 只有真的读成功了才算读过：一次失败的 read_file 什么都没告诉模型
        if (input.result?.ok) seen.add(pathOf(input))
        return { ok: true, note: `已读过的文件：${seen.size} 个` }
      },
    },
    {
      name: 'read-before-write',
      event: 'pre_tool',
      // **只管 edit_file，不管 create_file**：一个还不存在的文件读不了，
      // 把新建也拦下就是一条自相矛盾的规矩
      tools: ['edit_file'],
      blocking: true,
      timeoutMs: 500,
      async run(input: HookInput): Promise<HookOutcome> {
        const relative = pathOf(input)
        if (seen.has(relative)) return { ok: true, note: `${relative} 本轮读过，放行` }
        return {
          ok: false,
          // 失败信息里必须带下一步。只说「不许」的话模型会原样重试一次（第六天的教训）
          note: `${relative} 还没有用 read_file 读过，不能凭记忆做精确替换。请先读它，再改。`,
        }
      },
    },
  ]
}

/**
 * 二：写完就格式化。
 *
 * **不引 prettier**，本课零运行时依赖。这里做的是一个最小格式器：去掉行尾空白、
 * 统一换行、保证文件末尾恰好一个换行。它足够演示这一类钩子的全部要点了。
 *
 * 它不阻断，而且**只在真的改了东西时才回灌**。判据是那条：模型接下来的决策会不会因此不同。
 * 改了的话它需要知道（否则它下一步可能会拿改之前的原文去做精确替换，然后失败），
 * 没改的话说了也是废话。
 */
export const formatAfterWrite: HookDef = {
  name: 'format-after-write',
  event: 'post_tool',
  tools: WRITE_TOOLS,
  blocking: false,
  timeoutMs: 2000,
  async run(input: HookInput): Promise<HookOutcome> {
    const relative = pathOf(input)
    if (!/\.(js|mjs|json|md)$/.test(relative))
      return { ok: true, note: `${relative} 不在格式化范围内` }
    const target = path.join(input.cwd, relative)
    const before = await fs.readFile(target, 'utf8').catch(() => null)
    if (before === null) return { ok: false, note: `${relative} 读不到，跳过格式化` }
    const after = `${before
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n+$/, '')}\n`
    if (after === before) return { ok: true, note: `${relative} 格式已经是干净的` }
    await fs.writeFile(target, after, 'utf8')
    return {
      ok: true,
      note: `${relative} 格式化了（${before.length} → ${after.length} 字符）`,
      feed: `钩子已经把 ${relative} 的行尾空白与末尾空行清掉了，文件内容与你刚写的略有不同；下次做精确替换请以最新内容为准。`,
    }
  },
}

/**
 * 三：写完就跑测试。
 *
 * 它阻断，所以测试红的时候这次 edit_file 会被判成失败，失败原因就是测试输出。
 * 于是第六天那套自纠自动接手：模型看到的不是「成功了」，而是一份具体的失败报告。
 *
 * **这个钩子就是「钩子会拖慢每一次编辑」那笔账的主要出账方。** 沙盒仓库四个用例，
 * 一次 node --test 大约几百毫秒；真实仓库跑全量测试要几分钟，那时候这个钩子
 * 就必须换成「只跑受影响的那几个文件」，或者干脆挪到提交前那个触发点上。
 */
export const testAfterWrite: HookDef = {
  name: 'test-after-write',
  event: 'post_tool',
  tools: WRITE_TOOLS,
  blocking: true,
  timeoutMs: 20_000,
  async run(input: HookInput): Promise<HookOutcome> {
    // 工具自己就失败了的话不必跑测试：那次写入根本没发生
    if (input.result && !input.result.ok) return { ok: true, note: '上一步写入没成功，跳过测试' }
    if (!/\.(js|mjs)$/.test(pathOf(input))) return { ok: true, note: '改的不是源码，跳过测试' }
    const ran = await execCapture('node --test', input.cwd, 18_000)
    const passed = ran.code === 0
    const tail = ran.text
      .split('\n')
      .filter((line) => /^#?\s*(fail|pass|not ok|ok \d)/.test(line.trim()))
      .slice(-6)
    return {
      ok: passed,
      note: passed ? '测试全绿' : `测试还是红的（退出码 ${ran.code ?? '未知'}）`,
      feed: passed
        ? '钩子已经自动跑过 node --test，四个用例全绿，不需要你再跑一遍。'
        : `钩子自动跑了 node --test，仍然有用例失败：\n${tail.join('\n') || ran.text.slice(0, 600)}`,
    }
  },
}

/**
 * 四：会话开始时的环境检查（不阻断）。
 *
 * 它存在的意义是把 session_start 这个触发点写成真的。真实场景里它查的是
 * 「有没有装依赖」「分支对不对」这类**一次性的前提**——这些事每轮都查是浪费，
 * 但完全不查就会让整个会话建立在一个错误前提上。
 */
export const workspaceCheck: HookDef = {
  name: 'workspace-check',
  event: 'session_start',
  blocking: false,
  timeoutMs: 2000,
  async run(input: HookInput): Promise<HookOutcome> {
    const entries: string[] = await fs.readdir(input.cwd).catch(() => [])
    const ok = entries.includes('package.json') && entries.includes('src')
    return {
      ok,
      note: ok
        ? `工作区看起来是对的（${entries.length} 个顶层条目）`
        : '工作区里没有 package.json 或 src，先跑 /seed',
    }
  },
}

/**
 * 五：会话结束时提醒还有后台任务在跑（不阻断）。
 *
 * 它需要一个外部能力（任务表），所以**用工厂函数把依赖闭包进去**，
 * HookInput 一个字段都没加。这条是第十三天定下的规矩，第十五、十六天都按它写。
 */
export function createLeftoverCheck(tasks: TaskManager): HookDef {
  return {
    name: 'leftover-tasks',
    event: 'session_end',
    blocking: false,
    timeoutMs: 1000,
    async run(): Promise<HookOutcome> {
      const running = tasks.list().filter((task) => task.status === 'running')
      return {
        ok: running.length === 0,
        note:
          running.length === 0
            ? '没有还在跑的后台任务'
            : `还有 ${running.length} 个后台任务在跑（${running.map((t) => t.id).join('、')}），它们会被杀掉`,
      }
    },
  }
}

export function defaultHooks(tasks: TaskManager): HookDef[] {
  return [
    ...createReadBeforeWrite(),
    formatAfterWrite,
    testAfterWrite,
    workspaceCheck,
    createLeftoverCheck(tasks),
  ]
}
