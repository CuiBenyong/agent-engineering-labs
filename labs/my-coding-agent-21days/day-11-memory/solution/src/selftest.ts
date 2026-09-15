/**
 * 自检入口：不进 REPL，逐项验证今天该成立的十七件事，打印勾叉后按结果退出。
 *
 * 今天不需要子进程：记忆这条链路上的每一步都是可以直接调用的纯函数或者文件操作，
 * 而今天没有用到任何 `INJECT` 取值（记忆没有对应的故障注入，取值表里也不许自造新值）。
 * 需要「一条很旧的记忆」「一条锚点已经失效的记忆」这类素材时，自检直接把文件写出来——
 * 存储层的格式就是给人手写的，这也顺便验证了那个手写解析器。
 *
 * 最要紧的一项是第 15–16 项：**两条互不相干的会话，第二条的历史是空的**，
 * 而第一条会话记下的那句事实回到了第二条的请求里。这就是「跨会话记忆」的定义。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { stdout } from 'node:process'
import { BASE_PROMPT } from './commands.js'
import { SESSIONS_DIR } from './session/log.js'
import { seedRepo, REPO_DIR } from './seed.js'
import { contentToText, type Message } from './kernel/types.js'
import { seedInstructions } from './instructions/fixtures.js'
import { estimateTokens } from './refs/budget.js'
import { MEMORY_DIR, forget, load, parseMemory, write } from './memory/store.js'
import { MEMORY_TOP_N, check, retrieve } from './memory/retrieve.js'
import { MEMORY_PREFIX, slotCost } from './memory/inject.js'
import { createMemoryTool } from './memory/tool.js'
import { refreshMemory } from './memory/index.js'
import { dumpMemoryFiles, memoryOf, openSession, put, turn, wipeMemory } from './memory/fixtures.js'
import { FAKE_KEY, TEST_FACT } from './mock-script.js'

const out = (line: string) => stdout.write(`${line}\n`)
let passed = 0
let failed = 0

function expect(ok: boolean, label: string): void {
  out(`${ok ? '✔' : '✘'} ${label}`)
  if (ok) passed += 1
  else failed += 1
}

const ctx = { cwd: REPO_DIR, signal: new AbortController().signal, log: () => {} }

/** 直接调一次 remember 工具，绕过模型 */
async function callTool(args: unknown) {
  return createMemoryTool().run(args, ctx)
}

