// SELFTEST=1 的验收入口：进程起来之后自己走完「列镜头 → 改台词 → 重生成 → 校验半径 → 回滚」，
// 逐项打勾叉再按结果设置退出码。常驻服务没法用管道喂输入，这是本课统一的验收方式。

import { readFile } from 'node:fs/promises'
import { sha1, type ReviewStore } from './store.js'
import type { CallCounter } from './fixtures.js'
import { nodeId, TIMELINE_NODE } from './model.js'
import { PORT } from './server.js'

type Json = Record<string, unknown>

const base = `http://127.0.0.1:${PORT}`
const get = (p: string) => fetch(base + p).then((r) => r.json() as Promise<Json>)
const post = (p: string, body: Json) =>
  fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json() as Promise<Json>)

export async function selftest(store: ReviewStore, calls: CallCounter): Promise<boolean> {
  const checks: [string, boolean, string?][] = []
  const check = (name: string, ok: boolean, detail?: string) => checks.push([name, ok, detail])

  const before = (await get('/api/run')) as unknown as {
    shots: { id: string; current: number; versions: unknown[] }[]
  }
  check(
    '列出镜头：三镜各一版',
    before.shots.length === 3 && before.shots.every((s) => s.current === 1),
    `${before.shots.length} 镜`
  )

  const v1voice = await sha1(store.current('s02').artifacts[nodeId('s02', 'voice')])
  const snapshot = { ...calls }

  const edited = (await post('/api/shots/s02/edit', {
    field: 'dialogue',
    value: '五分钟后？谁在跟我开玩笑',
  })) as unknown as { affected: string[] }
  const want = [nodeId('s02', 'voice'), TIMELINE_NODE]
  check(
    '改台词只波及配音与时间轴，不碰首帧与视频',
    JSON.stringify(edited.affected) === JSON.stringify(want),
    edited.affected.join('、')
  )

  const v2 = (await post('/api/shots/s02/regenerate', {})) as unknown as {
    version: number
    regenerated: string[]
    dialogue: string
  }
  check(
    '重生成产出第 2 版，且只重跑了受影响节点',
    v2.version === 2 && JSON.stringify(v2.regenerated) === JSON.stringify(want),
    `v${v2.version} 重跑 ${v2.regenerated.join('、')}`
  )

  const spent = {
    image: calls.image - snapshot.image,
    video: calls.video - snapshot.video,
    tts: calls.tts - snapshot.tts,
  }
  check(
    '这次重生成没碰图像与视频接口，只合成了一次语音',
    spent.image === 0 && spent.video === 0 && spent.tts === 1,
    `图像 ${spent.image} 次 / 视频 ${spent.video} 次 / 语音 ${spent.tts} 次`
  )

  const others = (await get('/api/run')) as unknown as { shots: { id: string; current: number }[] }
  check(
    '没被波及的镜头版本号没动',
    others.shots.filter((s) => s.id !== 's02').every((s) => s.current === 1)
  )

  await post('/api/shots/s02/rollback', { version: 1 })
  const rolled = store.current('s02')
  const backVoice = (await sha1(rolled.artifacts[nodeId('s02', 'voice')])) === v1voice
  check(
    '回滚到 v1：台词与配音都回到旧版本',
    rolled.version === 1 && rolled.dialogue === '五分钟后？这不可能' && backVoice
  )

  await post('/api/shots/s03/review', {
    verdict: 'redo',
    tags: ['face-inconsistent', 'subtitle-overflow'],
    comment: '女主脸型与定妆图不一致',
  })
  const saved = JSON.parse(await readFile(store.run.path('review.json'), 'utf8')) as {
    reviews: { shotId: string; verdict: string; tags: string[] }[]
  }
  const note = saved.reviews.find((r) => r.shotId === 's03')
  check(
    '审核意见按结构化字段落盘，能被下一次自动化读回',
    note?.verdict === 'redo' && note.tags.length === 2
  )

  console.log('\n自检结果：')
  for (const [name, ok, detail] of checks)
    console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? `（${detail}）` : ''}`)
  const passed = checks.every(([, ok]) => ok)
  console.log(passed ? '\n全部通过。' : '\n有未通过项：去 starter 的练习点看看还差什么。')
  return passed
}
