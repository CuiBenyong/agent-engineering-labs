/**
 * 这个文件是整条流水线**唯一的网络出口**。
 * MOCK=1 的判断放在函数最前面，命中就直接返回假数据，真实分支一行都不执行。
 * 其余步骤（分析、校验、填充）在离线模式下是真跑的，不是假装跑。
 */

const SYSTEM = '你在写发布报告的摘要段。用两三句中文说清这一版为什么要发，不要罗列改了哪些文件。'

export async function writeSummary(changes: string[]): Promise<string> {
  if (process.env.MOCK === '1') {
    return '这是离线模拟摘要：本次发布把订单查询改为分页返回以控制响应体积，并下线了一个已无调用方的批量导出接口。去掉 MOCK=1 并配置 ANTHROPIC_API_KEY 就会换成真模型生成。'
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('缺少 ANTHROPIC_API_KEY（或用 MOCK=1 离线运行）')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
      max_tokens: 256,
      system: SYSTEM,
      messages: [
        { role: 'user', content: `变更条目：\n${changes.map((c) => `- ${c}`).join('\n')}` },
      ],
    }),
  })
  if (!res.ok) throw new Error(`模型调用失败：${res.status} ${await res.text()}`)
  const json = (await res.json()) as { content: Array<{ type: string; text?: string }> }
  return json.content.find((c) => c.type === 'text')?.text?.trim() ?? ''
}
