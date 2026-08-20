#!/bin/bash

# shellcheck disable=SC2034 # Consumed by the sourcing setup script.
WORKSTATION_VERSION='0.1.0'
PI_AGENT_HOME=${PI_AGENT_HOME:-"$HOME/.pi/agent"}
XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-"$HOME/.config"}
PACKAGE_HOME="$STATE_HOME/pi-package"
RUNTIME_HOME="$STATE_HOME/runtime"
BACKUP_HOME="$STATE_HOME/backups"
INTEGRITY_HOME="$STATE_HOME/integrity"
OWNERSHIP_HOME="$STATE_HOME/ownership"
MANAGED_MARKER='# >>> my-agent-workstation >>>'
MANAGED_END='# <<< my-agent-workstation <<<'
MODE=${MODE:-core}
REPLACE_SYSTEM=${REPLACE_SYSTEM:-0}
KEEP_SYSTEM=${KEEP_SYSTEM:-0}
WITH_BCU=${WITH_BCU:-0}
WITH_BROWSER=${WITH_BROWSER:-0}
WITH_TERMINAL=${WITH_TERMINAL:-0}
WITH_HELIUM=${WITH_HELIUM:-0}
WITH_SEARCH=${WITH_SEARCH:-0}
SELECTIONS=${SELECTIONS:-}
FORCE_UPDATE=${FORCE_UPDATE:-0}

acquire_workstation_lock() {
  mkdir -p "$STATE_HOME"
  lock="$STATE_HOME/.lock"
  if mkdir "$lock" 2>/dev/null; then
    printf '%s\n' "$$" > "$lock/pid"
    trap 'rm -rf "$STATE_HOME/.lock"' EXIT HUP INT TERM
    return 0
  fi
  owner=$(cat "$lock/pid" 2>/dev/null || true)
  if test -n "$owner" && kill -0 "$owner" 2>/dev/null; then
    printf '已有 setup 正在运行（PID %s）。\n' "$owner" >&2
    return 1
  fi
  rm -rf "$lock"
  mkdir "$lock" 2>/dev/null || { printf '无法取得 setup 锁。\n' >&2; return 1; }
  printf '%s\n' "$$" > "$lock/pid"
  trap 'rm -rf "$STATE_HOME/.lock"' EXIT HUP INT TERM
}

release_workstation_lock() {
  rm -rf "$STATE_HOME/.lock"
  trap - EXIT HUP INT TERM
}

workstation_mode_defaults() {
  case "$MODE" in
    core) ;;
    full) WITH_BCU=1; WITH_BROWSER=1; WITH_TERMINAL=1; WITH_HELIUM=1; WITH_SEARCH=1 ;;
    custom) ;;
    *) printf '未知安装模式: %s\n' "$MODE" >&2; return 64 ;;
  esac
}

shell_hook_body() {
  printf 'source %q' "$STATE_HOME/config/init.zsh"
}

