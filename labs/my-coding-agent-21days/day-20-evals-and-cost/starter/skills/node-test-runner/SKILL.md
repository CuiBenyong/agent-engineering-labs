---
name: node-test-runner
description: '怎么在这个仓库里跑测试、怎么读输出、失败时先看哪一行。'
domain: testing
priority: 10
triggers: [测试, test, 用例, node --test]
paths:
  - test/
---

# 在这个仓库里跑测试

## 命令

```bash
node --test
```

不需要 `pnpm install`：`node --test` 是 Node 内置的测试运行器，这个仓库零依赖。
也不要用 `npm test` 之外的第三方 runner，这个仓库没装。

## 怎么读输出

1. 先看最后那几行的 `# fail` 计数，它是唯一的成败判据。中间那些 `ok` 行不用逐条看。
2. 再往上找**第一个** `not ok`。后面几个失败常常是同一个原因的连锁，先修第一个再重跑。
3. `not ok` 后面缩进的 `expected` 与 `actual` 两行才是有用的信息，
   前面那一行只是用例名字。
4. 再往下那一大段堆栈里，只有指向 `src/` 或 `test/` 的那一行有意义，
   其余是 Node 内部帧，直接跳过。

## 常见误判

- **「一个用例都没跑」和「全部通过」在输出里长得很像**，区别只在 `# tests` 的数字。
  跑之前先想清楚它该是几，否则一个写错路径的命令会被当成全绿。
- 改完源码不跑测试就宣布修好了，是这个仓库里最常见的返工原因。
- 只跑单个文件（`node --test test/calc.test.js`）用来快速验证可以，
  但**宣布完成之前必须跑一次全量**。
