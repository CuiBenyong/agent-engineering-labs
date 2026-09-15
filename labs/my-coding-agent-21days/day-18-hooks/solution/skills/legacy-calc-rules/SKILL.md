---
name: legacy-calc-rules
description: '已归档的旧版 calc 约定（除零返回 Infinity），只用于 0.x 分支。'
domain: calc
priority: 5
triggers: [divide, 除零, 旧版, 0.x]
paths: []
---

# 旧版 calc 约定（已归档）

- `divide(a, b)` 在 `b === 0` 时返回 `Infinity`，由调用方自己用 `Number.isFinite` 判断。
- 理由是当年的调用方在热路径上，不想吃异常的开销。
- 这份约定只适用于 0.x 分支。主干上已经被 calc-conventions 取代，两份说法互相矛盾，
  **不要同时按两份来**。
