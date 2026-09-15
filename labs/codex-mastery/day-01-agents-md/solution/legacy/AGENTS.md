# src/legacy/ 目录的补充规则

- 这个目录的测试用 mocha（`pnpm test:legacy`），不要迁到 vitest
- 这里的校验保留手写 if 判断，不要引入 zod——老接口即将下线，不值得重构
- 只允许修 bug，不允许加新功能
