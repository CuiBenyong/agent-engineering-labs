/**
 * 十条测试集。三类输入各占一部分：
 * - normal：正常写法，两版都该对
 * - edge：边界（没写状态码、字段可选、路径带参数、写法不规范）
 * - adversarial：故意刁难（口语化、带干扰信息、写错又改口）
 * expected 是人工标注的「标准答案」，判分只比这四个字段。
 */
export type Kind = 'normal' | 'edge' | 'adversarial'

export interface Expected {
  endpoint: string
  method: string
  failureStatus: number
  fields: string[]
}

export interface Case {
  id: string
  kind: Kind
  input: string
  expected: Expected
}

export const CASES: Case[] = [
  {
    id: 'c01',
    kind: 'normal',
    input:
      'POST /todos 的请求体需要校验：title 必填字符串不超过 200 字符，dueDate 可选 ISO 日期。失败返回 400。',
    expected: {
      endpoint: '/todos',
      method: 'POST',
      failureStatus: 400,
      fields: ['title', 'dueDate'],
    },
  },
  {
    id: 'c02',
    kind: 'normal',
    input: 'PATCH /todos/:id：title 若传必须非空且不超过 200；done 若传必须是布尔。失败返回 400。',
    expected: {
      endpoint: '/todos/:id',
      method: 'PATCH',
      failureStatus: 400,
      fields: ['title', 'done'],
    },
  },
  {
    id: 'c03',
    kind: 'normal',
    input: 'DELETE /todos/:id 只需要校验路径参数 id 是正整数，非法返回 400。',
    expected: { endpoint: '/todos/:id', method: 'DELETE', failureStatus: 400, fields: ['id'] },
  },
  {
    id: 'c04',
    kind: 'edge',
    input: 'POST /todos 补校验：title 必填，不超过 200 字符。（需求里没写失败返回什么）',
    expected: { endpoint: '/todos', method: 'POST', failureStatus: 400, fields: ['title'] },
  },
  // 练习 1：补到十条。还缺 3 条 edge（口语化写法、PUT 全量更新、GET 查询参数）和 3 条 adversarial
  //（带干扰信息、中途改口、夹带无关要求）。每条都要人工标注 expected，标错一条整份评估就偏了。
  // 提示：先想「v1 最可能在哪里猜错」，再把那种输入写成一条用例——测试集的价值全在边界上。
]
