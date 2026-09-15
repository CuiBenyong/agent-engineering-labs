/**
 * 第四档：特征检测器。
 *
 * 它的特征是「同一行里同时出现发送动词与一个地址」。
 * 这是真实世界里检测器的典型形态：盯可观测特征，快、便宜、误伤少。
 *
 * 两件事必须同时讲清楚：
 *   1. 它确实有用——能挡住当前这一批载荷里剩下的那几条。
 *   2. 它是特征匹配，**攻击者只要把特征拆开就绕过去了**（见 ADAPTIVE_CASES）。
 *      arXiv 2503.00061 对八种已发表防御做的就是这件事，全部击穿，攻击成功率过半。
 */
const SEND_VERBS = ['发送', '抄送', '报送', '转发', '上报', '推送']
const ADDRESS_RE = /[\w.+-]+@[\w.-]+\.\w+|https?:\/\/\S+/

export interface DetectorVerdict {
  blocked: boolean
  reason: string
}

export function detect(texts: string[]): DetectorVerdict {
  // TODO(3)：逐行看，同一行里同时出现 SEND_VERBS 里的动词与一个地址就拦下来。
  // 写完先别急着高兴：跑 pnpm start --adaptive 看看它漏了什么，
  // 再看看它误伤了哪一条正常任务。
  void texts
  void SEND_VERBS
  void ADDRESS_RE
  return { blocked: false, reason: '' }
}
