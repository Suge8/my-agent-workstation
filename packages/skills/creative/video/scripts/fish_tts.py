#!/usr/bin/env python3
"""Fish Audio TTS：文本 → mp3/wav。key 读 ~/.config/fish-audio/config.json。

成功打印 {"ok":true,"paths":[...],"duration":...}，失败打印 {"ok":false,"error":...} 且退出码 1。
逐句生成旁白时每句调用一次，拿实际时长排画面（audio-first timing）。
"""
import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

CONFIG = Path.home() / ".config/fish-audio/config.json"
API = "https://api.fish.audio/v1/tts"


def fail(message: str):
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    sys.exit(1)


def probe_duration(path: Path):
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, timeout=30,
        ).stdout.strip()
        return round(float(out), 2)
    except (subprocess.SubprocessError, ValueError, FileNotFoundError):
        return None


def main():
    parser = argparse.ArgumentParser(description="Fish Audio TTS")
    parser.add_argument("text", nargs="?", help="要合成的文本；省略则读 stdin")
    parser.add_argument("--out", required=True, help="输出音频绝对路径")
    parser.add_argument("--voice", help="Fish 音色 reference_id（fish.audio 上挑选）")
    parser.add_argument("--model", default="s2.1-pro-free",
                        help="s2.1-pro-free（默认，质量同 pro 但无 SLA）| s2.1-pro（需在 fish.audio/app/developers 充 API credit）")
    parser.add_argument("--format", default="mp3", choices=["mp3", "wav", "opus"])
    args = parser.parse_args()

    text = args.text or sys.stdin.read().strip()
    if not text:
        fail("empty text")
    if not CONFIG.exists():
        fail(f"missing {CONFIG}")
    key = json.loads(CONFIG.read_text())["key"]

    body = {"text": text, "format": args.format}
    if args.voice:
        body["reference_id"] = args.voice

    request = urllib.request.Request(
        API,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "model": args.model,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            audio = response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:500]
        if error.code == 402:
            detail += " （账户无余额：充值或改用 --model s2.1-pro-free）"
        fail(f"HTTP {error.code}: {detail}")
    except urllib.error.URLError as error:
        fail(f"network: {error.reason}")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(audio)
    print(json.dumps(
        {"ok": True, "paths": [str(out)], "duration": probe_duration(out)},
        ensure_ascii=False))


if __name__ == "__main__":
    main()
