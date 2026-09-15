# 项目：TODO API（本课示例）

## 怎么跑

- `pnpm install && pnpm dev`，服务监听 3181 端口
- Node 22 / pnpm 10；Node 20 安装依赖时会报错

## 怎么验证

- `pnpm test`（vitest），改完任何 `src/` 下的文件都必须跑一次
- 集成测试依赖本地 postgres：先 `docker compose up -d` 再跑

## 规矩

- 输入校验统一用 zod，不要手写 if 判断；校验失败返回 400 与 `{ error: string }`
- 新增接口必须同时新增对应的测试文件 `test/<route>.test.ts`
- 提交信息用 Conventional Commits，中文描述，一次提交只做一件事

## 禁区

- 不要改 `src/legacy/` 下的任何文件，那是待下线的老接口，有自己的规则
- 不要改 `docker-compose.yml` 的端口映射

## 已知坑

- `pnpm test` 前没起 postgres 会报连接超时，不是代码问题
- `.env` 不入库，示例在 `.env.example`
