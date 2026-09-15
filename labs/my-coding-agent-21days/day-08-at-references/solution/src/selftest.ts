/**
 * 自检入口：不进 REPL，逐项验证今天该成立的十二件事，打印勾叉后按结果退出。
 *
 * 今天不需要子进程：`@` 引用这条链路的每一步都是可以直接调用的纯函数或者文件操作，
 * 网页抓取在 MOCK=1 下走内置样例页（不发任何网络请求）。
 * 需要注入用的素材（二进制、超大文件）自检自己造在 work/fixtures 里。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { stdout } from 'node:process'
import { newSession } from './commands.js'
import { pushUserTurn, referenceRoots } from './repl.js'
import { run } from './kernel/loop.js'
import { renderTurn } from './render.js'
import { createProvider } from './providers/index.js'
import { SessionLog, SESSIONS_DIR } from './session/log.js'
import { recordTurn } from './session/record.js'
import { parseReferences, unescapeAt } from './refs/parse.js'
import { expandReferences } from './refs/expand.js'
import { applyBudget, estimateTokens, truncateMiddle } from './refs/budget.js'
import { buildInjection } from './refs/inject.js'
import { extractText } from './refs/web.js'
import { seedRepo, REPO_DIR } from './seed.js'
import { contentToText } from './kernel/types.js'

const out = (line: string) => stdout.write(`${line}\n`)
let passed = 0
let failed = 0

function check(ok: boolean, label: string): void {
  out(`${ok ? '✔' : '✘'} ${label}`)
  if (ok) passed += 1
  else failed += 1
}

const FIXTURES = path.resolve(process.cwd(), 'work/fixtures')
const roots = () => referenceRoots()

async function expandOne(text: string) {
  return expandReferences(parseReferences(text), { roots: roots() })
}

async function main(): Promise<void> {
  await fs.rm(SESSIONS_DIR, { recursive: true, force: true })
  await seedRepo()
  await fs.mkdir(FIXTURES, { recursive: true })
  // 二进制：带一个空字节就够了，判据和 read_file 一致
  await fs.writeFile(path.join(FIXTURES, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x4e]))
  // 超大：超过硬上限，应该被拒绝而不是截断
  await fs.writeFile(path.join(FIXTURES, 'huge.txt'), 'x'.repeat(260_000), 'utf8')
  // 中等：在硬上限内，但会超过「单源上限」，应该被截断
  await fs.writeFile(path.join(FIXTURES, 'notes.txt'), 'y'.repeat(4000), 'utf8')

  // 1. 解析：三类形态、邮箱不算、转义、引号包住空格、尾部标点不吃进来
  const refs = parseReferences(
    '看看 @src/calc.js。还有 @src/ 和 @https://example.com/doc 与 @"src/my file.js"，' +
      '发给 eric@example.com，别读 \\@src/secret，另外 @**/*.js'
  )
  const kinds = refs.map((r) => `${r.kind}:${r.target}`)
  check(
    refs.length === 5 &&
      kinds[0] === 'path:src/calc.js' &&
      kinds[1] === 'path:src/' &&
      kinds[2] === 'url:https://example.com/doc' &&
      kinds[3] === 'path:src/my file.js' &&
      kinds[4] === 'glob:**/*.js' &&
      unescapeAt('\\@src') === '@src',
    `解析出 ${refs.length} 条引用：路径、目录、网址、带空格的引号路径、通配符各一条；邮箱与 \\@ 转义都没被当成引用`
  )

  // 2. 文件引用：带行号、注明相对哪个根；两个根都能命中
  const [inRepo] = await expandOne('@src/calc.js')
  const [inCwd] = await expandOne('@work/repo/README.md')
  check(
    inRepo?.content.includes('相对 work/repo') === true &&
      inRepo.content.includes('1\texport function add') &&
      inRepo.tier === 'named' &&
      inCwd?.content.includes('相对 当前目录') === true,
    '文件引用带行号注入（格式与 read_file 一致），并注明解析到了哪个根'
  )

  // 3. 目录引用只给文件树，不给内容
  const [tree] = await expandOne('@src/')
  check(
    tree?.content.includes('目录 src/') === true &&
      tree.content.includes('calc.js') &&
      !tree.content.includes('export function add'),
    '目录引用只展开成文件清单，一个字节的文件内容都不注入'
  )

  // 4. 通配符展开出多个来源，且它们是二级（预算不够时先丢它们）
  const globbed = await expandOne('@**/*.js')
  check(
    globbed.length >= 2 && globbed.every((s) => s.tier === 'derived'),
    `通配符展开出 ${globbed.length} 个来源，全部标成二级（用户点的是模式，不是这些具体文件）`
  )

  // 5. 不存在的路径：人话提示，且要说清在哪儿找过
  const [missing] = await expandOne('@src/nope.js')
  check(
    missing?.problem?.includes('找不到') === true &&
      missing.problem.includes('work/repo') &&
      missing.content === '',
    `不存在的路径给出人话提示并说明找过哪些根：${missing?.problem}`
  )

  // 6. 二进制文件：拒绝，不注入乱码
  const [binary] = await expandOne('@work/fixtures/logo.png')
  check(
    binary?.problem?.includes('二进制') === true && binary.content === '',
    `二进制文件被拒绝：${binary?.problem}`
  )

  // 7. 超大文件：拒绝而不是截断，并给出下一步
  const [huge] = await expandOne('@work/fixtures/huge.txt')
  check(
    huge?.problem?.includes('太大了') === true &&
      huge.problem.includes('read_file') &&
      huge.content === '',
    `超大文件被拒绝而不是截断，并给出了下一步：${huge?.problem?.slice(0, 40)}…`
  )

  // 8. 网址引用（MOCK 下走内置样例页）：抽出正文，脚本与样式被整块删掉
  const [page] = await expandOne('@https://example.com/calc-doc')
  check(
    page?.content.includes('divide(a, b) 在 b 为 0 时必须抛出错误') === true &&
      !page.content.includes('window.analytics') &&
      !page.content.includes('font:14px') &&
      page.content.includes('来源：https://example.com/calc-doc'),
    '网址引用抽出了正文，script 与 style 被整块删掉，并且标注了来源'
  )

  // 9. 预算：单源超限先截断（截完不超上限），总量还超就从最后一条二级来源开始丢
  const budgeted = applyBudget(
    [
      { label: 'named.txt', tier: 'named', content: 'a'.repeat(3000) },
      { label: 'derived-1.txt', tier: 'derived', content: 'b'.repeat(900) },
      { label: 'derived-2.txt', tier: 'derived', content: 'c'.repeat(900) },
    ],
    2000
  )
  const [named, d1, d2] = budgeted.sources
  check(
    named?.truncated === true &&
      named.chars <= 1000 &&
      named.dropped === false &&
      d2?.dropped === true &&
      d1?.dropped === false &&
      budgeted.totalChars <= 2000 &&
      truncateMiddle('z'.repeat(500), 200).length <= 200,
    `预算 2000 时：一级来源截到 ${named?.chars} 字符但保留，最后一条二级来源被丢掉，总量 ${budgeted.totalChars} 字符不超预算`
  )

  // 10. 报账：来源清单带字符数、估算 token 与占预算比例
  const injection = await buildInjection('解释一下 @src/calc.js 和 @src/nope.js', {
    roots: roots(),
  })
  check(
    injection.report[0]?.includes('引用注入 1 个来源') === true &&
      injection.report[0].includes('token') &&
      injection.report[0].includes('%') &&
      injection.report.some((row) => row.startsWith('  ✔')) &&
      injection.report.some((row) => row.startsWith('  ✘')) &&
      estimateTokens('中文四个字') === 5,
    `终端报账：${injection.report[0]}`
  )

  // 11. 注入是单独一条消息、用户原话一个字不改，而且这一轮不需要任何工具调用
  const session = newSession(() => {}, await SessionLog.create())
  const line = '解释一下 @src/calc.js 里的 divide 哪里有问题'
  // 走 REPL 真正用的那条路径，而不是在自检里另拼一遍消息
  await pushUserTurn(session, line)
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
          approve: async () => ({ approved: false, scope: 'once' }),
        },
      })
    ),
    () => {},
    { tty: false }
  )
  const injected = session.messages.find(
    (m) => m.role === 'user' && contentToText(m.content).startsWith('以下是用户用 @')
  )
  const userSaid = session.messages.filter((m) => m.role === 'user').at(1)
  check(
    injected !== undefined &&
      contentToText(userSaid?.content ?? '') === line &&
      summary.tools.length === 0 &&
      summary.text.includes('Infinity'),
    `注入自成一条消息、用户原话原样保留；材料到位之后这一轮 ${summary.tools.length} 次工具调用就给出了结论`
  )

  // 顺手确认正文提取那三步的顺序没写反（先删块再删标签）
  check(
    extractText('<style>p{color:red}</style><p>正文一</p><script>x=1</script><p>正文二</p>') ===
      '正文一\n正文二',
    '正文提取先整块删 script 与 style，再把标签换成空白，脚本代码没有变成正文'
  )

  out(`${passed}/${passed + failed} 通过`)
  if (failed > 0) process.exitCode = 1
}

await main()
