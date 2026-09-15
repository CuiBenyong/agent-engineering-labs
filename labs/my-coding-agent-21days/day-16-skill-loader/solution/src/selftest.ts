/**
 * 自检入口：不进 REPL，逐项验证今天该成立的十四件事，打印勾叉后按结果退出。
 *
 * 今天全部离线、全部可复现：技能包就在 skills/ 目录里、随实验分发，
 * 断言比的是字符数、估算 token、命中原因与决策结果——没有一项去比耗时，
 * 也没有一项依赖网络或端口（第十五天那个演示 server 今天用不着，所以不起它）。
 *
 * token 数是**估算**不是真值：这一天全程离线，没有任何 usage 可以校准，
 * 所以用的是第十二天那对默认系数。**同一段文字在同一台机器上算出来的数是确定的**，
 * 所以可复现；但它不等于任何一家模型的真实分词结果，这一点正文里也写清楚了。
 */
import { stdout } from 'node:process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { newSession } from './session-factory.js'
import { runTurn } from './turn.js'
import { createProvider } from './providers/index.js'
import { SessionLog } from './session/log.js'
import { seedRepo, REPO_DIR } from './seed.js'
import { contentToText, type ToolCall, type ToolContext } from './kernel/types.js'
import { parseFrontmatter, splitFrontmatter, FrontmatterError } from './skills/frontmatter.js'
import { scanSkills, readSkillBody, SKILLS_DIR, type SkillState } from './skills/scan.js'
import { matchSkills, hasWord } from './skills/trigger.js'
import { stage1Summary, stage2Bodies, fullLoadCost, SKILL_BLOCK_HEADER } from './skills/inject.js'

const out = (line: string) => stdout.write(`${line}\n`)
let passed = 0
let failed = 0

function check(ok: boolean, label: string): void {
  out(`${ok ? '✔' : '✘'} ${label}`)
  if (ok) passed += 1
  else failed += 1
}

const ctx: ToolContext = { cwd: REPO_DIR, signal: new AbortController().signal, log: () => {} }

/** 这一句同时命中三条技能：calc 约定（路径 + 触发词）、旧版约定（触发词）、测试手册（触发词） */
const BUSY_LINE = '按团队约定修一下 src/calc.js 里 divide 的除零问题，再跑一遍测试'

