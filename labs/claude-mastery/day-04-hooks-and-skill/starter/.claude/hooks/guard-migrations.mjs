// PreToolUse hook：拦住对 migrations/ 的任何写入。
// 练习 1：Claude Code 会把事件 JSON 从 stdin 传进来。
//   - 用 readFileSync(0, 'utf8') 读 stdin 并 JSON.parse
//   - 取 tool_input.file_path
//   - 路径命中 migrations/ 时，向 stderr 写一句理由（会送回给模型），然后 process.exit(2)
//   - 否则 process.exit(0)
// 提示：退出码 2 才是「阻止」；其他非零码只会被当成「脚本自己出错」而放行。
import { readFileSync } from 'node:fs'

void readFileSync
process.exit(0) // 现在一律放行——模拟器会把三个事件都打成「放行」，这就是你要改的地方
