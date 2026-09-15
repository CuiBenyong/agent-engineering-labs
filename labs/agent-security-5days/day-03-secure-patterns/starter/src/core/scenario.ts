// ── 冻结文件（agent-security-5days 全课靶子定义）────────────────────────────
// D1 定稿，D2–D5 逐字复制。改动后必须跑 bash scripts/check-agsec-consistency.sh。

import type { AgentConfig, ToolSpec } from './types.js'

/**
 * deskmate 是本课全程的靶子：一个公司内部的知识助手。
 * 它每天做三件事——读工单与工单里贴的网页、查内部客户库、把结论发出去。
 * 这三件事分别对应致命三件套的三条边。
 */
export const DESKMATE_TOOLS: ToolSpec[] = [
  {
    name: 'read_ticket',
    description: '读取一条工单的正文，正文由外部用户提交',
    effect: 'read',
    returnsUntrusted: true,
    sensitivity: 'internal',
    reversible: true,
  },
  {
    name: 'fetch_page',
    description: '抓取工单里贴的网页链接并返回正文',
    effect: 'read',
    returnsUntrusted: true,
    sensitivity: 'public',
    reversible: true,
  },
  {
    name: 'search_customers',
    description: '在内部客户库里按关键词检索客户记录，含联系方式与合同金额',
    effect: 'read',
    returnsUntrusted: false,
    sensitivity: 'private',
    reversible: true,
  },
  {
    name: 'send_email',
    description: '以助手身份向任意邮箱发送一封邮件',
    effect: 'send',
    returnsUntrusted: false,
    sensitivity: 'internal',
    reversible: false,
  },
  {
    name: 'post_webhook',
    description: '向指定地址发送一条 HTTP 通知',
    effect: 'send',
    returnsUntrusted: false,
    sensitivity: 'internal',
    reversible: false,
  },
  {
    name: 'update_ticket',
    description: '把结论写回工单',
    effect: 'write',
    returnsUntrusted: false,
    sensitivity: 'internal',
    reversible: true,
  },
]

export const DESKMATE: AgentConfig = {
  id: 'deskmate',
  description: '内部知识助手：读工单与网页、查客户库、把结论发出去',
  userInputTrust: 'untrusted',
  tools: DESKMATE_TOOLS,
}

/** 对照组：拿掉两个对外发送的工具，用来演示「拆掉一条边」之后判定会翻转。 */
export const DESKMATE_NO_SEND: AgentConfig = {
  ...DESKMATE,
  id: 'deskmate-no-send',
  description: 'deskmate 去掉对外发送能力后的对照组',
  tools: DESKMATE_TOOLS.filter((t) => t.effect !== 'send'),
}
