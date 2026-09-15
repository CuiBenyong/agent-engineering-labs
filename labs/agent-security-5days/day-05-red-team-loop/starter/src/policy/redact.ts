/**
 * 日志脱敏。
 *
 * 审计日志是出事之后唯一能用的东西，所以它必须记得够细；
 * 但它同时也是一个新的数据副本，所以它必须记得够糙。
 * 这两句话的交集就是：**记结构，不记内容。**
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/\b(sk|rk|api|token)[-_][A-Za-z0-9]{8,}\b/gi, '<密钥已脱敏>'],
  [/\b[\w.+-]+@([\w.-]+\.\w+)\b/g, '<邮箱@$1>'],
  [/\b1[3-9]\d{9}\b/g, '<手机号已脱敏>'],
  [/\b\d{6,}\s*元\b/g, '<金额已脱敏>'],
]

export function redact(text: string): string {
  return PATTERNS.reduce((acc, [re, to]) => acc.replace(re, to), text)
}
