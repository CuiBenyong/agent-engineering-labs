"""D2 实验的 Python 对照版：读一份 PDF，输出带页码引用的摘要，并打印缓存相关的 usage。

用法：
    pip install anthropic
    MOCK=1 python summarize.py ../sample.pdf          # 离线
    ANTHROPIC_API_KEY=... python summarize.py x.pdf   # 真实调用
"""

from __future__ import annotations

import base64
import os
import sys
from dataclasses import dataclass, field

MODEL = os.environ.get("MODEL", "claude-sonnet-5")
_mock_calls = 0


@dataclass
class Segment:
    text: str
    pages: list[int] = field(default_factory=list)


def ask(pdf_b64: str, title: str, question: str) -> tuple[list[Segment], dict[str, int], str | None]:
    """唯一的网络出口；MOCK=1 时返回结构完整的假结果。"""
    global _mock_calls
    if os.environ.get("MOCK") == "1":
        first = _mock_calls == 0
        _mock_calls += 1
        segs = [
            Segment("这份报告指出 POST /todos 接口完全没有请求体校验。", [1]),
            Segment("title 可为空、dueAt 接受任意字符串、客户端还能覆盖 id 与 done。", [2]),
            Segment("修复方案是引入 zod 或 pydantic schema，非法请求返回 400。", [3]),
            Segment("测试计划包含四个用例，并要求在每个 PR 的 CI 里运行。", [4]),
        ]
        usage = (
            {"input": 42, "output": 180, "cache_write": 5300, "cache_read": 0}
            if first
            else {"input": 38, "output": 175, "cache_write": 0, "cache_read": 5300}
        )
        return segs, usage, "end_turn"

    import anthropic  # 延迟导入：MOCK 模式下不需要装 SDK

    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("缺少 ANTHROPIC_API_KEY（或用 MOCK=1 离线运行）")
    client = anthropic.Anthropic()
    res = client.messages.create(
        model=MODEL,
        max_tokens=2048,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "document",  # 材料在前
                        "source": {"type": "base64", "media_type": "application/pdf", "data": pdf_b64},
                        "title": title,
                        "citations": {"enabled": True},
                        "cache_control": {"type": "ephemeral"},  # 文档不变、问题会变，断点打在文档末尾
                    },
                    {"type": "text", "text": question},  # 指令在后
                ],
            }
        ],
    )
    segs: list[Segment] = []
    for block in res.content:
        if block.type != "text":
            continue
        pages = [c.start_page_number for c in (block.citations or []) if c.type == "page_location"]
        segs.append(Segment(block.text, pages))
    u = res.usage
    usage = {
        "input": u.input_tokens,
        "output": u.output_tokens,
        "cache_write": u.cache_creation_input_tokens or 0,
        "cache_read": u.cache_read_input_tokens or 0,
    }
    return segs, usage, res.stop_reason


def render(segs: list[Segment]) -> str:
    lines = []
    for s in segs:
        pages = sorted(set(s.pages))
        lines.append(f"{s.text} [{', '.join(f'p.{p}' for p in pages)}]" if pages else s.text)
    return "\n".join(lines)


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("用法：python summarize.py <文件.pdf> [问题…]")
    path = sys.argv[1]
    raw = open(path, "rb").read()
    if not raw.startswith(b"%PDF-"):
        raise SystemExit(f"{path} 不是 PDF")
    pdf_b64 = base64.standard_b64encode(raw).decode()  # 不能有换行
    questions = sys.argv[2:] or ["用五句话总结这份文档的核心结论，每句都要有依据。", "这份文档里提到了哪些风险或问题？"]
    print(f"模型：{MODEL}  文档：{os.path.basename(path)}\n")
    for i, q in enumerate(questions, 1):
        print(f"问题 {i}：{q}")
        segs, usage, stop = ask(pdf_b64, os.path.basename(path), q)
        print(render(segs))
        if stop == "max_tokens":
            print("⚠️  stop_reason=max_tokens：输出被截断，请调大 max_tokens")
        print(f"[usage:q{i}] uncached={usage['input']} cache_write={usage['cache_write']} cache_read={usage['cache_read']} output={usage['output']}\n")


if __name__ == "__main__":
    main()