workstation_detect() {
  PACKAGE_STATUS=missing
  test -f "$PACKAGE_HOME/package.json" && check_integrity package && PACKAGE_STATUS=normal
  SYSTEM_STATUS=missing
  if test -f "$PI_AGENT_HOME/SYSTEM.md"; then
    if owns_component system; then
      if cmp -s "$PI_AGENT_HOME/SYSTEM.md" "$STATE_HOME/system-installed.md"; then SYSTEM_STATUS=normal; else SYSTEM_STATUS=conflict; fi
    elif cmp -s "$PI_AGENT_HOME/SYSTEM.md" "$ROOT/packages/pi-config/SYSTEM.md"; then
      SYSTEM_STATUS=normal
    else
      SYSTEM_STATUS=unmanaged
    fi
  fi
  TERMINAL_STATUS=missing
  if brew list --cask ghostty >/dev/null 2>&1 && brew list --cask font-maple-mono-nf >/dev/null 2>&1 &&
     brew list --versions starship >/dev/null 2>&1 && brew list --versions fastfetch >/dev/null 2>&1 &&
     brew list --versions zsh-autosuggestions >/dev/null 2>&1 && brew list --versions zsh-syntax-highlighting >/dev/null 2>&1 &&
     check_integrity terminal && check_integrity shell-init &&
     managed_block_is "$XDG_CONFIG_HOME/ghostty/config" "config-file = \"$STATE_HOME/config/ghostty.conf\"" &&
     managed_block_is "$HOME/.zshrc" "$(shell_hook_body)"; then TERMINAL_STATUS=normal; fi
  HELIUM_STATUS=missing
  brew list --cask helium-browser >/dev/null 2>&1 && HELIUM_STATUS=normal
  SEARCH_STATUS=missing
  security find-generic-password -s my-agent-workstation.brave -w >/dev/null 2>&1 && SEARCH_STATUS=partial
  if security find-generic-password -s my-agent-workstation.exa -w >/dev/null 2>&1; then
    if test "$SEARCH_STATUS" = partial; then SEARCH_STATUS=normal; else SEARCH_STATUS=partial; fi
  fi
}

workstation_print_doctor_json() {
  printf ',"workstation":{'
  printf '"package":{"status":"%s"},' "$PACKAGE_STATUS"
  printf '"system_prompt":{"status":"%s"},' "$SYSTEM_STATUS"
  printf '"terminal":{"status":"%s"},' "$TERMINAL_STATUS"
  printf '"helium":{"status":"%s"},' "$HELIUM_STATUS"
  printf '"search":{"status":"%s"}' "$SEARCH_STATUS"
  printf '}'
}

workstation_append_plan() {
  workstation_mode_defaults || return
  if test "$PACKAGE_STATUS" != normal || test "$FORCE_UPDATE" -eq 1; then ACTIONS+=(install_workstation_package); fi
  ACTIONS+=(configure_pi)
  if test "$REPLACE_SYSTEM" -eq 1; then ACTIONS+=(replace_system); fi
  if test "$WITH_BCU" -eq 1; then
    if ! bcu --help >/dev/null 2>&1 || { test "$FORCE_UPDATE" -eq 1 && owns_component bcu; }; then ACTIONS+=(install_bcu); fi
  fi
  if test "$WITH_BROWSER" -eq 1 && { test "$BROWSER_STATUS" != normal || test "$FORCE_UPDATE" -eq 1; }; then ACTIONS+=(install_browser); fi
  if test "$WITH_TERMINAL" -eq 1 && { test "$TERMINAL_STATUS" != normal || test "$FORCE_UPDATE" -eq 1; }; then ACTIONS+=(install_terminal); fi
  if test "$WITH_HELIUM" -eq 1 && { test "$HELIUM_STATUS" != normal || test "$FORCE_UPDATE" -eq 1; }; then ACTIONS+=(install_helium); fi
  ACTIONS+=(sync_runtime)
}

backup_once() {
  target=$1 name=$2
  mkdir -p "$BACKUP_HOME"
  if test -e "$BACKUP_HOME/$name" || test -e "$BACKUP_HOME/$name.absent"; then return; fi
  if test -e "$target"; then cp -p "$target" "$BACKUP_HOME/$name"; else : > "$BACKUP_HOME/$name.absent"; fi
}

own_component() {
  mkdir -p "$OWNERSHIP_HOME"
  : > "$OWNERSHIP_HOME/$1"
}

owns_component() {
  test -f "$OWNERSHIP_HOME/$1"
}

retire_backup() {
  name=$1
  mkdir -p "$BACKUP_HOME/history"
  generation=$(date +%s).$$
  test ! -e "$BACKUP_HOME/$name" || mv "$BACKUP_HOME/$name" "$BACKUP_HOME/history/$generation.$name" || return
  test ! -e "$BACKUP_HOME/$name.absent" || mv "$BACKUP_HOME/$name.absent" "$BACKUP_HOME/history/$generation.$name.absent" || return
}

