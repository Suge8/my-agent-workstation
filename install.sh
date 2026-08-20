#!/bin/bash
set -eu

REPOSITORY=${MYAW_REPOSITORY:-Suge8/my-agent-workstation}
API="https://api.github.com/repos/$REPOSITORY/releases/latest"

os=$(uname -s)
arch=$(uname -m)
test "$os" = Darwin && test "$arch" = arm64 || {
  printf '%s\n' 'My Agent Workstation 仅支持 Apple Silicon macOS。' >&2
  exit 2
}

release=$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API") || {
  printf '%s\n' '无法读取最新稳定 Release；请检查网络或仓库是否已经发布。' >&2
  exit 1
}
tag=$(printf '%s' "$release" | awk 'match($0, /"tag_name"[[:space:]]*:[[:space:]]*"[^"]+"/) { value=substr($0,RSTART,RLENGTH); sub(/^.*"tag_name"[[:space:]]*:[[:space:]]*"/,"",value); sub(/"$/,"",value); print value; exit }')
test -n "$tag" || { printf '%s\n' 'Release 响应缺少 tag_name。' >&2; exit 1; }

work=$(mktemp -d "${TMPDIR:-/tmp}/my-agent-workstation.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
archive="$work/source.tar.gz"
curl -fsSL "https://github.com/$REPOSITORY/archive/refs/tags/$tag.tar.gz" -o "$archive"
tar -xzf "$archive" -C "$work"
root=$(find "$work" -mindepth 1 -maxdepth 1 -type d -name 'my-agent-workstation-*' -print -quit)
test -x "$root/setup" || { printf '%s\n' 'Release 缺少可执行 setup。' >&2; exit 1; }
"$root/setup" "$@"
