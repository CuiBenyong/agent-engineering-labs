#!/usr/bin/env bash
# Stop hook：模型准备结束这一轮时跑测试；不过就 exit 2，让它继续修。
# 练习 2：
#   - cd 到 ${CLAUDE_PROJECT_DIR}（hook 的工作目录不一定是项目根）
#   - 跑 pnpm vitest run test/todos.test.ts，把输出与退出码存下来
#   - 退出码非 0 时，把最后 20 行输出写到 stderr（>&2），然后 exit 2
#   - 否则 exit 0
# 提示：stderr 的内容会作为「为什么不能结束」送回给模型，写得越具体它修得越快。
exit 0