restore_owned_file() {
  target=$1 name=$2 owner=$3
  owns_component "$owner" || return 0
  if test -f "$BACKUP_HOME/$name"; then
    mkdir -p "$(dirname "$target")"
    cp -p "$BACKUP_HOME/$name" "$target" || return
  elif test -f "$BACKUP_HOME/$name.absent"; then
    rm -f "$target" || return
  fi
  retire_backup "$name" || return
  rm -f "$OWNERSHIP_HOME/$owner"
}

record_integrity() {
  name=$1
  shift
  mkdir -p "$INTEGRITY_HOME"
  temporary="$INTEGRITY_HOME/$name.sha256.tmp.$$"
  : > "$temporary"
  for file in "$@"; do
    test -f "$file" || { rm -f "$temporary"; return 1; }
    shasum -a 256 "$file" >> "$temporary" || { rm -f "$temporary"; return 1; }
  done
  mv "$temporary" "$INTEGRITY_HOME/$name.sha256"
}

check_integrity() {
  name=$1
  manifest="$INTEGRITY_HOME/$name.sha256"
  test -f "$manifest" || return 1
  shasum -a 256 -c "$manifest" >/dev/null 2>&1 || return 1
  if test "$name" = package; then
    expected=$(wc -l < "$manifest" | tr -d ' ')
    actual=$(find "$PACKAGE_HOME" -type f | wc -l | tr -d ' ')
    test "$actual" = "$expected" || return 1
  fi
}

