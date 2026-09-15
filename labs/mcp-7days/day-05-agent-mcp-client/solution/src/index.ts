// 入口。默认跑一遍自测；给了 QUESTION 就只跑一轮 Agent 循环。
// MOCK=1 用离线模型，不需要任何 key。
import 'dotenv/config'
import { MockModel, OpenRouterModel, runLoop, type ChatModel } from './agent.js'
import { ToolRegistry } from './registry.js'
import { runSelftest, serverSpecs } from './selftest.js'

const question = process.env.QUESTION

if (!question) {
  process.exit(await runSelftest())
}

const mock = process.env.MOCK === '1'
const apiKey = process.env.OPENROUTER_API_KEY ?? ''
if (!mock && !apiKey) {
  console.error('没有 OPENROUTER_API_KEY。要么填 .env，要么加 MOCK=1 用离线模型。')
  process.exit(1)
}

const model: ChatModel = mock
  ? new MockModel()
  : new OpenRouterModel(apiKey, process.env.MODEL ?? 'openai/gpt-4o-mini')

const registry = new ToolRegistry()
registry.connect(serverSpecs())
await registry.refresh()

console.log(`已聚合 ${registry.toolNames().length} 个工具：${registry.toolNames().join('、')}`)
if (registry.down.size > 0) {
  console.log(
    `掉线的服务端：${[...registry.down.entries()].map(([a, why]) => `${a}（${why}）`).join('，')}`
  )
}
console.log(`\n问：${question}\n`)

const loop = await runLoop(model, registry, question)
console.log(`调用过：${loop.used.join(' -> ') || '（没调工具）'}`)
console.log(`\n答：${loop.answer}\n`)

registry.closeAll()
