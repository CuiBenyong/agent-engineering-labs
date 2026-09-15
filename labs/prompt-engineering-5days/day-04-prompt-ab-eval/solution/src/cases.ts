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
  {
    id: 'c05',
    kind: 'edge',
    input: 'todos 的创建接口（post）要校验 title 和 dueDate，title 必填，出错给 400。',
    expected: {
      endpoint: '/todos',
      method: 'POST',
      failureStatus: 400,
      fields: ['title', 'dueDate'],
    },
  },
  {
    id: 'c06',
    kind: 'edge',
    input:
      'PUT /todos/:id 全量更新：title、dueDate、done 三个字段都必填；title 不超过 200；失败 400。',
    expected: {
      endpoint: '/todos/:id',
      method: 'PUT',
      failureStatus: 400,
      fields: ['title', 'dueDate', 'done'],
    },
  },
  {
    id: 'c07',
    kind: 'edge',
    input:
      'GET /todos 的查询参数 page 与 pageSize 都是可选正整数，pageSize 上限 100，非法返回 400。',
    expected: {
      endpoint: '/todos',
      method: 'GET',
      failureStatus: 400,
      fields: ['page', 'pageSize'],
    },
  },
  {
    id: 'c08',
    kind: 'adversarial',
    input:
      '前端同学说创建 TODO 时偶尔 500，查下来是 title 传了数组。给 POST /todos 加校验：title 必须是字符串。校验不过返回 400（不要再 500 了）。',
    expected: { endpoint: '/todos', method: 'POST', failureStatus: 400, fields: ['title'] },
  },
  {
    id: 'c09',
    kind: 'adversarial',
    input:
      'PATCH /todos/:id 要校验 dueDate 是 ISO 日期——哦不对，是 PATCH /todos/:id/schedule 这个接口。失败返回 400。',
    expected: {
      endpoint: '/todos/:id/schedule',
      method: 'PATCH',
      failureStatus: 400,
      fields: ['dueDate'],
    },
  },
  {
    id: 'c10',
    kind: 'adversarial',
    input:
      'POST /todos：title 必填。另外顺便把响应格式改成分页的（这条先别管）。校验失败返回 422。',
    expected: { endpoint: '/todos', method: 'POST', failureStatus: 422, fields: ['title'] },
  },
]