managed_block_is() {
  target=$1 expected=$2
  test -f "$target" || return 1
  starts=$(grep -Fxc "$MANAGED_MARKER" "$target" 2>/dev/null || true)
  ends=$(grep -Fxc "$MANAGED_END" "$target" 2>/dev/null || true)
  test "$starts" = 1 && test "$ends" = 1 || return 1
  actual=$(awk -v start="$MANAGED_MARKER" -v finish="$MANAGED_END" '
    $0 == start { managed=1; next }
    $0 == finish { managed=0; next }
    managed { print }
  ' "$target")
  test "$actual" = "$expected"
}

record_package_integrity() {
  mkdir -p "$INTEGRITY_HOME"
  temporary="$INTEGRITY_HOME/package.sha256.tmp.$$"
  find "$PACKAGE_HOME" -type f | LC_ALL=C sort | xargs shasum -a 256 > "$temporary" || {
    rm -f "$temporary"
    return 1
  }
  test -s "$temporary" || { rm -f "$temporary"; return 1; }
  mv "$temporary" "$INTEGRITY_HOME/package.sha256"
}

install_workstation_package() {
  old_config="$STATE_HOME/firecode-config.jsonc"
  if test -f "$PACKAGE_HOME/firecode/config.jsonc"; then
    cp "$PACKAGE_HOME/firecode/config.jsonc" "$old_config"
  fi
  temporary="$PACKAGE_HOME.tmp.$$"
  rm -rf "$temporary"
  mkdir -p "$temporary"
  cp -R "$ROOT/packages/firecode" "$temporary/firecode"
  cp -R "$ROOT/packages/skills" "$temporary/skills"
  if test -f "$old_config"; then cp "$old_config" "$temporary/firecode/config.jsonc"; fi
  printf '%s\n' '{"name":"my-agent-workstation-pi","version":"0.1.0","private":true,"keywords":["pi-package"],"pi":{"extensions":["firecode/index.ts"],"skills":["skills"]}}' > "$temporary/package.json"
  rm -rf "$PACKAGE_HOME"
  mv "$temporary" "$PACKAGE_HOME"
  pi install "$PACKAGE_HOME" >/dev/null
  if pi list 2>/dev/null | grep -Fq 'pi-antigravity'; then
    if test "$FORCE_UPDATE" -eq 1; then pi update npm:pi-antigravity >/dev/null; fi
  else
    pi install npm:pi-antigravity >/dev/null
  fi
}

authenticated_providers() {
  providers=
  candidates='openai-codex anthropic xai deepseek kimi-coding antigravity'
  choices=${SELECTIONS:-}
  test -n "$choices" || choices="$STATE_HOME/model-selections.json"
  if command -v node >/dev/null 2>&1 && test -f "$choices"; then
    extra=$(node -e '
      const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
      const refs=[...Object.values(s.models||{}),s.default].filter(x=>typeof x==="string");
      process.stdout.write([...new Set(refs.map(x=>x.split("/",1)[0]))].join(" "));
    ' "$choices" 2>/dev/null || true)
    candidates="$candidates $extra"
  fi
  seen=' '
  for provider in $candidates; do
    case "$seen" in *" $provider "*) continue ;; esac
    seen="$seen$provider "
    output=$(pi auth check --provider "$provider" --json --no-refresh 2>/dev/null || true)
    if printf '%s' "$output" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ready"'; then
      if test -n "$providers"; then providers="$providers,$provider"; else providers=$provider; fi
    fi
  done
  printf '%s' "$providers"
}

available_models() {
  pi --list-models 2>/dev/null | awk 'NR > 1 && $1 != "provider" { print $1 "/" $2 }' | paste -sd, -
}

configure_pi() {
  mkdir -p "$PI_AGENT_HOME"
  backup_once "$PI_AGENT_HOME/settings.json" pi-settings.json
  backup_once "$PI_AGENT_HOME/keybindings.json" pi-keybindings.json
  own_component pi-settings
  own_component pi-keybindings
  providers=$(authenticated_providers)
  models=$(available_models)
  stored_selections="$STATE_HOME/model-selections.json"
  if test -n "$SELECTIONS"; then
    mkdir -p "$STATE_HOME"
    cp "$SELECTIONS" "$stored_selections"
    chmod 600 "$stored_selections"
  elif test -f "$stored_selections"; then
    SELECTIONS=$stored_selections
  fi
  set -- \
    --profile "$ROOT/resources/models/recommended.json" \
    --providers "$providers" \
    --available-models "$models" \
    --ownership "$STATE_HOME/pi-managed.json" \
    --pi-settings "$PI_AGENT_HOME/settings.json" \
    --pi-keybindings "$PI_AGENT_HOME/keybindings.json" \
    --firecode "$PACKAGE_HOME/firecode/config.jsonc"
  if test -n "$SELECTIONS"; then set -- "$@" --selections "$SELECTIONS"; fi
  node "$ROOT/scripts/configure-workstation.mjs" "$@" >/dev/null || return
  record_package_integrity || return
  if test -z "$providers" && test "$JSON" -eq 0; then
    printf '未检测到已认证模型；FireCode 模型能力保持关闭。请在 Pi 中运行 /login 后重试配置。\n' >&2
  fi
}

restore_pi_configuration() {
  owns_component pi-settings || owns_component pi-keybindings || return 0
  node "$ROOT/scripts/configure-workstation.mjs" \
    --mode restore \
    --ownership "$STATE_HOME/pi-managed.json" \
    --pi-settings "$PI_AGENT_HOME/settings.json" \
    --pi-keybindings "$PI_AGENT_HOME/keybindings.json" \
    --pi-settings-backup "$BACKUP_HOME/pi-settings.json" \
    --pi-keybindings-backup "$BACKUP_HOME/pi-keybindings.json" >/dev/null || return
  retire_backup pi-settings.json || return
  retire_backup pi-keybindings.json || return
  rm -f "$OWNERSHIP_HOME/pi-settings" "$OWNERSHIP_HOME/pi-keybindings"
}

detach_system() {
  owns_component system || return 0
  retire_backup SYSTEM.md || return
  rm -f "$OWNERSHIP_HOME/system" "$STATE_HOME/system-installed.md"
}

prepare_update_system() {
  if test "$SYSTEM_CHOICE_EXPLICIT" -eq 1; then
    if test "$KEEP_SYSTEM" -eq 1; then detach_system || return; fi
    return 0
  fi
  if owns_component system; then
    if cmp -s "$PI_AGENT_HOME/SYSTEM.md" "$STATE_HOME/system-installed.md"; then
      REPLACE_SYSTEM=1
    else
      printf 'SYSTEM 已被修改；请用 --keep-system 保留它，或用 --replace-system 覆盖它。\n' >&2
      return 3
    fi
  else
    KEEP_SYSTEM=1
  fi
}

replace_system() {
  mkdir -p "$PI_AGENT_HOME"
  backup_once "$PI_AGENT_HOME/SYSTEM.md" SYSTEM.md
  own_component system
  cp "$ROOT/packages/pi-config/SYSTEM.md" "$PI_AGENT_HOME/SYSTEM.md"
  cp "$ROOT/packages/pi-config/SYSTEM.md" "$STATE_HOME/system-installed.md"
  chmod 600 "$PI_AGENT_HOME/SYSTEM.md" "$STATE_HOME/system-installed.md"
}

install_bcu() {
  archive_dir=$(mktemp -d "${TMPDIR:-/tmp}/myaw-bcu.XXXXXX") || return
  package="$archive_dir/package"
  mkdir -p "$package"
  cp -R "$ROOT/packages/better-computer-use/." "$package" || { rm -rf "$archive_dir"; return 1; }
  npm install --prefix "$package" --ignore-scripts --no-audit --no-fund >/dev/null || { rm -rf "$archive_dir"; return 1; }
  npm run --prefix "$package" build >/dev/null || { rm -rf "$archive_dir"; return 1; }
  (cd "$package" && npm pack --pack-destination "$archive_dir" --ignore-scripts >/dev/null) || { rm -rf "$archive_dir"; return 1; }
  tarball=$(find "$archive_dir" -type f -name '*.tgz' -print -quit)
  test -n "$tarball" || { rm -rf "$archive_dir"; return 1; }
  npm install --global --ignore-scripts "$tarball" >/dev/null || { rm -rf "$archive_dir"; return 1; }
  global_root=$(npm root --global) || { npm uninstall --global better-computer-use >/dev/null 2>&1; rm -rf "$archive_dir"; return 1; }
  if ! node "$global_root/better-computer-use/scripts/setup-helper.mjs" --runtime >/dev/null; then
    npm uninstall --global better-computer-use >/dev/null 2>&1
    rm -rf "$archive_dir"
    return 1
  fi
  rm -rf "$archive_dir"
  own_component bcu
  bcu doctor --json >/dev/null 2>&1 || true
}

rebuild_shell_init() {
  mkdir -p "$STATE_HOME/config/shell.d"
  : > "$STATE_HOME/config/init.zsh"
  for fragment in "$STATE_HOME"/config/shell.d/*.zsh; do
    test -f "$fragment" || continue
    cat "$fragment" >> "$STATE_HOME/config/init.zsh"
  done
  record_integrity shell-init "$STATE_HOME/config/init.zsh"
}

ensure_shell_hook() {
  append_managed_block "$HOME/.zshrc" "$(shell_hook_body)" zshrc
}

install_browser() {
  brew install agent-browser >/dev/null
  npm install --global cloakbrowser >/dev/null
  cloakbrowser install >/dev/null
  browser_path=$(cloakbrowser info --quick --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).binary?.path||""))')
  test -n "$browser_path" || { printf 'CloakBrowser 未返回可执行文件路径。\n' >&2; return 1; }
  mkdir -p "$STATE_HOME/config/shell.d"
  printf 'export AGENT_BROWSER_EXECUTABLE_PATH=%q\nexport AGENT_BROWSER_NAMESPACE=my-agent-workstation\n' "$browser_path" > "$STATE_HOME/config/shell.d/browser.zsh"
  record_integrity browser "$STATE_HOME/config/shell.d/browser.zsh" || return
  rebuild_shell_init || return
  ensure_shell_hook
}

append_managed_block() {
  target=$1 body=$2 backup=$3
  owner="fragment-$backup"
  mkdir -p "$(dirname "$target")"
  touch "$target"
  if grep -Fq "$MANAGED_MARKER" "$target"; then
    owns_component "$owner" || { printf '已有非本安装拥有的管理块: %s\n' "$target" >&2; return 1; }
    managed_block_is "$target" "$body" && return 0
    remove_managed_block "$target" || return
  else
    backup_once "$target" "$backup"
    own_component "$owner"
  fi
  {
    printf '\n%s\n' "$MANAGED_MARKER"
    printf '%s\n' "$body"
    printf '%s\n' "$MANAGED_END"
  } >> "$target"
}

install_terminal() {
  brew install starship fastfetch zsh-autosuggestions zsh-syntax-highlighting >/dev/null
  brew install --cask ghostty font-maple-mono-nf >/dev/null
  mkdir -p "$STATE_HOME/config/fastfetch"
  cp "$ROOT/resources/components/terminal/ghostty.conf" "$STATE_HOME/config/ghostty.conf"
  cp "$ROOT/resources/components/terminal/starship.toml" "$STATE_HOME/config/starship.toml"
  cp "$ROOT/resources/components/terminal/fastfetch/logo.txt" "$STATE_HOME/config/fastfetch/logo.txt"
  awk -v logo="$STATE_HOME/config/fastfetch/logo.txt" '{ gsub(/@FASTFETCH_LOGO_PATH@/, logo); print }' \
    "$ROOT/resources/components/terminal/fastfetch/config.jsonc" > "$STATE_HOME/config/fastfetch/config.jsonc"
  prefix=$(brew --prefix)
  awk -v prefix="$prefix" '{ gsub(/@HOMEBREW_PREFIX@/, prefix); print }' \
    "$ROOT/resources/components/terminal/zsh-plugins.zsh" > "$STATE_HOME/config/zsh-plugins.zsh"
  mkdir -p "$STATE_HOME/config/shell.d"
  {
    printf 'if [[ -o interactive ]]; then\n'
    printf '  fastfetch --config %q\n' "$STATE_HOME/config/fastfetch/config.jsonc"
    printf '  export STARSHIP_CONFIG=%q\n' "$STATE_HOME/config/starship.toml"
    # shellcheck disable=SC2016 # Write the expansion into the generated Zsh file.
    printf '  eval "$(starship init zsh)"\n'
    printf '  source %q\n' "$STATE_HOME/config/zsh-plugins.zsh"
    printf 'fi\n'
  } > "$STATE_HOME/config/shell.d/terminal.zsh"
  record_integrity terminal \
    "$STATE_HOME/config/ghostty.conf" \
    "$STATE_HOME/config/starship.toml" \
    "$STATE_HOME/config/fastfetch/logo.txt" \
    "$STATE_HOME/config/fastfetch/config.jsonc" \
    "$STATE_HOME/config/zsh-plugins.zsh" \
    "$STATE_HOME/config/shell.d/terminal.zsh" || return
  rebuild_shell_init || return
  append_managed_block "$XDG_CONFIG_HOME/ghostty/config" "config-file = \"$STATE_HOME/config/ghostty.conf\"" ghostty.config
  ensure_shell_hook
}

sync_runtime() {
  temporary="$RUNTIME_HOME.tmp.$$"
  rm -rf "$temporary"
  mkdir -p "$temporary"
  cp "$ROOT/setup" "$temporary/setup"
  cp -R "$ROOT/lib" "$temporary/lib"
  cp -R "$ROOT/scripts" "$temporary/scripts"
  cp -R "$ROOT/resources" "$temporary/resources"
  cp -R "$ROOT/packages" "$temporary/packages"
  rm -rf "$temporary/packages/better-computer-use/node_modules"
  rm -rf "$RUNTIME_HOME"
  mv "$temporary" "$RUNTIME_HOME"
  chmod +x "$RUNTIME_HOME/setup"
}

install_helium() {
  brew install --cask helium-browser >/dev/null
}

workstation_run_action() {
  case "$1" in
    install_workstation_package) install_workstation_package ;;
    configure_pi) configure_pi ;;
    replace_system) replace_system ;;
    install_bcu) install_bcu ;;
    install_browser) install_browser ;;
    install_terminal) install_terminal ;;
    install_helium) install_helium ;;
    sync_runtime) sync_runtime ;;
    *) return 64 ;;
  esac
}

remove_managed_block() {
  target=$1
  test -f "$target" || return 0
  temporary="$target.tmp.$$"
  awk -v start="$MANAGED_MARKER" -v finish="$MANAGED_END" '
    $0 == start { managed=1; next }
    $0 == finish { managed=0; next }
    !managed { print }
  ' "$target" > "$temporary"
  mv "$temporary" "$target"
}

workstation_uninstall() {
  mkdir -p "$STATE_HOME"
  if test -d "$PACKAGE_HOME"; then
    pi remove "$PACKAGE_HOME" >/dev/null 2>&1 || return
    rm -rf "$PACKAGE_HOME" || return
  fi
  if owns_component integration; then
    herdr integration uninstall pi >/dev/null 2>&1 || return
    rm -f "$OWNERSHIP_HOME/integration"
  fi
  label=dev.myagentworkstation.herdr
  plist="$HOME/Library/LaunchAgents/$label.plist"
  if owns_component herdr-service; then
    launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
    restore_owned_file "$plist" herdr.plist herdr-service
  fi
  if owns_component fragment-ghostty.config; then
    remove_managed_block "$XDG_CONFIG_HOME/ghostty/config" || return
    retire_backup ghostty.config || return
  fi
  if owns_component fragment-zshrc; then
    remove_managed_block "$HOME/.zshrc" || return
    retire_backup zshrc || return
  fi
  if owns_component system && test "$KEEP_SYSTEM" -eq 1; then
    detach_system || return
  else
    restore_owned_file "$PI_AGENT_HOME/SYSTEM.md" SYSTEM.md system || return
  fi
  restore_pi_configuration || return
  restore_owned_file "$PI_AGENT_HOME/bark-key" bark-key bark || return
  if owns_component bcu; then
    npm uninstall --global better-computer-use >/dev/null 2>&1 || return
    rm -f "$OWNERSHIP_HOME/bcu"
  fi
  rm -rf "$PACKAGE_HOME" "$STATE_HOME/config" "$RUNTIME_HOME" "$INTEGRITY_HOME" "$OWNERSHIP_HOME" "$STATE_HOME/pi-managed.json" "$STATE_HOME/system-installed.md" "$STATE_HOME/herdr-official"
  printf '{"schema":1,"status":"uninstalled","backups":"%s"}\n' "$BACKUP_HOME" > "$STATE_HOME/state.json"
}

workstation_update_release() {
  test "${MYAW_SKIP_SELF_UPDATE:-0}" = 0 || return 1
  repository=${MYAW_REPOSITORY:-Suge8/my-agent-workstation}
  response=$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$repository/releases/latest" 2>/dev/null) || return 1
  tag=$(printf '%s' "$response" | awk 'match($0, /"tag_name"[[:space:]]*:[[:space:]]*"[^"]+"/) { value=substr($0,RSTART,RLENGTH); sub(/^.*"tag_name"[[:space:]]*:[[:space:]]*"/,"",value); sub(/"$/,"",value); print value; exit }')
  version=${tag#v}
  test -n "$version" && version_is_newer "$version" "$WORKSTATION_VERSION" || return 1
  work=$(mktemp -d "${TMPDIR:-/tmp}/my-agent-workstation-update.XXXXXX") || return 1
  archive="$work/source.tar.gz"
  if ! curl -fsSL "https://github.com/$repository/archive/refs/tags/$tag.tar.gz" -o "$archive" || ! tar -xzf "$archive" -C "$work"; then
    rm -rf "$work"
    return 1
  fi
  updated=$(find "$work" -mindepth 1 -maxdepth 1 -type d -name 'my-agent-workstation-*' -print -quit)
  test -x "$updated/setup" || { rm -rf "$work"; return 1; }
  MYAW_SKIP_SELF_UPDATE=1 "$updated/setup" update "${UPDATE_FORWARD_ARGS[@]}"
  result=$?
  rm -rf "$work"
  return "$result"
}

workstation_configure_search() {
  command -v security >/dev/null 2>&1 || { printf '仅支持 macOS 钥匙串。\n' >&2; return 1; }
  printf 'Brave API Key（留空跳过）: '
  stty -echo 2>/dev/null || true; IFS= read -r brave; stty echo 2>/dev/null || true; printf '\n'
  if test -n "$brave"; then security add-generic-password -U -a "${USER:-user}" -s my-agent-workstation.brave -w "$brave" >/dev/null; fi
  unset brave
  printf 'Exa API Key（留空跳过）: '
  stty -echo 2>/dev/null || true; IFS= read -r exa; stty echo 2>/dev/null || true; printf '\n'
  if test -n "$exa"; then security add-generic-password -U -a "${USER:-user}" -s my-agent-workstation.exa -w "$exa" >/dev/null; fi
  unset exa
  printf 'Bark 地址（留空关闭）: '
  stty -echo 2>/dev/null || true; IFS= read -r bark; stty echo 2>/dev/null || true; printf '\n'
  if test -n "$bark"; then
    case "$bark" in https://api.day.app/*/) ;; *) printf 'Bark 地址格式无效。\n' >&2; unset bark; return 1 ;; esac
    mkdir -p "$PI_AGENT_HOME"
    backup_once "$PI_AGENT_HOME/bark-key" bark-key
    own_component bark
    printf '%s\n' "$bark" > "$PI_AGENT_HOME/bark-key"
    chmod 600 "$PI_AGENT_HOME/bark-key"
  fi
  unset bark
  if test -d "$PACKAGE_HOME"; then configure_pi; fi
  printf 'Context7 使用自身 OAuth；需要时运行 npx ctx7 login。\n'
}

