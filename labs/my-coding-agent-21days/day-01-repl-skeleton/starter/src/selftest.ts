/**
 * 自检入口：不进 REPL，逐项验证今天该成立的四件事，打印勾叉后按结果退出。
 *
 * 为什么每天都要有它：mca 是 REPL，在无交互终端（CI、脚本、subagent 的 shell）下
 * stdin 会立刻 EOF，程序打印一行提示就退出，exit code 是 0 但一行业务代码都没跑。
 * 只看退出码，你会拿到一个「跑通了」的假结论。
 */
import { stdout } from 'node:process'
import { newSession, parseCommand, COMMANDS } from './repl.js'
import { run } from './kernel/loop.js'
import { renderTurn } from './render.js'
import { createProvider } from './providers/index.js'
import { GatewayProvider } from './providers/gateway.js'
import { MockProvider } from './providers/mock.js'
import { seedRepo } from './seed.js'

const out = (line: string) => stdout.write(`${line}\n`)
let passed = 0
let failed = 0

function check(ok: boolean, label: string): void {
  out(`${ok ? '✔' : '✘'} ${label}`)
  if (ok) passed += 1
  else failed += 1
}

async function main(): Promise<void> {
  // 1. 沙盒仓库
  const files = await seedRepo()
  check(files.length === 4, `沙盒仓库已生成（work/repo，${files.length} 个文件）`)

  // 2. 命令与对话在入口处分流
  const parsed = parseCommand('/help')
  const notCommand = parseCommand('帮我看看这个仓库')
  const unknown = COMMANDS.find((c) => c.name === 'nope')
  check(
    parsed?.name === 'help' && notCommand === null && unknown === undefined,
    '斜杠命令与对话被正确分流，未知命令能被识别出来'
  )

  // 3. 离线剧本真的在「流」：分片数大于一，拼起来是完整回答
  const session = newSession(() => {})
  session.messages.push({ role: 'user', content: '你是谁' })
  const provider = createProvider()
  const summary = await renderTurn(
    run({ provider, registry: session.registry, messages: session.messages }),
    () => {}
  )
  check(
    provider.id === 'mock' && summary.deltas > 1 && summary.text.includes('mca'),
    `离线剧本吐出 ${summary.deltas} 个增量，拼接后是完整回答`
  )

  // 4. 只改环境变量就能换网关：同一段代码，不同 provider
  const before = {
    url: process.env.LLM_BASE_URL,
    key: process.env.LLM_API_KEY,
    mock: process.env.MOCK,
  }
  process.env.MOCK = ''
  process.env.LLM_BASE_URL = 'https://example.invalid/v1'
  process.env.LLM_API_KEY = 'sk-selftest'
  process.env.LLM_MODEL = 'some-vendor-model-id'
  const gateway = createProvider()
  process.env.MOCK = '1'
  const mock = createProvider()
  process.env.LLM_BASE_URL = before.url ?? ''
  process.env.LLM_API_KEY = before.key ?? ''
  process.env.MOCK = before.mock ?? ''
  check(
    gateway instanceof GatewayProvider &&
      gateway.model === 'some-vendor-model-id' &&
      mock instanceof MockProvider,
    '同一段代码只靠环境变量就在真实网关与离线剧本之间切换'
  )

  out(`${passed}/${passed + failed} 通过`)
  if (failed > 0) process.exitCode = 1
}

await main()
