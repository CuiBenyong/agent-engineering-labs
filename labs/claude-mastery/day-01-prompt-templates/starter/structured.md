# 结构化输出模板（填表）

> 用法：结果要被程序直接消费时用。schema 通过 `output_config.format`（TS）或 `output_format`（Python）传参，**不要**在提示词里再描述一遍格式。
> 提示词正文只说「你要做什么判断」，格式交给 schema。

## 提示词正文

```text
> TODO：材料（用标签包起来）+ 一句任务描述。不要出现「请返回 JSON」「格式如下」。
```

## JSON Schema

```json
{
  "type": "object",
  "properties": {
    "TODO_字段一": { "type": "string" },
    "TODO_字段二": { "type": "array", "items": { "type": "string" } },
    "TODO_字段三": { "type": "string", "enum": ["TODO", "TODO", "TODO"] }
  },
  "required": ["TODO_字段一", "TODO_字段二", "TODO_字段三"],
  "additionalProperties": false
}
```

> TODO：至少三个字段，含一个枚举。如果需要模型「先想」，加一个 `reasoning` 字段并放在最前面。

## 自检

- [ ] 提示词正文里没有描述格式
- [ ] schema 里没有用 minimum / maximum / minLength / maxLength（不支持，要在代码里补校验）
- [ ] 没有同时开 citations（两者不兼容）

## 示例（用示例任务填一遍）

> TODO：让 Claude 评审 TODO API 的输入校验，输出「缺哪些校验、严重程度、建议补哪些测试」三个字段，贴在这里。