async function main(): Promise<void> {
  // 1. frontmatter：正文里的 --- 分隔线不能把文件切错
  const sample = ['---', 'name: demo', '---', '# 标题', '', '---', '', '正文'].join('\n')
  const split = splitFrontmatter(sample)
  check(
    split.head === 'name: demo' && split.body.includes('---') && split.body.endsWith('正文'),
    `分隔线：正文里那条 --- 留在了正文里（head ${split.head.length} 字符，body ${split.body.length} 字符）`
  )

  // 2. frontmatter：四种形状都解得出，看不懂的行要报错而不是猜
  const parsed = parseFrontmatter(
    [
      '---',
      'name: a',
      'priority: 20',
      'triggers: [x, "y, z"]',
      'paths:',
      '  - src/a.js',
      '---',
      'b',
    ].join('\n')
  )
  const bad = (() => {
    try {
      parseFrontmatter(['---', 'name = a', '---', ''].join('\n'))
      return '没有报错'
    } catch (error) {
      return error instanceof FrontmatterError ? error.message : '报了别的错'
    }
  })()
  check(
    parsed.fields.priority === 20 &&
      JSON.stringify(parsed.fields.triggers) === '["x","y, z"]' &&
      JSON.stringify(parsed.fields.paths) === '["src/a.js"]' &&
      bad.includes('既不是'),
    `子集解析：数字、带引号逗号的行内数组、多行数组都对；看不懂的行报「${bad.slice(0, 24)}…」`
  )

  // 3. 扫描与校验：坏掉的那个技能包被跳过，而且说清了缺什么
  const scanned = await scanSkills()
  const ids = scanned.skills.map((s) => s.id)
  check(
    ids.length === 4 &&
      !ids.includes('broken-no-description') &&
      scanned.problems.length === 1 &&
      (scanned.problems[0] ?? '').includes('缺 description'),
    `扫描：装上 ${ids.length} 个（${ids.join('、')}），跳过 1 个并说明原因「${(scanned.problems[0] ?? '').slice(0, 40)}…」`
  )

  // 4. 阶段一只有摘要，不含正文。反向确认它不是恒真：正文里那句话确实存在
  const stage1 = stage1Summary(scanned.skills)
  const calc = scanned.skills.find((s) => s.id === 'calc-conventions')
  if (!calc) throw new Error('扫描结果里没有 calc-conventions，后面的断言无从谈起')
  const calcBody = await readSkillBody(calc)
  check(
    calcBody.includes('判零只用') &&
      !stage1.text.includes('判零只用') &&
      stage1.text.includes('calc-conventions'),
    `阶段一：${stage1.chars} 字符 / 约 ${stage1.tokens} token，只有名字与用途；正文里那句「判零只用」没进去`
  )

  // 5. 全量加载与渐进加载的差值——今天的主现象
  const full = await fullLoadCost(scanned.skills)
  const hits = matchSkills(scanned.skills, { text: BUSY_LINE })
  const stage2 = await stage2Bodies(hits)
  const progressive = stage1.tokens + stage2.tokens
  const saved = full.tokens - progressive
  check(
    saved > 0 && progressive < full.tokens,
    `省下多少：全量加载 ${full.tokens} token，渐进加载这一轮 ${progressive} token（${stage1.tokens} 常驻 + ${stage2.tokens} 本轮），省下 ${saved}`
  )

  // 6. 一句不相干的话：一条都不命中，阶段二注入 0 字符
  const idle = await stage2Bodies(matchSkills(scanned.skills, { text: '今天先不干活了，随便聊聊' }))
  check(
    idle.message === null && idle.chars === 0 && idle.decisions.length === 0,
    `没命中的一轮：阶段二注入 ${idle.chars} 字符——渐进披露的省，大部分省在这种轮次上`
  )

  // 7. 触发判定的两类条件各自能单独成立，且命中原因说得出是哪一类
  const byPath = matchSkills(scanned.skills, { text: '看看 src/calc.js' })
  const byWord = matchSkills(scanned.skills, { text: '发版流程是什么' })
  check(
    byPath[0]?.skill.id === 'calc-conventions' &&
      (byPath[0]?.reasons ?? []).some((r) => r.includes('src/calc.js')) &&
      byWord[0]?.skill.id === 'release-notes' &&
      (byWord[0]?.reasons ?? []).some((r) => r.includes('触发词')),
    `命中原因：路径命中 ${byPath[0]?.skill.id}（${byPath[0]?.reasons[0]}），触发词命中 ${byWord[0]?.skill.id}`
  )

  // 8. 英文触发词按词边界匹配，中文按子串。这一条是误报的主要来源
  check(
    hasWord('run the test now', 'test') &&
      !hasWord('the latest contest', 'test') &&
      hasWord('先跑一遍测试看看', '测试') &&
      hasWord('用 node --test 跑', 'node --test'),
    '词边界：test 命中 run the test，但不命中 latest / contest；中文按子串；带空格的 node --test 也认'
  )

  // 9. 显式点名：一个触发词都没命中也能强制展开
  const pinned = await stage2Bodies(
    matchSkills(scanned.skills, { text: '随便说点什么', pinned: ['release-notes'] })
  )
  check(
    pinned.decisions.length === 1 &&
      pinned.decisions[0]?.loaded === true &&
      (pinned.decisions[0]?.hit.reasons ?? []).some((r) => r.includes('/skill')),
    `显式点名：一句完全不相干的话里也把 release-notes 展开了（${pinned.chars} 字符）`
  )

  // 10. 同时命中三条，两条不同领域的都装，同领域那条被分数更高的挡下
  const loaded = stage2.decisions.filter((d) => d.loaded).map((d) => d.hit.skill.id)
  const blocked = stage2.decisions.find((d) => !d.loaded)
  check(
    stage2.decisions.length === 3 &&
      loaded.length === 2 &&
      loaded.includes('calc-conventions') &&
      loaded.includes('node-test-runner') &&
      blocked?.hit.skill.id === 'legacy-calc-rules' &&
      (blocked?.why ?? '').includes('calc'),
    `同时命中三条：装了 ${loaded.join(' 与 ')}，legacy-calc-rules 被挡（${blocked?.why}）`
  )

  // 11. 预算这道闸：把预算压到只够一条，第二条要被挡下并说清是预算的原因
  const tight = await stage2Bodies(hits, 900)
  const cut = tight.decisions.filter((d) => !d.loaded && d.why.includes('预算'))
  check(
    tight.chars <= 900 && cut.length === 1 && tight.decisions.filter((d) => d.loaded).length === 1,
    `预算闸：预算压到 900 字符后只装下 1 条，另一条因为「${cut[0]?.why.slice(0, 28)}…」没装`
  )

  // 12. 阶段三：附件只出现命令行与一句说明，脚本正文一个字都没进上下文
  const scriptText = await fs.readFile(
    path.join(SKILLS_DIR, 'release-notes/scripts/bump-version.mjs'),
    'utf8'
  )
  const release = await stage2Bodies(matchSkills(scanned.skills, { text: '准备发版' }))
  const releaseText = release.message ? contentToText(release.message.content) : ''
  check(
    releaseText.includes('node ../../skills/release-notes/scripts/bump-version.mjs') &&
      releaseText.includes('补丁版本号加一') &&
      !releaseText.includes('readFile') &&
      scriptText.includes('readFile'),
    '阶段三：注入的是一行命令加一句说明；脚本正文里的 readFile 确实存在，但没进上下文'
  )

  // 13. 阶段三真的跑得通：从沙盒仓库出发，那条相对路径是对的
  await seedRepo()
  const before = JSON.parse(await fs.readFile(path.join(REPO_DIR, 'package.json'), 'utf8')) as {
    version?: string
  }
  const session = await freshSession()
  const bump: ToolCall = {
    id: 'c1',
    name: 'run_command',
    args: JSON.stringify({ command: 'node ../../skills/release-notes/scripts/bump-version.mjs' }),
  }
  const ran = await session.registry.execute(bump, ctx)
  const after = JSON.parse(await fs.readFile(path.join(REPO_DIR, 'package.json'), 'utf8')) as {
    version?: string
  }
  check(
    ran.ok && before.version !== after.version && after.version === '0.0.1',
    `附件跑得通：版本号从 ${before.version ?? '（没有）'} 升到 ${after.version}，命令行是照注入文本里那一行原样跑的`
  )

  // 14. 端到端：一句话同时命中两条技能，模型按技能里写的规矩改代码并跑测试
  await seedRepo()
  const e2e = await freshSession()
  const turn = await runTurn({
    session: e2e,
    provider: createProvider(),
    line: BUSY_LINE,
    write: () => {},
    out: () => {},
    approve: async () => ({ approved: true, scope: 'once' }),
    tty: false,
  })
  const block = e2e.messages.find(
    (m) => typeof m.content === 'string' && m.content.startsWith(SKILL_BLOCK_HEADER)
  )
  const used = turn.summary.tools.map((t) => t.name)
  const fixed = await fs.readFile(path.join(REPO_DIR, 'src/calc.js'), 'utf8')
  check(
    Boolean(block) &&
      used.join(',') === 'edit_file,run_command' &&
      fixed.includes("throw new Error('divide by zero')") &&
      e2e.registry.size === 8,
    `端到端：技能块进了消息数组、模型按约定改了 divide 并跑了测试，而工具清单仍是 ${e2e.registry.size} 个——技能不占工具的位置`
  )

  out(`${passed}/${passed + failed} 通过`)
  out(
    '（全部离线可复现：技能包就在 skills/ 目录里、不联网、不占端口，' +
      'token 数是第十二天那对默认系数算出来的估算值，同一台机器上连跑两次结果一样）'
  )
  if (failed > 0) process.exitCode = 1
}

/** 每次都用扫描出来的真实技能建会话，好让阶段一摘要真的进系统提示 */
async function freshSession() {
  const scanned = await scanSkills()
  const state: SkillState = { ...scanned, pinned: [] }
  return newSession(() => {}, await SessionLog.create(), { skills: state })
}

await main()
