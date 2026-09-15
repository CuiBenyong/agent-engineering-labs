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
  // 练习 2 的一半：把偏移量编成一个对客户端不透明的字符串。
  // 提示：base64url 包一个 `offset:<n>` 就够了。别直接返回数字的字符串形式——
  // 那等于邀请客户端去解析和伪造它，而规范明令客户端 MUST NOT 这么做。
  void offset
  return ''
}

export function decodeCursor(cursor: string | undefined): number {
  // 练习 2 的另一半：把游标解回偏移量，解不出来就抛 InvalidCursorError。
  //   提示一：cursor 为 undefined 才是「没有游标」，从 0 开始。
  //   提示二：空字符串是一个合法游标，不能当成「没有游标」，更不能当成结束。
  //   现在恒定返回 0，于是不管翻到第几页都会拿到第一页——自测第 2 项会红。
  void cursor
  void InvalidCursorError
  return 0
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
