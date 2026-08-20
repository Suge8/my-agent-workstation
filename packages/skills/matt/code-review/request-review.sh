#!/bin/sh
set -eu

if [ "${HERDR_ENV:-}" != 1 ] || [ -z "${HERDR_PANE_ID:-}" ]; then
  echo "FireReview 自动触发需要运行在 Herdr 中" >&2
  exit 1
fi

focus=$*
command=/fire-review
if [ -n "$focus" ]; then
  command="$command $focus"
fi

exec herdr agent prompt "$HERDR_PANE_ID" "$command"
