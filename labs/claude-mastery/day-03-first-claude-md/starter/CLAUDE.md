# （项目名）- Project Rules

> 删掉这段引用块再提交。四段结构固定，总长不超过 60 行。每写一行问一句：删掉它，Claude 会犯什么错？答不上来就删。

## 命令

> TODO：只写 Claude 猜不到的。例：测试要先起 docker、某个脚本必须带环境变量、只跑单文件不跑全量。
> 不要写 package.json / pyproject 里一眼能看到的脚本名。

```bash
# TODO
```

## 代码风格

> TODO：只写和语言默认习惯不同的地方。例：不用 default export、错误用 Result 类型不抛异常、注释用英文。
> 「写干净的代码」「遵循最佳实践」这类话删掉。

## 规矩

> TODO：写禁止项而不是能力清单。例：不动 migrations/、不改 package.json、校验只用某个库、分支与提交信息格式。
> 每条都要具体到 Claude 能判断「我这一步违反了没有」。

## 完成的判据

> TODO：一句话。哪条命令通过才算做完、要贴什么证据。例：`pnpm lint && pnpm test` 全绿，并把测试输出贴在回复里。
