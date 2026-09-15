# 插件包的目录与三份 SKILL.md

## 目录结构

```text
<你的包名>/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   ├── <技能一>/SKILL.md
│   ├── <技能二>/SKILL.md
│   └── <技能三>/SKILL.md
└── README.md
```

> TODO：写一句话说清哪些目录必须在插件根下、哪个文件才该放进 `.claude-plugin/`，以及放错了的症状是什么。

## 清单

```json
{
  "name": "TODO",
  "description": "TODO",
  "version": "TODO",
  "author": { "name": "TODO" }
}
```

## skills/<技能一>/SKILL.md

> TODO：把前几天写的 skill 搬进来，补齐 frontmatter 的 name 与 description。
> description 必须写清「什么时候用」与「不管什么」两半。

```markdown
---
name: TODO
description: TODO
---

## 工作流

> TODO：编号步骤，模型照着能走完

## 坑

> TODO：至少两条。判据是「不写这条，模型会不会做错」
```

## skills/<技能二>/SKILL.md

> TODO：同上。

## skills/<技能三>/SKILL.md

> TODO：同上。
