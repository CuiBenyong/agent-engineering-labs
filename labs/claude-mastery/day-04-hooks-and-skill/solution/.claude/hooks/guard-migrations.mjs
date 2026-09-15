// PreToolUse hook：拦住对 migrations/ 的任何写入。
// Claude Code 把事件 JSON 从 stdin 传进来；退出码 2 = 阻止，stderr 会作为理由送回给模型。
import { readFileSync } from 'node:fs'

const input = JSON.parse(readFileSync(0, 'utf8')) // 0 = stdin
const filePath = input.tool_input?.file_path ?? ''

if (/(^|\/)migrations\//.test(filePath)) {
  process.stderr.write(
    `拒绝：${filePath} 在 migrations/ 下。迁移文件只能由 pnpm db:generate 生成，不能手改。`
  )
  process.exit(2) // 2 = 阻止这次工具调用
}
process.exit(0) // 0 = 放行，走正常权限流程
