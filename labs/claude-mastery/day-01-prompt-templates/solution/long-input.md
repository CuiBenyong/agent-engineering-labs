# 长输入模板（文件袋）· 示范

> 用法：材料多于一份、或任何一份材料超过一屏时用它。标签名可以自己起，但要成对、语义清楚、前后一致。
> 顺序：材料 → 指令 → 示例。指令一定放在材料之后。

## 模板

```text
<context>
一两句话交代背景。
</context>

<材料一>…</材料一>
<材料二>…</材料二>

<instructions>
1. 编号列出要做的事，每条一个动作
2. 要求回答时引用标签名
</instructions>

<example>
一个输入 → 期望输出的例子（可选）
</example>
```

## 自检

- [x] 顶层标签 3–6 个，每个都成对闭合
- [x] `<instructions>` 在所有材料之后
- [x] 材料里如果含 Markdown 或 XML，标签名没有和它撞

## 示例（示例任务：给 TODO API 补输入校验和单元测试）

```text
<context>
这是一个 Express + TypeScript 写的 TODO API，测试框架是 vitest。
路由文件在 src/routes/todos.ts，类型在 src/types.ts。
</context>

<types>
export type Todo = { id: string; title: string; done: boolean; dueAt?: string }
</types>

<current_code>
router.post('/todos', (req, res) => {
  const todo = { id: nanoid(), done: false, ...req.body }
  store.push(todo)
  res.status(201).json(todo)
})
</current_code>

<existing_test>
it('creates a todo', async () => {
  const res = await request(app).post('/todos').send({ title: 'buy milk' })
  expect(res.status).toBe(201)
})
</existing_test>

<instructions>
1. 用 zod 给 POST /todos 的请求体加校验：title 必填、去除首尾空白后 1–200 字；dueAt 可选，必须是合法的 ISO 8601 日期字符串；不允许客户端传 id 与 done
2. 校验失败返回 400，响应体形如 { error: "invalid body", issues: [{ path, message }] }
3. 在 existing_test 同一个文件里补 3 个失败用例：空 title、超长 title、非法 dueAt；再补 1 个「传了 id 会被忽略」的用例
4. 回答时先引用 current_code 里有问题的那一行，再给修改后的完整函数与新增的测试，不要重写文件的其他部分
</instructions>

<example>
输入：{ "title": "   " }
期望：400，body.error 为 "invalid body"，issues[0].path 为 ["title"]
</example>
```

顶层标签 6 个：context、types、current_code、existing_test、instructions、example。材料里有 TypeScript 代码，标签名故意没有用 `code`（容易和材料里的 Markdown 围栏 ` ```code ` 混），而是用 `current_code`、`existing_test` 这种说清「哪一份」的名字。
