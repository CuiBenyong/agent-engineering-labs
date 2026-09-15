# demo-todo-api - Project Rules

## 命令

```bash
pnpm install --ignore-workspace   # 本目录不在仓库根 workspace 里，漏掉 flag 会装到根 node_modules
pnpm vitest run test/todos.test.ts  # 只跑单文件；不要跑 pnpm test 全量（会起真实服务器，慢）
pnpm lint                          # eslint + tsc --noEmit，两者都要过
```

## 代码风格

- 只用具名导出，不写 `export default`
- 请求体校验只用 zod，schema 一律 `.strict()`；不引入 joi / class-validator / yup
- 错误响应统一形如 `{ error: string, issues?: { path, message }[] }`，不要抛裸的 Error 让框架兜底
- 代码注释用英文，回复用中文

## 规矩

- 不动 `migrations/`、`package.json`、`.claude/`；需要新依赖先提问
- 测试文件只能新增用例，不能删除或改写已有断言（改测试让它过不算修好）
- 一次改动只处理一个路由，改完先跑单文件测试再动下一个
- 需求有歧义（比如「dueAt 能不能是过去的时间」）先问，不要自己定

## 完成的判据

`pnpm lint && pnpm vitest run test/todos.test.ts` 全绿，并把测试输出原文贴在回复里；没有输出就不算完成。
