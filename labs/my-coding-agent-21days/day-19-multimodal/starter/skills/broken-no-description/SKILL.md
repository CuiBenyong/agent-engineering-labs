---
name: broken-no-description
domain: misc
triggers: [坏掉的技能]
---

# 这个技能包故意是坏的

它的 frontmatter 里没有 description。加载器必须跳过它，并说清楚是哪个目录、缺哪个字段。

description 是阶段一唯一常驻上下文的东西，缺了它这个技能永远不会被触发——
而如果加载器只是静默跳过，作者会以为自己写好了。
