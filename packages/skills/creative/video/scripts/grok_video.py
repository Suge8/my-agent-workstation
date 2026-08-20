#!/usr/bin/env python3
"""Generate an MP4 via Grok Build's /imagine-video slash command."""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SESSIONS_DIR = Path.home() / ".grok" / "sessions"
# Grok scans ~/.agents as a skill root, so the inner grok can see this very
# skill and re-run this script forever. The env guard breaks that recursion.
GUARD_ENV = "VIDEO_GEN_SKILL_ACTIVE"
INNER_RULES = (
    "You are the video generator. Never invoke the video-gen skill or run "
    "grok_video.py; use the built-in imagine video workflow "
    "(image generation + image_to_video) directly."
)


def fail(message: str):
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    sys.exit(1)


def run_grok(prompt: str, workdir: Path, timeout: int) -> dict:
    command = [
        "grok",
        "-p", f"/imagine-video {prompt}",
        "--always-approve",
        "--output-format", "json",
        "--rules", INNER_RULES,
    ]
    try:
        proc = subprocess.run(
            command, cwd=workdir, capture_output=True, text=True, timeout=timeout,
            env={**os.environ, GUARD_ENV: "1"},
        )
    except subprocess.TimeoutExpired:
        fail(f"grok timed out after {timeout}s")
    except FileNotFoundError:
        fail("grok CLI not found in PATH")
    if proc.returncode != 0:
        fail(f"grok exited {proc.returncode}: {proc.stderr.strip()[:500]}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        fail(f"unparseable grok output: {proc.stdout[:500]}")


def find_clips(session_id: str) -> list[Path]:
    session_dir = next(SESSIONS_DIR.glob(f"*/{session_id}"), None)
    if session_dir is None:
        return []
    return sorted((session_dir / "videos").glob("*.mp4"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", nargs="?", help="video description; omit to read stdin")
    parser.add_argument("--out", required=True, help="absolute output .mp4 path")
    parser.add_argument("--timeout", type=int, default=900, help="seconds (default 900)")
    args = parser.parse_args()

    if os.environ.get(GUARD_ENV):
        fail(
            "recursion guard: already inside a video-gen run; "
            "use the built-in imagine video workflow directly"
        )
    prompt = args.prompt or sys.stdin.read().strip()
    if not prompt:
        fail("empty prompt")
    out = Path(args.out).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    workdir = Path(tempfile.mkdtemp(prefix="grok-video-"))
    try:
        result = run_grok(prompt, workdir, args.timeout)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    session_id = result.get("sessionId")
    if not session_id:
        fail("no sessionId in grok output")
    clips = find_clips(session_id)
    if not clips:
        fail(f"no video produced; model said: {result.get('text', '')[:500]}")

    paths = []
    for index, clip in enumerate(clips):
        dest = out if len(clips) == 1 else out.with_stem(f"{out.stem}-{index + 1}")
        shutil.copy2(clip, dest)
        paths.append(str(dest))
    print(json.dumps(
        {"ok": True, "paths": paths, "session_id": session_id, "text": result.get("text", "")},
        ensure_ascii=False,
    ))


if __name__ == "__main__":
    main()
