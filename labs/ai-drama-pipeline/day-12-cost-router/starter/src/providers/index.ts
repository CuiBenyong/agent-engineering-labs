// 唯一的选择点：业务代码永远只 import createProviders()，不 import 任何厂商实现。
import { createMockProviders } from './mock.js'
import { createMiniMaxProviders } from './minimax.js'
import type { Providers } from './types.js'

export * from './types.js'
export { MiniMaxError, PRICE } from './minimax.js'
export { SECONDS_PER_HANZI } from './mock.js'

export function isMock(): boolean {
  return process.env.MOCK === '1'
}

export function createProviders(): Providers {
  return isMock() ? createMockProviders() : createMiniMaxProviders()
}
