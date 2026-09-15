---
name: calc-conventions
description: 'calc 模块的数值约定。改 src/calc.js 或讨论除零行为时按它来。'
domain: calc
priority: 20
triggers: [divide, 除零, 除数为 0, 除法]
paths:
  - src/calc.js
  - test/calc.test.js
---

# calc 模块的数值约定

这份约定是当前版本，取代 legacy-calc-rules 里那份。有冲突时以这份为准。

## 除法

- `divide(a, b)` 在 `b === 0` 时 **抛 `Error('divide by zero')`**，不返回 `Infinity`、不返回 `null`、不返回 `NaN`。
- 抛错的消息逐字是 `divide by zero`，测试按这个字符串断言，改了消息就会有用例变红。
- 判零只用 `b === 0`，**不要写 `!b`**：`!b` 会把 `NaN`、`undefined`、空字符串一起判掉，
  于是一个「上游传错了类型」的问题会被伪装成「除数为 0」，排查时要多走一圈。
- 判零写在函数第一行，早返回，不要包在 `if (Number.isFinite(b)) { ... } else { ... }` 里——
  这个仓库的风格是先挡掉异常输入再算正常路径。

## 其它函数

- `add` / `subtract` 不做任何输入校验，它们的契约就是「传什么算什么」。
- 不要为了「稳一点」给它们加校验：调用方靠 `NaN` 自然传播来发现上游的坏数据，
  在这里拦一道反而会把坏数据变成一个看起来正常的 0。

---

## 改动纪律

- 改完必须跑一遍 `node --test`，四个用例要全绿，不能只跑改动那一个。
- 行为变了就在 README 里补一句。这个仓库没有 CHANGELOG，README 就是唯一的变更记录。
- 不要为了改这一处顺手重排整个文件的格式：那会让 diff 变得没法看。
