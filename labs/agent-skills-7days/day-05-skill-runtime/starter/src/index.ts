import 'dotenv/config'
import { activate, type Message } from './activate.js'
import { buildCatalog, catalogCost, estimateTokens } from './catalog.js'
import { scanSkills } from './scan.js'
import { selectSkill } from './select.js'

/** 作用域按优先级从高到低排：项目级压过用户级。 */
const SCOPES = [
  { label: '项目级', dir: 'fixtures/project/.agents/skills' },
  { label: '用户级', dir: 'fixtures/user/.agents/skills' },
]

const QUERY = '这几个文件我要提交了，帮我写个提交信息'

function section(title: string) {
  console.log(`\n===== ${title} =====`)
}

async function main() {
  // ---------- 阶段一 · 发现 ----------
  section('阶段一 发现：扫描 + 解析')
  const { skills, diagnostics, shadowed } = await scanSkills(SCOPES)
  console.log(`扫到 ${skills.length} 个可用 skill：${skills.map((s) => s.name).join('、')}`)
  for (const d of diagnostics) {
    console.log(`  ${d.level === 'error' ? '跳过' : '告警'}  ${d.skillPath}\n         ${d.message}`)
  }
  if (shadowed.length > 0) {
    for (const s of shadowed) console.log(`  遮蔽  ${s.name}：生效 ${s.winner}，被盖 ${s.loser}`)
  }

  section('阶段一 发现：目录与它的固定开销')
  const catalog = buildCatalog(skills)
  for (const { name, tokens } of catalogCost(skills))
    console.log(`  ${name.padEnd(18)} ${String(tokens).padStart(4)} token`)
  console.log(`目录整体约 ${estimateTokens(catalog)} token —— 这是每一轮都要重发的固定开销`)

  // ---------- 阶段二 · 激活 ----------
  section('阶段二 激活')
  const messages: Message[] = [{ role: 'user', content: QUERY }]
  const activated = new Set<string>()
  const picked = await selectSkill(skills, QUERY)
  console.log(`用户说：${QUERY}`)
  console.log(`模型选中：${picked ?? 'none'}`)

  let injectedTokens = 0
  if (picked) {
    const skill = skills.find((s) => s.name === picked)
    if (skill) {
      const first = await activate(messages, skill, activated)
      injectedTokens = first.tokens
      console.log(`注入正文：${first.injected ? '是' : '否'}，约 ${first.tokens} token`)
      const again = await activate(messages, skill, activated) // 去重演示
      console.log(
        `同一个 skill 再激活一次：${again.injected ? '又注入了一遍（错）' : '被去重挡住（对）'}`
      )
    }
  }

  // ---------- 阶段三 · 执行 ----------
  // 换一句话，激活一个**带附件**的 skill，看阶段三的资源清单长什么样
  section('阶段三 执行：附带资源只列不读')
  const second = await selectSkill(skills, '帮我写个这一版的发布报告')
  const secondSkill = skills.find((s) => s.name === second)
  if (secondSkill) {
    const r = await activate(messages, secondSkill, activated)
    injectedTokens += r.tokens
    console.log(`第二句话选中：${second}，注入正文约 ${r.tokens} token`)
  }
  const lastSkillMessage = [...messages]
    .reverse()
    .find((m) => m.content.startsWith('<skill_content'))
  const resourceLines = (lastSkillMessage?.content.match(/<file>(.+?)<\/file>/g) ?? []).map((l) =>
    l.replace(/<\/?file>/g, '')
  )
  console.log(
    resourceLines.length > 0
      ? `列出了 ${resourceLines.length} 个资源：${resourceLines.join('、')}（内容没有被读进上下文）`
      : '这个 skill 没有附带资源'
  )

  // ---------- 账单 ----------
  section('上下文构成')
  const bodiesIfAllLoaded = skills.reduce((n, s) => n + estimateTokens(s.body), 0)
  console.log(`渐进式加载：目录 ${estimateTokens(catalog)} + 已激活正文 ${injectedTokens} token`)
  console.log(`若全量加载全部正文：额外 ${bodiesIfAllLoaded} token，而且每一轮都要重发`)

  section('自检')
  const checks: Array<[string, boolean]> = [
    ['扫到了至少 3 个 skill', skills.length >= 3],
    ['缺 description 的被跳过', !skills.some((s) => s.name === 'no-description')],
    ['name 与目录名不一致的只告警仍加载', skills.some((s) => s.name === 'NameMismatch')],
    ['description 里有裸冒号的仍能加载', skills.some((s) => s.name === 'broken-yaml')],
    ['同名冲突时项目级胜出', shadowed.some((s) => s.name === 'commit-message')],
    ['只有被选中的两个进了上下文，其余没有', activated.size === 2],
    ['重复激活被去重', messages.filter((m) => m.content.startsWith('<skill_content')).length === 2],
    ['带附件的 skill 列出了资源但没有读它们', resourceLines.length > 0],
  ]
  let ok = true
  for (const [label, passed] of checks) {
    console.log(`  ${passed ? '✅' : '❌'} ${label}`)
    ok &&= passed
  }
  console.log(ok ? '\n全部通过' : '\n有检查项未通过，看上面的 ❌')
  process.exitCode = ok ? 0 : 1
}

await main()
