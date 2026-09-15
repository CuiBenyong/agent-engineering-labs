import type { Config } from './index'
import { createInfra } from './infra/index'
import { SHARD_COUNT, shardOf } from './shard'
import { MessageStore, ShardWorker } from './worker'

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !pred()) await new Promise((r) => setTimeout(r, 50))
  return pred()
}

/**
 * 自检剧本（SELFTEST=1）：worker 是常驻循环，裸跑不会退出，所以在一个进程里起两个 worker
 * 循环，按脚本走完「各抢一批 shard → 杀掉持有者 → 另一个在 TTL 后接手 → 同用户顺序没乱
 * → 假死的前任被护栏拦住」，每步带时间戳，最后按结果设退出码。
 */
export async function runSelfTest(cfg: Config): Promise<boolean> {
  const t0 = Date.now()
  const stamp = (): string => `[t+${((Date.now() - t0) / 1000).toFixed(2)}s]`
  const results: boolean[] = []
  const check = (label: string, ok: boolean, detail: string): void => {
    results.push(ok)
    console.log(`${stamp()} ${label}${detail} ${ok ? '✅' : '❌'}`)
  }

  const infra = await createInfra()
  const clock = `TTL ${cfg.leaseTtlMs}ms / 续约 ${cfg.renewIntervalMs}ms`
  console.log(`${stamp()} === D10 自检开始（基础设施=${infra.kind}）===`)
  console.log(`${stamp()} 生产口径 TTL 30000ms / 续约 10000ms；自检等比压缩 10 倍 → ${clock}`)

  // [1/5] userId 哈希分片：同一个 userId 永远落在同一个 shard，且分布均匀
  const same = new Set(Array.from({ length: 5 }, () => shardOf('u-0042')))
  const buckets = new Array<number>(SHARD_COUNT).fill(0)
  for (let i = 0; i < 2000; i += 1) buckets[shardOf(`u-${String(i).padStart(4, '0')}`)] += 1
  const used = buckets.filter((n) => n > 0).length
  const top = Math.max(...buckets)
  const d1 = `同一 userId 五次都落在 shard ${[...same][0]}；2000 个用户占 ${used}/256 个 shard，最大桶 ${top} 条（理想 8）`
  check('[1/5] shardOf 稳定且分布均匀：', same.size === 1 && used >= 250 && top <= 25, d1)

  // [2/5] 两个 worker 各抢一批 shard，互不重叠
  const sink = new MessageStore()
  const mk = (id: string): ShardWorker =>
    new ShardWorker(id, infra, sink, cfg, (m) => console.log(`${stamp()} [${id}] ${m}`))
  const a = mk('worker-A')
  const b = mk('worker-B')
  a.start()
  b.start()
  await waitFor(() => a.lease.held.size + b.lease.held.size >= SHARD_COUNT, 3_000)
  const overlap = [...a.lease.held.keys()].filter((s) => b.lease.held.has(s))
  const union = new Set([...a.lease.held.keys(), ...b.lease.held.keys()])
  const d2 = `A 持有 ${a.lease.held.size} 个、B 持有 ${b.lease.held.size} 个，交集 ${overlap.length} 个，并集 ${union.size} 个`
  check(
    '[2/5] 两个 worker 分走 256 个 shard：',
    overlap.length === 0 && union.size === SHARD_COUNT,
    d2
  )

  // [3/5] 8 个用户各 3 条，只能由持有对应 shard 的 worker 按 seq 顺序处理
  const users = Array.from({ length: 8 }, (_, i) => `u-${1000 + i}`)
  for (const u of users) {
    for (let seq = 1; seq <= 3; seq += 1) {
      await infra.bus.publish(shardOf(u), { userId: u, seq, text: `第 ${seq} 句话` })
    }
  }
  await waitFor(() => users.every((u) => sink.of(u).length >= 3), 4_000)
  const bad = users.filter((u) => {
    const holder = a.lease.held.has(shardOf(u)) ? 'worker-A' : 'worker-B'
    const rows = sink.of(u)
    return rows.map((r) => r.seq).join() !== '1,2,3' || rows.some((r) => r.worker !== holder)
  })
  check('[3/5] 消息只被持有者按序处理：', bad.length === 0, `异常用户 ${bad.length}/8 个`)

  // [4/5] 杀掉持有者 → 另一个在 TTL 后接手 → 同一个用户的 seq 仍然严格递增
  const user = users[0]
  const shard = shardOf(user)
  const victim = a.lease.held.has(shard) ? a : b
  const survivor = victim === a ? b : a
  const stale = victim.lease.held.get(shard) ?? 0
  console.log(`${stamp()} 模拟 kill -9：${victim.id} 停续约、不 release，内存里仍记着持有 ${shard}`)
  victim.freeze()
  const killedAt = Date.now()
  for (let seq = 4; seq <= 6; seq += 1) {
    await infra.bus.publish(shard, { userId: user, seq, text: `第 ${seq} 句话` })
  }
  // 让「已经死掉的」victim 领走 seq=4 却永远不 ack，制造一条在途消息：
  // 接管者必须先把它 claim 回来才能读 seq=5，否则顺序会被插队。
  await infra.bus.consume(shard, victim.id, 1, cfg.reclaimIdleMs)
  const tookOver = await waitFor(() => survivor.lease.held.has(shard), cfg.leaseTtlMs * 4)
  const gap = ((Date.now() - killedAt) / 1000).toFixed(2)
  console.log(
    `${stamp()} shard ${shard} 在失联 ${gap}s 后被 ${survivor.id} 接手（TTL ${cfg.leaseTtlMs}ms）`
  )
  await waitFor(() => sink.of(user).length >= 6, cfg.leaseTtlMs * 4)
  const seqs = sink.of(user).map((r) => r.seq)
  const tail = sink.of(user).slice(3)
  const by = [...new Set(tail.map((r) => r.worker))].join('/') || '(无)'
  const ok4 =
    tookOver && seqs.join() === '1,2,3,4,5,6' && tail.every((r) => r.worker === survivor.id)
  check(
    '[4/5] handoff 之后同用户顺序没乱：',
    ok4,
    `${user} 的处理顺序 [${seqs.join(', ')}]，后三条由 ${by} 处理`
  )

  // [5/5] 脑裂防护：假死的 victim 醒过来，续约与写入都必须被拒
  const renewed = await victim.lease.renewOne(shard)
  const wrote = await sink.write({
    userId: user,
    seq: 99,
    text: '我以为我还持有这个 shard',
    worker: victim.id,
    fence: stale,
  })
  const d5 = `${victim.id} 拿旧号 ${stale} 续约${renewed ? '成功（危险）' : '被拒'}、写入${wrote ? '成功（危险）' : '被拒'}`
  check('[5/5] 脑裂防护（续约校验持有者 + 写入带 fencing token）：', !renewed && !wrote, d5)

  await survivor.shutdown()
  await victim.shutdown()
  await infra.bus.close()
  const passed = results.filter(Boolean).length
  console.log(`${stamp()} === 自检结束：${passed}/${results.length} 项通过 ===`)
  return passed === results.length
}
