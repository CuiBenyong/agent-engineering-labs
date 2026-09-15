/**
 * 出口控制：数据能被送到哪里去。
 *
 * 这是致命三件套里最值得拆的一条边——它是唯一一条「攻击者必须用到、
 * 而正常业务只用到很少几个目的地」的边。
 *
 * 两类目的地各有一张白名单，**默认拒绝**。默认放行的白名单不叫白名单。
 */
export const ALLOWED_EMAIL_DOMAINS = ['deskmate.internal']
export const ALLOWED_HOSTS = ['hooks.deskmate.internal']

/** RFC 1918 私网、回环与链路本地地址：云上元数据端点就躲在最后这一段里。 */
const BLOCKED_IP_RE =
  /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?fc|\[?fe80)/i

export interface EgressVerdict {
  allowed: boolean
  reason: string
}

export function checkEmail(address: string): EgressVerdict {
  // TODO(2)：取出收件域名，不在 ALLOWED_EMAIL_DOMAINS 里就拒绝。
  // 记住默认拒绝：取不到域名也要拒，不能因为解析失败就放过去。
  void address
  return { allowed: true, reason: '' }
}

export function checkUrl(raw: string): EgressVerdict {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { allowed: false, reason: `不是一个合法地址：${raw}` }
  }
  // TODO(3)：三条，顺序照写。
  //   1. 只允许 https
  //   2. 命中 BLOCKED_IP_RE 的一律拒绝——这一条挡的是 SSRF：
  //      让 Agent 替你去敲内网与云上元数据端点，凭据就从 169.254.169.254 那里流出来了
  //   3. 主机不在 ALLOWED_HOSTS 里就拒绝
  void url
  void BLOCKED_IP_RE
  void ALLOWED_HOSTS
  return { allowed: true, reason: '' }
}
