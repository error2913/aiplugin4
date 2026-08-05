#!/usr/bin/env python3
"""Verify a running QQ-MCP-Server: /health plus an MCP initialize handshake.

Usage:
    python verify.py [BASE_URL] [TOKEN]

Defaults: http://127.0.0.1:8888 and the token from QQ_MCP_ACCESS_TOKEN env or
the .env file in the current directory.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import httpx


def _token_from_env_file() -> str:
    env_path = Path(".env")
    if not env_path.exists():
        return ""
    for line in env_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("QQ_MCP_ACCESS_TOKEN="):
            return line.split("=", 1)[1].strip()
    return ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("base_url", nargs="?", default="http://127.0.0.1:8888")
    parser.add_argument("token", nargs="?", default=os.environ.get("QQ_MCP_ACCESS_TOKEN", ""))
    args = parser.parse_args()

    token = args.token or _token_from_env_file()
    if not token:
        print("未提供 token（命令行参数、QQ_MCP_ACCESS_TOKEN 环境变量或 .env）", file=sys.stderr)
        return 1

    base = args.base_url.rstrip("/")
    try:
        health = httpx.get(f"{base}/health", timeout=10)
        print(f"health -> HTTP {health.status_code}: {health.text}")
        if health.status_code != 200:
            return 1

        payload = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {},
                    "clientInfo": {"name": "verify", "version": "1.0"},
                },
            }
        )
        resp = httpx.post(
            f"{base}/mcp",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json, text/event-stream",
                "Content-Type": "application/json",
            },
            content=payload,
            timeout=15,
        )
        print(f"initialize -> HTTP {resp.status_code}")
        if resp.status_code == 200:
            print("OK: MCP 握手成功")
            return 0
        print(resp.text[:400])
        return 1
    except httpx.HTTPError as exc:
        print(f"连接失败: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
