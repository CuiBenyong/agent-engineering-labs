"""D5 实验的 Python 对照版：把 claude -p 包成一条能进 CI 的命令。

用法：
    MOCK=1 python ci.py                          # 离线，success 场景
    MOCK=1 MOCK_SCENARIO=over-budget python ci.py  # 其他场景：max-turns / error
    ANTHROPIC_API_KEY=... python ci.py           # 真跑
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

MAX_TURNS = int(os.environ.get("MAX_TURNS", "6"))
MAX_BUDGET_USD = float(os.environ.get("MAX_BUDGET_USD", "0.5"))
BASE_REF = os.environ.get("BASE_REF", "main")
SYSTEM = "你是一名安全审查员。只报告漏洞、正确性问题与明确违反需求的地方，不评论风格。每条给出文件与行号。"
PROMPT = f"下面是一个 pull request 相对于 {BASE_REF} 的 diff。审查它，按严重程度列出问题；没有问题就只回答「未发现问题」。"


def build_args() -> list[str]:
    """三道锁：可复现（--bare）、权限（dontAsk + prompts none）、预算（turns + usd）。"""
    return [
        "claude", "--bare", "-p", "--output-format", "json",
        "--permission-mode", "dontAsk", "--permission-prompts", "none",
        "--max-turns", str(MAX_TURNS), "--max-budget-usd", str(MAX_BUDGET_USD),
        "--no-session-persistence", "--append-system-prompt", SYSTEM,
    ]


def mock_result(scenario: str) -> str:
    base = {"type": "result", "session_id": "mock-session", "duration_ms": 12345}
    scenarios = {
        "success": {**base, "subtype": "success", "is_error": False, "num_turns": 3, "total_cost_usd": 0.0421,
                    "result": "1. [高] src/routes/todos.ts:18 请求体被直接展开进对象。\n（离线模拟结果）"},
        "over-budget": {**base, "subtype": "success", "is_error": False, "num_turns": 6, "total_cost_usd": 1.87,
                        "result": "（模拟：任务完成了，但花费超过预算）"},
        "max-turns": {**base, "subtype": "error_max_turns", "is_error": True, "num_turns": 6, "total_cost_usd": 0.31,
                      "result": "（模拟：达到 max-turns 上限）"},
        "error": {**base, "subtype": "error_during_execution", "is_error": True, "num_turns": 1,
                  "total_cost_usd": 0.002, "result": "Not logged in（模拟：认证失败）"},
    }
    if scenario not in scenarios:
        raise SystemExit(f"未知的 MOCK_SCENARIO={scenario}，可选：{' / '.join(scenarios)}")
    return json.dumps(scenarios[scenario], ensure_ascii=False)


def run_claude(diff: str) -> str:
    if os.environ.get("MOCK") == "1":
        return mock_result(os.environ.get("MOCK_SCENARIO", "success"))
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("缺少 ANTHROPIC_API_KEY（--bare 不读订阅登录；或用 MOCK=1 离线运行）")
    proc = subprocess.run(build_args(), input=f"{PROMPT}\n\n<diff>\n{diff}\n</diff>", text=True, capture_output=True)
    if not proc.stdout.strip():
        raise SystemExit(f"claude 没有输出（exit {proc.returncode}）：{proc.stderr}")
    return proc.stdout


def verdict(result: dict) -> tuple[bool, str, str]:
    """返回 (ok, lock, reason)。顺序：轮数耗尽 → 出错 → 超预算 → 成功。"""
    cost = result.get("total_cost_usd", 0) or 0
    if result.get("subtype") == "error_max_turns":
        return False, "turns", f"轮数耗尽（max-turns={MAX_TURNS}）"
    if result.get("is_error"):
        return False, "error", f"claude 返回错误（{result.get('subtype')}）：{result.get('result', '无详情')}"
    if cost > MAX_BUDGET_USD:
        return False, "budget", f"花费 ${cost:.4f} 超过预算 ${MAX_BUDGET_USD}"
    return True, "", result.get("result", "")


def main() -> None:
    diff = "（MOCK）" if os.environ.get("MOCK") == "1" else subprocess.run(["git", "diff", BASE_REF], text=True, capture_output=True, check=True).stdout
    raw = run_claude(diff)
    result = json.loads(raw)
    open("review.json", "w").write(raw)
    print(f"subtype={result.get('subtype')} is_error={result.get('is_error')} turns={result.get('num_turns')} cost=${result.get('total_cost_usd', 0):.4f}")
    ok, lock, text = verdict(result)
    if ok:
        print("\n审查结果：\n" + text + "\n\n✅ 通过：已写入 review.json")
        return
    print(f"\n❌ 失败（触发的锁：{lock}）：{text}", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
