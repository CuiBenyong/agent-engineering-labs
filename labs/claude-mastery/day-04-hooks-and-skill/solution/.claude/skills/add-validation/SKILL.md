---
name: add-validation
description: 给一个 Express 路由补 zod 输入校验并写对应的 vitest 用例。用户提到「加校验」「补测试」「校验请求体」「输入没校验」时使用。
argument-hint: [路由，如 POST /todos]
---

给 $ARGUMENTS 补输入校验与测试。按下面顺序做，每步完成再进下一步，不要跳步：

1. 读路由文件与 test/ 下对应的测试，列出请求体里每个字段现在的处理方式（有没有校验、缺什么）
2. 先写失败的测试：空值、超长、类型错误、多余字段各一个，跑一次确认它们真的失败
3. 用 zod 定义 schema，一律 `.strict()`；校验失败返回 400，响应体形如 `{ error: "invalid body", issues: [{ path, message }] }`
4. 只跑这一个测试文件：`pnpm vitest run test/<文件>`，直到全绿
5. 把测试输出原文贴在回复里，说明改了哪些文件，然后停下等确认；不要顺手改别的路由