ask_yes() {
  printf '%s [y/N] ' "$1"
  IFS= read -r answer || answer=
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

workstation_wizard() {
  printf '%s\n' 'My Agent Workstation：Pi 是 Agent 宿主，Herdr 管理终端工作区，FireCode 与 Skills 提供完整工作流。'
  printf '%s\n' '1) 完整同款（推荐）  2) 核心安装  3) 自定义'
  printf '请选择 [1]: '
  IFS= read -r choice || choice=1
  case "${choice:-1}" in
    1) MODE=full ;;
    2) MODE=core ;;
    3)
      MODE=custom
      ask_yes '安装 BCU 桌面控制？' && WITH_BCU=1
      ask_yes '安装隔离浏览器自动化？' && WITH_BROWSER=1
      ask_yes '安装 Ghostty 与终端美化？' && WITH_TERMINAL=1
      if test "$WITH_TERMINAL" -eq 1; then ask_yes '安装 Helium 日常浏览器？' && WITH_HELIUM=1; fi
      ask_yes '配置搜索凭据？' && WITH_SEARCH=1
      ;;
    *) printf '无效选择。\n' >&2; return 64 ;;
  esac
  printf '模型选择 JSON 路径（留空则按现有认证自动启用并禁用不可用角色）: '
  IFS= read -r model_choices || model_choices=
  if test -n "$model_choices"; then
    test -f "$model_choices" || { printf '文件不存在: %s\n' "$model_choices" >&2; return 64; }
    SELECTIONS=$model_choices
  fi
  if ask_yes '完整替换 Pi SYSTEM 提示词？原文件会备份。'; then REPLACE_SYSTEM=1; else KEEP_SYSTEM=1; fi
}
