#!/usr/bin/env python3
"""Generate a fresh .env for QQ-MCP-Server with a random MCP access token.

Usage:
    python init_env.py [PROJECT_DIR] [--template .env.example]

Defaults to the current directory. Never overwrites an existing .env.
"""

from __future__ import annotations

import argparse
import re
import secrets
import sys
from pathlib import Path

TOKEN_RE = re.compile(r"^(QQ_MCP_ACCESS_TOKEN=).*$", re.MULTILINE)


def generate_token(length: int = 48) -> str:
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    return "".join(secrets.choice(alphabet) for _ in range(length))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("project_dir", nargs="?", default=".")
    parser.add_argument("--template", default=".env.example")
    args = parser.parse_args()

    root = Path(args.project_dir)
    template = root / args.template
    out = root / ".env"
    if not template.exists():
        print(f"模板不存在: {template}", file=sys.stderr)
        return 1
    if out.exists():
        print(f".env 已存在，跳过生成: {out}")
        return 0

    content = template.read_text(encoding="utf-8")
    token = generate_token()
    content = TOKEN_RE.sub(rf"\g<1>{token}", content)
    out.write_text(content, encoding="utf-8")
    print(f"已生成 {out}")
    print(f"QQ_MCP_ACCESS_TOKEN={token}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
