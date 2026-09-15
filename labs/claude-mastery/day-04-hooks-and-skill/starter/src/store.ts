export interface Todo {
  id: string
  title: string
  done: boolean
  dueAt?: string
}

/** 演示项目用内存数组代替数据库；测试之间用 reset() 清空 */
export const store: Todo[] = []

export function reset(): void {
  store.length = 0
}
