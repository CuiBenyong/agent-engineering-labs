// 「选工具」这一步的两种实现：离线的规则版和真模型版。
// 评估集评的是这一步——工具本身对不对，是单元测试的事；模型选不选得中，才是先出问题的那个。
import type { McpToolDef } from './protocol.js'

export interface Selector {
  select(utterance: string, tools: McpToolDef[]): Promise<string | null>
}

/**
 * 离线选择器：一串关键词规则。它是故意写得不完美的——
 * 负例存在的意义就是把这种规则的漏洞照出来（比如「不用查了」里的那个「查」）。
 */
export class RuleSelector implements Selector {
  async select(utterance: string, tools: McpToolDef[]): Promise<string | null> {
    const has = (name: string) => tools.some((t) => t.name === name)
    // 否定意图优先判：不先判这一条，「不用查文档了」会被当成检索
    if (/不用|不需要|别查|算了/.test(utterance)) return null
    if (/新建|创建|新增|记下来|写一篇/.test(utterance) && has('create_doc')) return 'create_doc'
    // 出现了像 slug 的 ASCII 词，说明用户已经知道确切标识
    if (/[a-z][a-z0-9-]{3,}/.test(utterance) && has('get_doc')) return 'get_doc'
    if (/搜|查找|找一下|哪些|关于|查/.test(utterance) && has('search_docs')) return 'search_docs'
    return null
  }
}

/** 故意选错的选择器，只用在自测里：验证负例断言真的在起作用。 */
export class AlwaysSearchSelector implements Selector {
  async select(): Promise<string | null> {
    return 'search_docs'
  }
}

/** 真模型选择器：把工具表交给模型，看它挑哪个（或者不挑）。 */
export class ModelSelector implements Selector {
  constructor(
    private readonly apiKey: string,
    private readonly model: string
  ) {}

  async select(utterance: string, tools: McpToolDef[]): Promise<string | null> {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: utterance }],
        tools: tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
      }),
    })
    if (!res.ok) throw new Error(`模型接口返回 ${res.status}`)
    const data = (await res.json()) as {
      choices: { message: { tool_calls?: { function: { name: string } }[] } }[]
    }
    return data.choices[0]?.message?.tool_calls?.[0]?.function.name ?? null
  }
}
