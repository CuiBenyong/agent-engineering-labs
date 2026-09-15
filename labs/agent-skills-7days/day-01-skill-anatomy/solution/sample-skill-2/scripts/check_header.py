# /// script
# dependencies = []
# ///
"""打印 CSV 的表头与逐列推断类型。用法：uv run scripts/check_header.py <文件>"""
import csv
import json
import sys


def infer(values: list[str]) -> str:
    if all(v.strip().lstrip("-").isdigit() for v in values if v.strip()):
        return "integer"
    return "string"


def main() -> int:
    if len(sys.argv) != 2:
        print("用法: check_header.py <csv 文件>", file=sys.stderr)
        return 2
    with open(sys.argv[1], newline="", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    if not rows:
        print("空文件", file=sys.stderr)
        return 1
    header, body = rows[0], rows[1:]
    cols = [{"name": h, "type": infer([r[i] for r in body if i < len(r)])} for i, h in enumerate(header)]
    print(json.dumps({"columns": cols}, ensure_ascii=False))
    return 0


raise SystemExit(main())
