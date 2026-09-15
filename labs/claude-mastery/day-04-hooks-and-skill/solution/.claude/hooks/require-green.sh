#!/usr/bin/env bash
# Stop hook：模型准备结束这一轮时跑测试；不过就 exit 2，让它继续修。
# 只跑单文件（CLAUDE.md 的规矩），把最后 20 行失败输出写进 stderr 作为理由。
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 1
out=$(pnpm vitest run test/todos.test.ts 2>&1)
code=$?
if [ "$code" -ne 0 ]; then
  {
    echo "测试没有通过，不能结束这一轮。失败摘要："
    echo "$out" | tail -n 20
  } >&2
  exit 2
fi
exit 0
