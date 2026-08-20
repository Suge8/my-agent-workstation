#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
DEFAULT_MODEL = "gpt-5.4"


def load_auth(path: Path) -> tuple[str, str]:
    auth = json.loads(path.read_text())
    tokens = auth.get("tokens") or {}
    access_token = tokens.get("access_token")
    account_id = tokens.get("account_id")
    if not access_token or not account_id:
        raise RuntimeError(f"missing tokens.access_token or tokens.account_id in {path}")
    return access_token, account_id


def build_payload(
    prompt: str,
    model: str,
    size: str | None = None,
    quality: str | None = None,
    refs: list[Path] | None = None,
) -> dict:
    tool: dict = {"type": "image_generation", "output_format": "png"}
    if size:
        tool["size"] = size
    if quality:
        tool["quality"] = quality
    content: list[dict] = [{"type": "input_text", "text": prompt}]
    for ref in refs or []:
        mime = "image/png" if ref.suffix.lower() == ".png" else "image/jpeg"
        encoded = base64.b64encode(ref.read_bytes()).decode()
        content.append({"type": "input_image", "image_url": f"data:{mime};base64,{encoded}"})
    return {
        "model": model,
        "instructions": (
            "Use the image_generation tool exactly once. "
            "Return no extra text unless image generation fails."
        ),
        "input": [
            {
                "role": "user",
                "content": content,
            }
        ],
        "tools": [tool],
        "tool_choice": "auto",
        "parallel_tool_calls": False,
        "stream": True,
        "store": False,
    }


def iter_sse(url: str, payload: dict, headers: dict, timeout: int):
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        for line in response:
            if not line.startswith(b"data:"):
                continue
            data = line[5:].strip()
            if not data or data == b"[DONE]":
                continue
            yield json.loads(data)


def walk(value):
    stack = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            yield current
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)


def generate(args) -> dict:
    access_token, account_id = load_auth(args.auth)
    headers = {
        "Authorization": f"Bearer {access_token}",
        "ChatGPT-Account-ID": account_id,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "User-Agent": "gpt-image-skill/1.0",
    }
    payload = build_payload(args.prompt, args.model, args.size, args.quality, args.ref)
    image_item = None
    for event in iter_sse(ENDPOINT, payload, headers, args.timeout):
        for item in walk(event):
            if item.get("type") == "image_generation_call" and item.get("result"):
                image_item = item
    if not image_item:
        raise RuntimeError("no image_generation_call.result in SSE response")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(base64.b64decode(image_item["result"]))
    return {
        "ok": True,
        "path": str(args.out),
        "id": image_item.get("id"),
        "size": image_item.get("size"),
        "quality": image_item.get("quality"),
        "revised_prompt": image_item.get("revised_prompt"),
    }


def parse_args():
    parser = argparse.ArgumentParser(description="Generate PNG via Codex hosted image_generation.")
    parser.add_argument("prompt", nargs="?", help="Image prompt. Reads stdin when omitted.")
    parser.add_argument("--out", required=True, type=Path, help="Output PNG path.")
    parser.add_argument("--auth", type=Path, default=Path.home() / ".codex/auth.json")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--timeout", type=int, default=240)
    parser.add_argument(
        "--ref", action="append", type=Path, default=[],
        help="Reference image path. Repeatable.",
    )
    parser.add_argument("--size", help="e.g. 1024x1024, 1024x1536, 1536x1024")
    parser.add_argument("--quality", help="low, medium, high")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.prompt:
        args.prompt = sys.stdin.read().strip()
    if not args.prompt:
        print(json.dumps({"ok": False, "error": "empty prompt"}), file=sys.stderr)
        return 2
    try:
        print(json.dumps(generate(args), ensure_ascii=False))
        return 0
    except urllib.error.HTTPError as error:
        body = error.read(1200).decode("utf-8", "replace")
        print(
            json.dumps({"ok": False, "status": error.code, "error": body}, ensure_ascii=False),
            file=sys.stderr,
        )
        return 1
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
