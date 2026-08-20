# bcu CLI 使用手册

`bcu` 提供 13 个顶层命令；`browser` 下有 `launch`、`navigate`、`eval` 三个子命令。所有成功结果写入 stdout，日志、交互提示和错误写入 stderr。

## 基本流程

```text
observe-ui → search-ui / expand-ui / inspect-ui → act-ui
```

1. 已知唯一应用或窗口时直接 `observe-ui --app`；目标不确定、有多个窗口或需要临时根时先用 `find-roots` 获取 `@r`。
2. `observe-ui` 返回不可变的 `stateId` 和 `@e` 元素 ref。
3. 查询命令读取该状态，不重新截图。
4. `act-ui` 使用同一 `stateId`，并返回后继状态。

`@e` ref 只属于生成它的状态。收到 `stale_state` 后重新观察，不能把旧 ref 拼到新状态上。

## 输出

默认输出适合人和 agent 直接阅读：

```text
stateId 35d7…
<折叠后的界面 outline>
screenshot: ~/Library/Caches/bcu/shots/35d7….jpg (1200x800)
```

加 `--json` 后，stdout 只包含一个 JSON 对象：

```json
{
  "ok": true,
  "result": {
    "text": "…",
    "details": {},
    "screenshot": {
      "path": "~/Library/Caches/bcu/shots/35d7….jpg",
      "mimeType": "image/jpeg",
      "width": 1200,
      "height": 800
    }
  }
}
```

桌面观察和动作的 JSON 只保留后续调用需要的状态、目标、变化和执行证据；完整 outline 缓存在 Broker 中，不在 `details` 重复返回。可见 outline 位于 `result.text`，未展开内容用 `search-ui`、`expand-ui` 或 `inspect-ui` 查询。截图字节不会进入文本或 JSON 输出。macOS 截图目录权限为 `0700`，文件权限为 `0600`。

失败时进程返回非零退出码，stdout 为空，即使使用 `--json` 也不会输出假成功对象。stderr 固定为两行：

```text
error stale_state: State '…' is unavailable or was evicted.
recovery: Run observe-ui again and retry with the new stateId and refs.
```

错误码与恢复动作的唯一事实源是 [`src/errors.ts`](../src/errors.ts)。

## 根节点与观察

### `bcu find-roots`

```bash
bcu find-roots [--query TEXT] [--app NAME] [--bundle-id ID] [--pid PID]
               [--kind window|menu|sheet|popover|dialog|browser_page] [--json]
```

不带过滤条件时列出当前可见的桌面根节点和已连接的 CDP 页面。

### `bcu observe-ui`

```bash
bcu observe-ui [--root @r1] [--app NAME] [--window-title TITLE]
               [--mode semantic|visual|fused]
               [--image auto|always|never]
               [--read-text auto|always|never] [--json]
```

- 默认模式为 `fused`。
- `semantic` 默认不截图、不做 OCR，开销最低。
- `visual` 强制视觉文本证据。
- `--image always` 把截图写入文件并返回路径。
- 未指定目标时观察当前前台窗口。

## 缓存查询

这些命令读取 Broker 中的完整状态。普通查询不会重新观察窗口。

```bash
bcu search-ui --state ID [--text TEXT] [--role ROLE] [--action ACTION] [--limit N]
bcu expand-ui --state ID --ref @e7 [--depth N]
bcu inspect-ui --state ID --ref @e7 [--include-raw]
bcu read-text --state ID [--ref @e7] [--offset N] [--limit N]
```

桌面 `read-text` 需要 `--ref`。浏览器状态可以直接分页读取整页文本。

## 执行动作

`act-ui` 只从 stdin 读取 JSON 数组。末尾的 `-` 是必需参数，避免动作内容进入进程参数和 shell quoting。

```bash
printf '%s\n' '[{"action":"press","ref":"@e12"}]' |
  bcu act-ui --state ID -
```

可用选项：

```text
--headless
--image auto|always|never
--expect-text TEXT
--expect-role ROLE
--expect-value VALUE
--expect-gone
--timeout MILLISECONDS
```

`--headless` 禁止前台焦点和物理输入回退。能观察到完成条件时，把条件附在同一次操作中：

```bash
cat <<'JSON' | bcu act-ui --state ID --expect-text Saved --timeout 3000 -
[
  {"action":"setText","ref":"@e18","text":"hello"},
  {"action":"press","ref":"@e22"}
]
JSON
```

后继观察默认使用 `semantic + no-image`，不做 OCR。需要视觉取证时显式传 `--image always`。动作结果为 `didnt`、`unknown` 或后置条件失败时，CLI 返回 `action_failed`；调用方必须重新观察，不能把投递动作当作成功。

支持的 action：

| action | 主要字段 |
| --- | --- |
| `press`、`click`、`doubleClick` | `ref`，或 `x` + `y` |
| `setText` | `ref`、`text` |
| `typeText` | `ref` 或当前焦点、`text` |
| `keypress` | `ref` 或当前焦点、`keys` |
| `scroll` | `ref` 或坐标、`scrollX`、`scrollY` |
| `drag` | `path`，至少两个点 |
| `moveMouse` | `ref` 或坐标 |
| `wait` | `ms` |

stdin 是严格信任边界：未知字段、错误类型、非法枚举、越界数值和同时提供 ref/坐标都会返回 `invalid_arguments`。仅字段缺省时应用默认值：`button=left`、`clickCount=1`、滚动量为 `0`、`wait.ms=1000`；`button:"banana"` 或 `ms:"soon"` 不会被静默转换。

批量动作按顺序在同一资源上执行。只有后一步不依赖中间观察时才放进同一数组。

## 等待界面状态

```bash
bcu wait-for --state ID (--text TEXT | --role ROLE) [--gone] [--timeout MS]
```

`wait-for` 在一次有超时边界的调用中完成等待。条件未满足时返回 `action_timeout` 和非零退出码，不会返回 `ok:true`。调用方不需要在 shell 中轮询或 `sleep`。

## 浏览器

启动受管浏览器：

```bash
bcu browser launch [--browser helium|chrome] [--url URL] [--port PORT]
```

观察返回的 `@r` 页面后，可以导航或执行 JavaScript：

```bash
bcu browser navigate --state ID --url https://example.com
bcu browser eval --state ID --expression 'document.title'
```

页面观察、查询、动作和桌面窗口共用同一套 `stateId`、`@r`、`@e` 语义。

## Broker 与权限

```bash
bcu status [--json]
bcu doctor [--json]
bcu setup [--json]
bcu stop [--json]
```

- `status` 不启动 Broker。
- `doctor` 按需启动 Broker，并检查 helper、协议、权限和配置。
- `setup` 在 macOS 注册 TCC 项，等待用户打开两个开关，重启 helper 后复查权限。非交互终端返回 `permission_missing`。
- `stop` 在 Broker 未运行时直接成功，不会先启动一个新进程。

普通业务命令自带 connect-or-start。不要先执行 `status` 再决定是否启动，这会增加调用并产生检查后状态改变的竞态。

## 并发语义

缓存查询可并行执行。不同桌面进程或 CDP 页面可以并行；同一物理资源上的实时操作按顺序执行。两个 agent 从同一状态并发写入时，只有一个操作成功，另一个收到 `stale_state`。
