"""Theo Code entry point — python -m theocode"""
from __future__ import annotations

import argparse
import os
import sys


def main():
    parser = argparse.ArgumentParser(
        prog="theocode",
        description="Theo Code — Sovereign Coding Intelligence by Theodore Quinlan",
    )
    parser.add_argument(
        "prompt", nargs="?", default=None,
        help="Optional one-shot prompt (non-interactive mode)",
    )
    parser.add_argument(
        "--base-url", default=os.environ.get("ANTHROPIC_BASE_URL", "http://localhost:8082"),
        help="API base URL (default: http://localhost:8082)",
    )
    parser.add_argument(
        "--model", default="claude-sonnet-4-5",
        help="Model name passed to proxy",
    )
    parser.add_argument(
        "--cwd", default=None,
        help="Working directory (defaults to current directory)",
    )
    args = parser.parse_args()

    from .repl import run_repl
    run_repl(
        base_url=args.base_url,
        model=args.model,
        cwd=args.cwd,
        prompt_arg=args.prompt,
    )


if __name__ == "__main__":
    main()
