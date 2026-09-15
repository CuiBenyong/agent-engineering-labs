---
name: commit-message
description: '按团队规范写 Git 提交信息。当用户要提交代码、写 commit message、整理暂存区的改动，或者用日常说法表示这批文件准备提交时使用。只负责生成提交描述文本，不负责决定该不该提交。'
---

（项目级版本，会遮蔽用户级的同名 skill）

## 工作流

1. 跑 `git diff --staged --stat` 看这次改了哪些文件。
2. 类型只能从 feat、fix、docs、refactor、test、chore 六个里选一个。
3. 第一行不超过 50 个字符，用中文，结尾不加句号。

## 坑

- 一次改动跨了两个类型，说明该拆成两次提交，先提醒用户。
- 正文段落说清「为什么改」，不要复述 diff。
