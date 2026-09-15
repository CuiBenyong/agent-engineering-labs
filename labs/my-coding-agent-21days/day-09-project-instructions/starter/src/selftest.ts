/**
 * 自检入口：不进 REPL，逐项验证今天该成立的十五件事，打印勾叉后按结果退出。
 *
 * 今天全部都能在本进程里验完：三层发现、导入展开、合并与冲突、报账、预算、恢复。
 * 唯一需要跑真循环的是最后一项——「规矩真的影响了它的行为」，判据是工具调用的参数值。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { stdout } from 'node:process'
import { BASE_PROMPT, newSession } from './commands.js'
import { openSession, pushUserTurn } from './repl.js'
import { run } from './kernel/loop.js'
import { renderTurn } from './render.js'
import { createProvider } from './providers/index.js'
import { SessionLog, SESSIONS_DIR } from './session/log.js'
import { recordTurn } from './session/record.js'
import { seedRepo, REPO_DIR } from './seed.js'
import { contentToText } from './kernel/types.js'
import { discover, findRepoRoot, INSTRUCTION_FILE } from './instructions/discover.js'
import { expandImports } from './instructions/imports.js'
import { mergeInstructions, parseDirectives } from './instructions/merge.js'
import { formatContext, instructionSources, loadInstructions } from './instructions/index.js'
import { seedInstructions } from './instructions/fixtures.js'

const out = (line: string) => stdout.write(`${line}\n`)
let passed = 0
let failed = 0

function check(ok: boolean, label: string): void {
  out(`${ok ? '✔' : '✘'} ${label}`)
  if (ok) passed += 1
  else failed += 1
}

async function main(): Promise<void> {
  await fs.rm(SESSIONS_DIR, { recursive: true, force: true })
  // 顺序：仓库先建（seedRepo 会把 work/repo 整个重建），指令文件后造
  await seedRepo()
  const seeded = await seedInstructions(true)
  const sources = instructionSources()

  // 1. 仓库根靠标记文件往上找，不靠猜层数
  const root = await findRepoRoot(sources.start)
  check(
    root === REPO_DIR,
    `从 work/repo/src 往上找到仓库根 ${path.relative(process.cwd(), root)}（标记是 package.json）`
  )

  // 2. 三层都被发现，顺序是「越具体越靠后」
  const found = await discover(sources)
  check(
    found.length === 3 &&
      found[0]?.layer === 'user' &&
      found[1]?.layer === 'project' &&
      found[2]?.layer === 'directory' &&
      found[2]?.label === 'work/repo/src/AGENTS.md',
    `发现 ${found.length} 层指令：${found.map((f) => f.layer).join(' → ')}（外层在前）`
  )

  // 3. 软链接去重：同一个真实文件不会被当成两层各加载一次
  const linked = await discover({ home: seeded.linkedHome, start: REPO_DIR })
  check(
    linked.length === 1,
    `软链接指向同一个文件时只算一层（发现 ${linked.length} 条），不会在 prompt 里出现两遍`
  )

  // 4. 导入展开：项目级把 .mca/ 下两个文件拉了进来，深度分别是 1 和 2
  const project = await expandImports(path.join(REPO_DIR, INSTRUCTION_FILE), { root: REPO_DIR })
  check(
    project.files.length === 2 &&
      project.files.some((f) => f.depth === 1) &&
      project.files.some((f) => f.depth === 2) &&
      project.text.includes('node:assert/strict') &&
      project.problems.length === 0,
    `项目级指令展开了 ${project.files.length} 个导入（最深 2 层），第二层的内容也进来了`
  )

  // 5. 循环导入：给出清晰错误、跳过这一层，且不会栈溢出
  const cycle = await expandImports(path.join(seeded.badDir, 'cycle-a.md'), {
    root: seeded.badDir,
  })
  check(
    cycle.problems.some((p) => p.includes('循环导入') && p.includes('→')) &&
      cycle.text.includes('甲') &&
      cycle.text.includes('乙'),
    `循环导入被检测到并打印了整条链：${cycle.problems.find((p) => p.includes('循环导入'))?.slice(0, 52)}…`
  )

  // 6. 深度上限：第四层不展开，前三层照常生效
  const deep = await expandImports(path.join(seeded.badDir, 'deep-1.md'), { root: seeded.badDir })
  check(
    deep.problems.some((p) => p.includes('深度上限 3')) &&
      deep.text.includes('四：第三层导入，刚好在上限上') &&
      !deep.text.includes('五：第四层，不该被展开'),
    '第四层导入被深度上限挡下来，前三层照常生效（坏一行不让整个文件失效）'
  )

  // 7. 重复导入只算一次（菱形不是循环）
  const dup = await expandImports(path.join(seeded.badDir, 'dup-1.md'), { root: seeded.badDir })
  check(
    dup.problems.some((p) => p.includes('已经被导入过一次')) &&
      dup.text.split('四：两边都想要我').length === 2,
    '菱形导入里同一个文件只进 prompt 一次，第二次跳过并说明（这不是循环）'
  )

  // 8. 越界导入被拒：判据是解析成绝对路径之后还在不在根里面
  const escaped = await expandImports(path.join(seeded.badDir, 'escape.md'), {
    root: seeded.badDir,
  })
  check(
    escaped.problems.some((p) => p.includes('允许的根之外')) &&
      !escaped.text.includes('"dependencies"'),
    '想跳出根的导入被拒绝，根之外的文件一个字节都没进来'
  )

  // 9. 合并顺序：基座在最前，然后用户级 → 项目级 → 目录级
  const loaded = await loadInstructions({ ...sources, base: BASE_PROMPT })
  const at = (needle: string) => loaded.prompt.indexOf(needle)
  check(
    at('你是 mca') === 0 &&
      at('用户级指令') > 0 &&
      at('用户级指令') < at('项目级指令') &&
      at('项目级指令') < at('目录级指令'),
    '合并顺序是基座 → 用户级 → 项目级 → 目录级，越具体越靠后'
  )

  // 10. 冲突：三层都写了「测试命令」，最后那条赢，被覆盖的两条从正文里删掉了
  const conflict = loaded.report.conflicts.find((c) => c.key === '测试命令')
  check(
    loaded.report.conflicts.length === 1 &&
      conflict?.winner.value === 'node --test test/calc.test.js' &&
      conflict.losers.length === 2 &&
      !loaded.prompt.includes('npm test') &&
      !loaded.prompt.includes('- 测试命令：node --test\n'),
    `「测试命令」冲突 3 条，最终生效「${conflict?.winner.value}」，被覆盖的 ${conflict?.losers.length} 条已从 prompt 里删掉`
  )

  // 11. 报账：段数、字符数、估算 token、占预算比例，以及冲突表
  const rows = formatContext(loaded.report)
  check(
    rows[0]?.includes('system prompt 共 4 段') === true &&
      rows[0].includes('其中三层指令') &&
      rows[0].includes('占指令预算') &&
      rows.some((row) => row.includes('含导入 2 个文件')) &&
      rows.some((row) => row.includes('最终生效')),
    `/context 报账：${rows[0]}`
  )

  // 12. 指令解析只认「- 键：值」这一种形状，散文不会被误判成指令
  const directives = parseDirectives(
    '- 测试命令：node --test\n这一层的文件改完，立刻跑一次上面那条测试命令。\n',
    'x'
  )
  check(
    directives.length === 1 && directives[0]?.key === '测试命令',
    `一段带散文的指令里只解析出 ${directives.length} 条「键：值」，散文没被误判`
  )

  // 13. 预算：超了从最不具体的那一层开始截断，一层都不整条丢
  const tight = mergeInstructions(
    BASE_PROMPT,
    [
      { kind: 'user', label: 'u', text: 'u'.repeat(900), imports: [], problems: [] },
      { kind: 'project', label: 'p', text: 'p'.repeat(900), imports: [], problems: [] },
      { kind: 'directory', label: 'd', text: 'd'.repeat(900), imports: [], problems: [] },
    ],
    2200
  )
  const [, u, p, d] = tight.report.segments
  check(
    u?.truncated === true &&
      p?.truncated === false &&
      d?.truncated === false &&
      tight.report.instructionChars <= 2200 &&
      tight.prompt.includes('目录级指令'),
    `预算不够时先截最不具体的那一层（用户级 900 → ${u?.chars} 字符），目录级一个字没动`
  )

  // 14. 恢复会话时用**当下**的指令，不用日志里那段旧的
  const first = newSession(() => {}, await SessionLog.create(), loaded)
  await first.log.flushMessages(first.messages)
  const dirFile = path.join(sources.start, INSTRUCTION_FILE)
  await fs.appendFile(dirFile, '\n- 提交前：先跑一次 node --test\n', 'utf8')
  const reloaded = await loadInstructions({ ...sources, base: BASE_PROMPT })
  const resumed = await openSession(() => {}, { resume: first.log.id }, reloaded)
  check(
    contentToText(resumed.messages[0]?.content ?? '').includes('提交前') &&
      resumed.messages[0]?.role === 'system',
    '恢复会话时 system prompt 按当下的指令文件重新拼过（规矩不属于历史）'
  )

  // 15. 规矩真的改变了它的行为：判据是工具调用的参数值，不是它嘴上说什么。
  //     这里放行审批（默认规则里 `node --test*` 那条匹配不到带路径的形式，会来问一句），
  //     因为我们要看的是命令**真的跑了**，而不是被门挡下来的一条记录
  const session = newSession(() => {}, await SessionLog.create(), loaded)
  await pushUserTurn(session, '跑一下测试')
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
  const command = session.messages
    .flatMap((m) => m.toolCalls ?? [])
    .map((call) => call.args)
    .find((args) => args.includes('node --test'))
  check(
    contentToText(session.messages[0]?.content ?? '').includes('node --test test/calc.test.js') &&
      summary.tools.length === 1 &&
      summary.tools[0]?.name === 'run_command' &&
      summary.tools[0]?.blockedBy === undefined &&
      command?.includes('test/calc.test.js') === true,
    `目录级那条测试命令进了 system prompt，模型也真的执行了它：${command}`
  )

  out(`${passed}/${passed + failed} 通过`)
  if (failed > 0) process.exitCode = 1
}

await main()
