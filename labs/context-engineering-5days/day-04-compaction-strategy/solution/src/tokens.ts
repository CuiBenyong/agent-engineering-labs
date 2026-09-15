/**
 * 离线 token 估算器（与 D1 实验同一份）。
 * 汉字与全角标点约 1 字 1 token，ASCII 约 3.5 字符 1 token。
 * 裁剪器关心的是「裁掉了多少」，比例级的估算足够，不需要每次都去调计数接口。
 */
export function estimateTokens(input: unknown): number {
  const text = typeof input === 'string' ? input : JSON.stringify(input)
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[　-〿一-鿿＀-￯]/.test(ch)) cjk += 1
    else other += 1
  }
  return Math.round(cjk + other / 3.5)
}
