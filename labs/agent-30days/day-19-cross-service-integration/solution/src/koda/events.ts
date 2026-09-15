/**
 * 幂等：同一个外部事件重复送达，只允许产生一条记录、一次副作用。
 * 这是 D8 那条唯一约束的第三次使用（D8 落库、D13 cron、今天跨服务）。
 */
import type { Caller } from '../shared/types'
import type { Store } from '../infra/index'

/**
 * externalId 是调用方自己生成的，两个调用方各自造出 "evt-1" 是迟早的事。
 * 所以落库前先加命名空间：谁发的（iss）、替谁发的（sub）、它自己的 id。
 * 三段都来自验签后的 token，伪造不了。
 */
export function namespacedExternalId(issuer: string, userId: string, externalId: string): string {
  return `${issuer}|${userId}|${externalId}`
}

export interface RecordResult {
  created: boolean
  key: string
}

/**
 * created === false 表示这条事件之前已经处理过，调用方应当拿到和第一次相同的结果。
 * 判据只有一个：插入语句有没有真的插进去（on conflict do nothing 返回零行就是重复）。
 * 「先查一下有没有，没有再插」在并发下会出双份，见 D8。
 */
export async function recordExternalEvent(
  store: Store,
  caller: Caller,
  kind: string,
  externalId: string,
  payload: unknown
): Promise<RecordResult> {
  const key = namespacedExternalId(caller.issuer, caller.userId, externalId)
  const created = await store.insertExternalEvent(key, kind, JSON.stringify(payload))
  return { created, key }
}
