#!/usr/bin/env bash
# 人在回路中的复现闭环。
# 复制本文件、编辑下面的步骤，然后运行。
# Agent 运行脚本；用户在自己的终端中按提示操作。
#
# 用法：
#   bash hitl-loop.template.sh
#
# 两个辅助函数：
#   step "<操作说明>"           → 显示说明并等待 Enter
#   capture VAR "<问题>"        → 显示问题并将回答读入 VAR
#
# 结束时，捕获的值以 KEY=VALUE 形式打印，供 Agent 解析。
#
# `capture` 会把值打印回 Agent 可读取的终端，因此只用它捕获观察结果；
# 登录等操作应留给用户作为 `step` 完成。

set -euo pipefail

step() {
  printf '\n>>> %s\n' "$1"
  read -r -p "    [完成后按 Enter] " _
}

capture() {
  local var="$1" question="$2" answer
  printf '\n>>> %s\n' "$question"
  read -r -p "    > " answer
  printf -v "$var" '%s' "$answer"
}

# --- 在下面编辑 ---------------------------------------------------------

step "打开 http://localhost:3000 并登录。"

capture ERRORED "点击“导出”按钮。是否出现错误？(y/n)"

capture ERROR_MSG "粘贴错误信息（没有则输入 'none'）："

# --- 在上面编辑 ---------------------------------------------------------

printf '\n--- 捕获结果 ---\n'
printf 'ERRORED=%s\n' "$ERRORED"
printf 'ERROR_MSG=%s\n' "$ERROR_MSG"