async function main(): Promise<void> {
  await fs.rm(SESSIONS_DIR, { recursive: true, force: true })
  await seedRepo()
  await seedInstructions(true)
  await wipeMemory()

  // 1. 文件格式往返：写进去、从盘上读回来，六个字段一个不差（含锚点）
  const written = await write({
    text: '这个仓库的 divide 用例一直没人修，别当成新引入的回归',
    source: 'command',
    keys: ['divide', '用例', '回归'],
    paths: ['test/calc.test.js'],
    anchor: { path: 'test/calc.test.js', contains: 'divide' },
  })
  const reloaded = (await load())[0]
  expect(
    written.ok &&
      reloaded !== undefined &&
      reloaded.id === 'm1' &&
      reloaded.source === 'command' &&
      reloaded.keys.join(',') === 'divide,用例,回归' &&
      reloaded.paths.join(',') === 'test/calc.test.js' &&
      reloaded.anchor?.contains === 'divide',
    `一条记忆一个文件：m1.md 写盘再读回来，来源/时间/关键词/路径/锚点五样都还在`
  )

  // 2. 坏文件跳过而不是让整个功能瘫掉；解析器对坏格式返回 null 而不抛
  await fs.writeFile(path.join(MEMORY_DIR, 'broken.md'), '这不是记忆格式', 'utf8')
  const afterBroken = await load()
  expect(
    parseMemory('x', '这不是记忆格式') === null &&
      parseMemory('x', 'source: nope\n\n正文') === null &&
      afterBroken.length === 1,
    '坏掉的记忆文件被跳过（其余 1 条照常加载），解析器返回 null 而不是修补出一条假事实'
  )
  await fs.rm(path.join(MEMORY_DIR, 'broken.md'))

  // 3. 同一条事实写两遍不新增文件
  const again = await write({ text: written.ok ? written.memory.text : '', source: 'model' })
  expect(
    again.ok && again.duplicateOf === 'm1' && (await load()).length === 1,
    '同一条事实再写一遍：认出是 m1，没有新增第二个文件'
  )

  // 4. 密钥硬拦：拒绝、话术里不含原文、目录里任何一个字节都没有它
  const secret = await callTool({ text: `网关 key 是 ${FAKE_KEY}` })
  const dumped = await dumpMemoryFiles()
  expect(
    secret.ok === false &&
      secret.content.includes('密钥的形状') &&
      secret.content.includes('轮换') &&
      !secret.content.includes(FAKE_KEY) &&
      !dumped.includes(FAKE_KEY),
    '密钥被拒绝写入，拒绝话术里没有原文的任何一段，记忆目录里也搜不到它'
  )

  // 5. 临时结论软拦：说清它属于会话日志，并给出改法
  const transient = await callTool({ text: '现在那个 divide 用例是红的' })
  expect(
    transient.ok === false &&
      transient.content.includes('会话日志') &&
      transient.content.includes('去掉时间词'),
    `临时结论被拒绝并指路：${transient.content.slice(0, 30)}…`
  )

  // 6. 代码里已经写着的软拦：指出命中哪个文件、命中的是哪一段
  const inCode = await callTool({ text: 'src/calc.js 里有一个 subtract 函数，做的是 a 减 b' })
  expect(
    inCode.ok === false &&
      inCode.content.includes('src/calc.js') &&
      inCode.content.includes('subtract') &&
      inCode.content.includes('常驻'),
    '代码里已经写着的事被拒绝，并点名命中的文件与片段（src/calc.js 的 subtract）'
  )

  // 7. 只注入相关的：相关的一句话命中并给出原因，无关的一句话一条都不注入
  await wipeMemory()
  await put(
    memoryOf({
      id: 'm1',
      text: TEST_FACT,
      source: 'model',
      keys: ['测试', '验证', 'node'],
      paths: ['package.json'],
      anchor: { path: 'package.json', contains: 'node --test' },
    })
  )
  const checked = await check(await load(), REPO_DIR)
  const related = retrieve(checked, '我该怎么验证改动有没有问题')
  const unrelated = retrieve(checked, '帮我看看 README 的排版')
  expect(
    related.hits.length === 1 &&
      related.hits[0]?.reasons.some((r) => r.includes('关键词')) === true &&
      unrelated.hits.length === 0,
    `相关的一句话命中 1 条（${related.hits[0]?.reasons.join('、')}），无关的一句话 0 条`
  )

  // 8. 路径判据比关键词硬：提到路径的那条分更高
  const byPath = retrieve(checked, '看一下 package.json')
  expect(
    byPath.hits.length === 1 && byPath.hits[0]?.reasons.some((r) => r.startsWith('路径')) === true,
    `提到 package.json 时靠路径命中（${byPath.hits[0]?.score} 分：${byPath.hits[0]?.reasons.join('、')}）`
  )

  // 9. 条数上限：五条全命中也只注入前三条，其余进 spilled
  for (let i = 2; i <= 6; i += 1) {
    await put(memoryOf({ id: `m${i}`, text: `第 ${i} 条关于测试的经验`, keys: ['测试'] }))
  }
  const many = retrieve(await check(await load(), REPO_DIR), '说说测试')
  expect(
    many.hits.length === MEMORY_TOP_N && many.spilled.length === 3 && many.scanned === 6,
    `6 条全命中「测试」，只注入前 ${many.hits.length} 条，另 ${many.spilled.length} 条挂在候选里`
  )

  // 10. 来源加权：同分时用户亲手写下的排在模型沉淀的前面
  await wipeMemory()
  await put(memoryOf({ id: 'm1', text: '模型沉淀的那条', source: 'model', keys: ['排序'] }))
  await put(memoryOf({ id: 'm2', text: '用户写下的那条', source: 'command', keys: ['排序'] }))
  const ranked = retrieve(await check(await load(), REPO_DIR), '排序')
  expect(
    ranked.hits[0]?.memory.id === 'm2' && ranked.hits[0]?.memory.source === 'command',
    `同样命中一个关键词时，用户写下的 m2（${ranked.hits[0]?.score} 分）压过模型沉淀的 m1（${ranked.hits[1]?.score} 分）`
  )

  // 11. 槽位是原地替换不是追加：连刷三次，数组里始终只有一条记忆消息，且紧跟 system
  const messages: Message[] = [{ role: 'system', content: BASE_PROMPT }]
  for (const query of ['排序', '排序', '排序']) {
    await refreshMemory(messages, query)
  }
  const slots = messages.filter(
    (m) => m.role === 'user' && contentToText(m.content).startsWith(MEMORY_PREFIX)
  )
  expect(
    slots.length === 1 && messages.length === 2 && messages[1] === slots[0],
    `刷 3 次记忆槽位，消息数组里始终只有 1 条记忆消息（共 ${messages.length} 条），位置紧跟 system`
  )

  // 12. 报账：字符数与估算 token 用的是同一个估算器（第八天那个），不是另算一份
  const cost = slotCost(messages)
  const slotText = contentToText(messages[1]?.content ?? '')
  const noHit = await refreshMemory(messages, '完全不相关的一句话')
  expect(
    cost.chars === slotText.length &&
      cost.tokens === estimateTokens(slotText) &&
      noHit.action === 'removed' &&
      slotCost(messages).chars === 0,
    `槽位占 ${cost.chars} 字符、约 ${cost.tokens} token（与第八天同一个估算器）；一条都不命中时槽位被整条拿掉`
  )

  // 13. 用之前先核对：锚点失效的不注入，只列在待核对里；很旧又没锚点的带上提醒
  await wipeMemory()
  await put(
    memoryOf({
      id: 'm1',
      text: '这个仓库用 pnpm build:calc 打包',
      keys: ['打包'],
      anchor: { path: 'package.json', contains: 'build:calc' },
    })
  )
  await put(
    memoryOf({
      id: 'm2',
      text: '用户偏好中文回复，代码注释也用中文',
      keys: ['打包', '中文'],
      at: '2020-01-01T00:00:00.000Z',
    })
  )
  const verified = retrieve(await check(await load(), REPO_DIR), '打包')
  expect(
    verified.stale.length === 1 &&
      verified.stale[0]?.memory.id === 'm1' &&
      verified.stale[0]?.note.includes('build:calc') === true &&
      verified.hits.length === 1 &&
      verified.hits[0]?.status === 'aging' &&
      verified.hits[0]?.note.includes('先核对') === true,
    `锚点失效的 m1 不注入只等人处理（${verified.stale[0]?.note}）；很旧又没锚点的 m2 照样注入但带「先核对」`
  )

  // 14. /forget 删掉一条；删不存在的要说出来而不是静默成功
  expect(
    (await forget('m1')) === true && (await forget('m9')) === false && (await load()).length === 1,
    '删掉 m1 之后目录只剩 1 条；删一个不存在的 id 返回「没删到」而不是静默成功'
  )

  // 15. 会话一：模型自己判断值得记，调 remember 沉淀一条（非只读，过审批门）
  await wipeMemory()
  const first = await openSession()
  const sediment = await turn(first, '记一下：这个仓库的测试怪在哪')
  const stored = await load()
  const memoryTool = createMemoryTool()
  expect(
    sediment.summary.tools.some((t) => t.name === 'remember' && t.ok) &&
      memoryTool.readOnly === false &&
      stored.length === 1 &&
      stored[0]?.source === 'model' &&
      stored[0]?.anchor?.path === 'package.json',
    `会话一：模型自己调 remember 记下 1 条（来源「模型沉淀」、带 package.json 锚点）；` +
      `这个工具不是只读的，所以它过了审批门`
  )

  // 16. 会话二：全新的空历史，问一个相关问题，会话一记下的事实回到了这一轮的请求里
  const second = await openSession()
  const historyBefore = second.messages.length
  const recall = await turn(second, '我该怎么验证改动有没有问题')
  const slot = second.messages.find(
    (m) => m.role === 'user' && contentToText(m.content).startsWith(MEMORY_PREFIX)
  )
  const ranTests = second.messages
    .filter((m) => m.role === 'tool' && m.name === 'run_command')
    .map((m) => contentToText(m.content))
    .join('')
  expect(
    historyBefore === 1 &&
      recall.refreshed.action === 'inserted' &&
      slot !== undefined &&
      contentToText(slot.content).includes(TEST_FACT) &&
      recall.summary.tools.some((t) => t.name === 'run_command') &&
      // 命令跑出来是「红的」（沙盒仓库那个用例本来就没修），所以只断言它真的跑了、
      // 而且跑的是记忆里说的那条路子——工具结果里能看到失败的那个用例名
      ranTests.includes('divide by zero'),
    `会话二（历史只有 1 条 system）问了一句相关的话，会话一那条事实自己回到请求里` +
      `（命中原因：${recall.refreshed.retrieval.hits[0]?.reasons.join('、')}），` +
      `模型照它给的做法跑了 node --test，结果里出现了失败的那个用例`
  )

  // 17. 会话三：模型想把 key 记进记忆，被拒绝并读到理由，下一轮自己改成记「变量名」
  await wipeMemory()
  const third = await openSession()
  const blocked = await turn(third, '把我的 key 记下来')
  const afterBlock = await load()
  const onDisk = await dumpMemoryFiles()
  const remembers = blocked.summary.tools.filter((t) => t.name === 'remember')
  expect(
    remembers.length === 2 &&
      remembers[0]?.ok === false &&
      remembers[1]?.ok === true &&
      afterBlock.length === 1 &&
      afterBlock[0]?.text.includes('LLM_API_KEY') === true &&
      !onDisk.includes(FAKE_KEY),
    `会话三：第一次 remember 带着密钥被拒（${remembers.length} 次调用里第 1 次失败），` +
      `模型读了理由之后改成记住变量名；落盘的 1 条记忆里没有密钥原文`
  )

  out(`${passed}/${passed + failed} 通过`)
  if (failed > 0) process.exitCode = 1
}

await main()
