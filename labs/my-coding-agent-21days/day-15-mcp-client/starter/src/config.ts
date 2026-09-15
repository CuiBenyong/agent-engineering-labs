/**
 * 配置只有一个来源：环境变量。D21 才会把它扩成"命令行参数 > 环境变量 > 配置文件"三层。
 *
 * 三个变量撑起"不绑任何一家网关"这件事：
 *   LLM_BASE_URL  任何 OpenAI 兼容网关的根地址
 *   LLM_API_KEY   该网关签发的 key
 *   LLM_MODEL     该网关认的模型 id —— 注意它的"形状"随网关变化，代码里不许假设
 */

export interface Config {
  baseUrl: string
  apiKey: string
  model: string
  mock: boolean
}

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'
export const DEFAULT_MODEL = 'openai/gpt-4o-mini'

export function loadConfig(): Config {
  const baseUrl = (process.env.LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  return {
    baseUrl,
    apiKey: process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? DEFAULT_MODEL,
    mock: process.env.MOCK === '1',
  }
}
