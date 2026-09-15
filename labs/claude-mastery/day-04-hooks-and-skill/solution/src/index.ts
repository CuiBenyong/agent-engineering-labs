// D4 实验：hooks 事件模拟器。
// 不需要 Claude Code：读 .claude/settings.json，把三个假事件按 Claude Code 的方式（stdin JSON）喂给
// 匹配到的 hook 脚本，打印退出码与 stderr。用它快速迭代 hook 脚本，写好后再去真实的 Claude Code 里验证。
// MOCK=1 在这里没有意义（没有网络出口），接受但忽略。
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const projectDir = process.cwd()

interface HookCommand {
  type: string
  command: string
  timeout?: number
}
interface HookGroup {
  matcher?: string
  hooks: HookCommand[]
}
interface Settings {
  hooks?: Record<string, HookGroup[]>
}

interface HookEvent {
  label: string
  payload: {
    hook_event_name: string
    session_id: string
    cwd: string
    tool_name?: string
    tool_input?: Record<string, unknown>
  }
}

// 三个事件：两个 PreToolUse（一个该拦、一个该放），一个 Stop
const events: HookEvent[] = [
  {
    label: 'PreToolUse · Edit migrations/0001_init.sql（应被阻止）',
    payload: {
      hook_event_name: 'PreToolUse',
      session_id: 'sim',
      cwd: projectDir,
      tool_name: 'Edit',
      tool_input: {
        file_path: path.join(projectDir, 'migrations/0001_init.sql'),
        old_string: 'todos',
        new_string: 'tasks',
      },
    },
  },
  {
    label: 'PreToolUse · Write src/routes/todos.ts（应放行）',
    payload: {
      hook_event_name: 'PreToolUse',
      session_id: 'sim',
      cwd: projectDir,
      tool_name: 'Write',
      tool_input: { file_path: path.join(projectDir, 'src/routes/todos.ts'), content: '// …' },
    },
  },
  {
    label: 'Stop · 模型准备结束这一轮（测试全绿才放行）',
    payload: { hook_event_name: 'Stop', session_id: 'sim', cwd: projectDir },
  },
]

function loadSettings(): Settings {
  const file = path.join(projectDir, '.claude/settings.json')
  return JSON.parse(readFileSync(file, 'utf8')) as Settings
}

/** Claude Code 的 matcher 是对工具名的正则（省略或 "*" 表示全部） */
function matches(group: HookGroup, toolName: string | undefined): boolean {
  if (!group.matcher || group.matcher === '*') return true
  if (!toolName) return false
  return new RegExp(`^(${group.matcher})$`).test(toolName)
}

function runHook(
  cmd: HookCommand,
  event: HookEvent
): { code: number; stderr: string; stdout: string } {
  // 与 Claude Code 一致：命令经 shell 执行，${CLAUDE_PROJECT_DIR} 由环境变量提供，事件 JSON 走 stdin
  const res = spawnSync('sh', ['-c', cmd.command], {
    input: JSON.stringify(event.payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    timeout: (cmd.timeout ?? 600) * 1000,
  })
  return { code: res.status ?? 1, stderr: res.stderr ?? '', stdout: res.stdout ?? '' }
}

function describe(code: number): string {
  if (code === 0) return '放行（exit 0）'
  if (code === 2) return '阻止（exit 2）——stderr 会作为理由送回给模型'
  return `脚本出错但不阻止（exit ${code}）`
}

function main(): void {
  const settings = loadSettings()
  console.log(`项目：${projectDir}\n`)
  let blocked = 0
  for (const event of events) {
    console.log(`▶ ${event.label}`)
    const groups = settings.hooks?.[event.payload.hook_event_name] ?? []
    const cmds = groups.filter((g) => matches(g, event.payload.tool_name)).flatMap((g) => g.hooks)
    if (cmds.length === 0) {
      console.log('  没有匹配的 hook，直接放行\n')
      continue
    }
    for (const cmd of cmds) {
      const r = runHook(cmd, event)
      console.log(`  ${cmd.command}`)
      console.log(`  → ${describe(r.code)}`)
      if (r.stderr.trim())
        console.log(`  理由：${r.stderr.trim().split('\n').slice(-6).join('\n        ')}`)
      if (r.code === 2) blocked += 1
    }
    console.log()
  }
  console.log(`共 ${events.length} 个事件，${blocked} 个被阻止。`)
  console.log(
    blocked === 0
      ? '提示：一个都没拦住——hook 脚本还没写完（starter 的默认状态），或者测试全绿且没有碰 migrations/。'
      : '写好后去真实的 Claude Code 里：/hooks 看配置，再让它改 migrations/ 下的文件试试。'
  )
}

main()
