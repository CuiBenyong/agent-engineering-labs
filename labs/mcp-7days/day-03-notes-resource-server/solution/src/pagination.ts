// 游标分页。规范只要求一件事：游标对客户端是不透明的。
// 服务端爱怎么编怎么编，这里用 base64 包一个偏移量，方便你在调试时解开看，
// 但客户端 MUST NOT 这么干——它只能判断 nextCursor 在不在。
export const PAGE_SIZE = 3

/** 非法游标要报错，规范建议用 -32602（Invalid params） */
export class InvalidCursorError extends Error {
  readonly code = -32602
  constructor(cursor: string) {
    super(`Invalid cursor: ${cursor}`)
  }
}

export function encodeCursor(offset: number): string {
  return Buffer.from(`offset:${offset}`, 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  // 注意：空字符串是一个合法游标，不能当成「没有游标」，更不能当成结束
  let decoded: string
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8')
  } catch {
    throw new InvalidCursorError(cursor)
  }
  const match = /^offset:(\d+)$/.exec(decoded)
  if (!match) throw new InvalidCursorError(cursor)
  return Number(match[1])
}

export interface Page<T> {
  items: T[]
  nextCursor?: string
}

/**
 * 切一页出来。页大小由服务端说了算，客户端 MUST NOT 假设它是固定值——
 * 所以这里故意用了一个很小的 PAGE_SIZE，好让 8 篇笔记也能翻三页。
 */
export function paginate<T>(all: T[], cursor: string | undefined): Page<T> {
  const offset = decodeCursor(cursor)
  if (offset > all.length) throw new InvalidCursorError(cursor ?? '')
  const items = all.slice(offset, offset + PAGE_SIZE)
  const nextOffset = offset + items.length
  // 只有「确实还有下一页」时才给 nextCursor；缺失才是结束的信号
  return nextOffset < all.length ? { items, nextCursor: encodeCursor(nextOffset) } : { items }
}
