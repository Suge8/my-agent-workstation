# bcu 命令速查

命令集合取自 `bcu --help`。该帮助把完整参数指向 `docs/usage.md`；下表已与 `src/cli.ts` 参数解析器逐项核对。所有命令都接受全局 `--json`；`-h, --help` 显示总览。

## 桌面与状态

```text
bcu find-roots
  [--query TEXT] [--app NAME] [--bundle-id ID] [--pid PID]
  [--kind window|menu|sheet|popover|dialog|browser_page]

bcu observe-ui
  [--root @rN] [--app NAME] [--window-title TITLE]
  [--mode semantic|visual|fused]
  [--image auto|always|never] [--read-text auto|always|never]

bcu search-ui --state ID
  [--text TEXT] [--role ROLE] [--action ACTION] [--limit N]

bcu expand-ui --state ID --ref @eN [--depth N]

bcu inspect-ui --state ID --ref @eN [--include-raw]

bcu read-text --state ID
  [--ref @eN] [--offset N] [--limit N]

bcu wait-for --state ID (--text TEXT | --role ROLE)
  [--gone] [--timeout MILLISECONDS]
```

桌面 `read-text` 需要 `--ref`；浏览器状态可直接读取整页文本。`wait-for` 未找到条件时返回 `action_timeout`。

## 动作

`act-ui` 必须从 stdin 读取 JSON 数组，末尾 `-` 必填：

```text
bcu act-ui --state ID
  [--headless] [--image auto|always|never]
  [--expect-text TEXT] [--expect-role ROLE] [--expect-value VALUE]
  [--expect-gone] [--timeout MILLISECONDS] -
```

`--expect-gone` 和 `--timeout` 需要至少一个 `--expect-*`。动作字段：

| action | 字段 |
|---|---|
| `press`, `click` | `ref` 或 `x`+`y`; 可选 `button`, `clickCount` |
| `doubleClick` | `ref` 或 `x`+`y`; 可选 `button` |
| `setText` | `ref` 或 `x`+`y`; `text` |
| `typeText` | 可选 `ref` 或 `x`+`y`; `text` |
| `keypress` | 可选 `ref` 或 `x`+`y`; `keys` 字符串数组 |
| `scroll` | `ref` 或 `x`+`y`; 可选 `scrollX`, `scrollY` |
| `drag` | 可选 `ref` 或 `x`+`y`; `path` 至少两个 `{x,y}` 或 `[x,y]` 点 |
| `moveMouse` | `ref` 或 `x`+`y` |
| `wait` | `ms`，0 到 60000 |

同一动作不能同时提供 `ref` 和坐标。`button` 为 `left|right|middle`；`clickCount` 为 1 到 3；滚动量范围为 -10000 到 10000。默认值：`button=left`、`clickCount=1`、滚动量 `0`、`wait.ms=1000`。

示例：

```bash
cat <<'JSON' | bcu act-ui --state ID --expect-text Saved --timeout 3000 --json -
[
  {"action":"setText","ref":"@e18","text":"hello"},
  {"action":"press","ref":"@e22"}
]
JSON
```

## 浏览器

```text
bcu browser launch
  [--browser helium|chrome] [--url URL] [--port PORT]

bcu browser navigate --state ID --url URL
  [--image auto|always|never]

bcu browser eval --state ID --expression JAVASCRIPT
```

`launch` 返回页面根；随后用 `observe-ui` 取得页面状态。

## 诊断与权限

```text
bcu status
bcu doctor
bcu setup
bcu stop
```

这四条命令除全局 `--json` 外没有参数。普通业务命令会自行连接或启动 Broker，不需要先执行服务管理命令。`setup` 在 macOS 需要交互式终端。
