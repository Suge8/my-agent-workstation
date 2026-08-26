#!/usr/bin/env python3
"""Lightweight Context7 CLI wrapper with concise defaults."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys


LIBRARY_ID_RE = re.compile(r"^/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)?$")


class Context7CliError(RuntimeError):
    """Wrapper-level error."""


def run_ctx7(args: list[str]) -> str:
    proc = subprocess.run(
        ["npx", "-y", "ctx7", *args],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise Context7CliError((proc.stderr or proc.stdout).strip() or "ctx7 command failed")
    return proc.stdout.strip()


def extract_library_id(output: str) -> str | None:
    match = re.search(r"Context7-compatible library ID:\s*(\S+)", output)
    if match:
        return match.group(1)
    return None


def trim_output(text: str, top: int) -> str:
    if top == 0:
        return text
    lines = text.splitlines()
    return "\n".join(lines[:top]).strip()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Use Context7 CLI with concise defaults.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    resolve_parser = subparsers.add_parser("resolve", help="Resolve a library name to Context7 IDs.")
    resolve_parser.add_argument("--library", required=True, help="Library/package name.")
    resolve_parser.add_argument("--question", default="", help="Optional ranking hint.")
    resolve_parser.add_argument("--top", type=int, default=12, help="Max output lines. Use 0 for full output.")

    docs_parser = subparsers.add_parser("docs", help="Query docs using a known Context7 library ID.")
    docs_parser.add_argument("--library-id", required=True, help="Context7 library ID like /org/project.")
    docs_parser.add_argument("--question", required=True, help="Documentation question.")
    docs_parser.add_argument("--top", type=int, default=20, help="Max output lines. Use 0 for full output.")

    query_parser = subparsers.add_parser("query", help="Resolve first, then fetch docs.")
    query_parser.add_argument("--library", required=True, help="Library/package name or Context7 library ID.")
    query_parser.add_argument("--question", required=True, help="Documentation question.")
    query_parser.add_argument("--top", type=int, default=20, help="Max output lines. Use 0 for full output.")

    subparsers.add_parser("whoami", help="Show current login state.")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "resolve":
            output = run_ctx7(["library", args.library, args.question] if args.question else ["library", args.library])
            print(trim_output(output, args.top))
            return 0
        if args.command == "docs":
            output = run_ctx7(["docs", args.library_id, args.question])
            print(trim_output(output, args.top))
            return 0
        if args.command == "whoami":
            print(run_ctx7(["whoami"]))
            return 0

        library = args.library
        if LIBRARY_ID_RE.match(library):
            library_id = library
        else:
            resolve_output = run_ctx7(["library", library, args.question])
            library_id = extract_library_id(resolve_output)
            if not library_id:
                raise Context7CliError("Could not resolve a Context7 library ID. Run `resolve` first.")
        docs_output = run_ctx7(["docs", library_id, args.question])
        print(trim_output(docs_output, args.top))
        return 0
    except Context7CliError as exc:
        print(f"[context7] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
