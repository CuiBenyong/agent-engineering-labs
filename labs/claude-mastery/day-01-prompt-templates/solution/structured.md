# 结构化输出模板（填表）· 示范

> 用法：结果要被程序直接消费时用。schema 通过 `output_config.format`（TS）或 `output_format`（Python）传参，**不要**在提示词里再描述一遍格式。
> 提示词正文只说「你要做什么判断」，格式交给 schema。

## 提示词正文

```text
<current_code>
router.post('/todos', (req, res) => {
  const todo = { id: nanoid(), done: false, ...req.body }
  store.push(todo)
  res.status(201).json(todo)
})
</current_code>

请评审这段代码的输入校验：指出哪些字段没有校验、整体严重程度，以及应当补哪些单元测试。
```

注意正文里没有出现「请返回 JSON」「格式如下」。

## JSON Schema

```json
{
  "type": "object",
  "properties": {
    "reasoning": {
      "type": "string",
      "description": "先用两三句话说明判断依据"
    },
    "missing_validations": {
      "type": "array",
      "items": { "type": "string" },
      "description": "没有校验的字段，一项一个"
    },
    "severity": {
      "type": "string",
      "enum": ["low", "medium", "high"]
    },
    "suggested_tests": {
      "type": "array",
      "items": { "type": "string" },
      "description": "建议补充的测试用例，一句话一条"
    }
  },
  "required": ["reasoning", "missing_validations", "severity", "suggested_tests"],
  "additionalProperties": false
}
```

`reasoning` 放在第一个：模型按字段顺序生成，先写依据再给结论，效果与分析段类似，但整个输出仍是合法 JSON。

## 自检

- [x] 提示词正文里没有描述格式
- [x] schema 里没有用 minimum / maximum / minLength / maxLength（不支持，要在代码里补校验）
- [x] 没有同时开 citations（两者不兼容）

## 示例返回

```json
{
  "reasoning": "请求体被直接展开进对象，客户端可以覆盖 id 与 done，title 与 dueAt 没有任何类型或长度检查。",
  "missing_validations": [
    "title 必填与长度",
    "dueAt 日期格式",
    "禁止客户端传 id",
    "禁止客户端传 done"
  ],
  "severity": "high",
  "suggested_tests": [
    "空 title 返回 400",
    "title 超过 200 字返回 400",
    "dueAt 不是 ISO 日期返回 400",
    "请求体带 id 时返回的 id 不等于传入值"
  ]
}
```

程序拿到就是这个对象，不需要任何正则或 `JSON.parse` 的 try/catch。
