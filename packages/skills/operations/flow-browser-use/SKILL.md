---
name: flow-browser-use
description: 操作和调试已知网页：登录态、导航、点击、填写、DOM、截图、console 和 network；用户要预览 dev server 时使用有头浏览器。
allowed-tools: Bash(./bin/flow-browser:*), Bash(./bin/flow-browser-start:*), Bash(./bin/flow-browser-console:*), Bash(./bin/flow-browser-sync-profile:*), Bash(agent-browser:*)
---

# Flow Browser Use

`./bin/flow-browser` 控制专属 CloakBrowser（反检测 Chromium）：独立 profile `~/.flow-browser/profile`（登录态同步自用户 Helium）+ 独立端口 `9333`。**默认无头**——截图、snapshot、network、登录态全部可用（console 见下），不抢用户视口。绝不动用户的日常浏览器。

## 选择浏览器

| 场景 | 用 |
|---|---|
| 后台自动化 / 登录态 / 反爬 / 抓取（默认） | flow-browser（无头 CloakBrowser） |
| 用户要看：预览 dev server、亲眼看流程 | 纯预览用 `open <url>` 开在用户默认浏览器；需要 agent 登录态或人工解验证码用 `FLOW_BROWSER_HEADED=1` |
| 纯净隔离测试 / 完整未捕获异常排障 | `agent-browser --session <name>`（自带 Chromium） |
| 给专属 profile 存密码登录态 / 反爬必须真窗口 | `FLOW_BROWSER_HEADED=1`（有头 CloakBrowser） |

## 入口

```bash
bin/flow-browser-start   # 确保 CDP 可用；路径相对本 skill 目录
bin/flow-browser <cmd>   # wrapper，默认连 9333
```

- 有头需求按「选择浏览器」表路由；`FLOW_BROWSER_HEADED=1 … flow-browser-start` 的模式启动时定死，已有 9333 实例不切换；切模式先 `./bin/flow-browser stop` 再启动。
- 必须经 wrapper 或显式 `--cdp`；裸 `agent-browser open` 会绕过专属 profile。
- 用户说"已经打开/已登录"：先读现有 tabs，不要 `open` 导航当前页。以 `/json/list` 为事实源：

```bash
FLOW_BROWSER_SKIP_START=1 ./bin/flow-browser tab
curl -s http://127.0.0.1:9333/json/list
```

## 标准流

```txt
start → open/tab → snapshot -i → network/console 兑底检查 → action → wait → snapshot -i
```

- 优先 `snapshot -i`（只取交互元素，输出减半）；需要完整结构才全量 snapshot；视觉问题用 `screenshot`。
- 页面跳转后旧 `@eN` ref 失效，重新 snapshot。报错先查 `network requests`，console 见下节。

## Console 与缓冲

- CloakBrowser 反检测补丁抑制 `Runtime.consoleAPICalled/exceptionThrown`：`console` / `errors` 命令在专属实例上**永远为空**（network 不受影响）。取 console 用 `./bin/flow-browser-console [url子串] [--wait 秒]`——legacy Console domain 未被堵，attach 即重放该 tab 全部历史消息；未捕获异常捕获不到，需要完整异常时按「选择浏览器」表换实例。
- `console/network` 缓冲是实例级：并行 agent / 多 tab 会混入其他页面的请求，`network requests` 用 `--filter <url子串>` 收窄。

## 性能与并行

- 无依赖读取用 `batch` 一次合并（round-trip 是主要开销）；依赖新 `@eN` 的步骤不能提前 batch。
- 同一实例的命令共享 active-tab 状态：**不要并行发多条 flow-browser 命令**，会竞态。
- 真需要并行隔离浏览器：要登录态则 `FLOW_BROWSER_PORT=9334 FLOW_BROWSER_PROFILE=~/.flow-browser/profile-b`（先 sync-profile 到该路径）再 start；不要登录态直接 `agent-browser --session <name>`（自带隔离无头浏览器，不经 wrapper）。
- tab 卫生：多页面同窗 `tab new`；临时页用完 `tab close`；任务结束清理本次开的 tab。
- 生命周期：任务内保活（冷启动 2-3s，不要反复开关）；任务结束且浏览器是本次启动的 → `./bin/flow-browser stop`（只杀专属实例）；可能有其他 agent 在用就留着，最多一个实例，`doctor` 可见。

## 命令 / 诊断 / profile

- 命令速查 [references/commands.md](references/commands.md)；参数不确定读 `agent-browser skills get core --full`；系统性 QA 读 `skills get dogfood`；Electron 读 `skills get electron`。
- `./bin/flow-browser doctor`（只读，不启动）/ `doctor --start`（验证启动链）；输出 OK/WARN/FAIL，WARN 不是失败。
- 登录态过期：`./bin/flow-browser stop` 后 `./bin/flow-browser-sync-profile --force`，重新 start 生效。用户的日常 Helium **无需退出**（SQLite 在线快照 + Cookie 密钥转录）；首次同步会弹两次 Keychain 授权。密码（Login Data）不同步，需要密码的站点用 `FLOW_BROWSER_HEADED=1` 登录一次即持久保留。改源/目标用 `FLOW_BROWSER_SOURCE_PROFILE` / `FLOW_BROWSER_PROFILE`。

## 定位 fallback 与 CDP 逃生舱

- shadow/canvas/跨源 iframe 定位不稳：`screenshot --annotate` + `get box` 校准，再 mouse 坐标兜底。
- CLI 覆盖不了的场景直接走裸 CDP：`curl -s http://127.0.0.1:9333/json/list` 找 target，`./bin/flow-browser get cdp-url` 拿 ws 端点发原生 CDP 命令。

## 边界

- `eval` 只做只读读取（snapshot/get/console/network 不够时）；改状态用 `click/fill/type/press`。
- 不打印 cookies/token，不 dump 整个 DOM/storage。
- 不执行付款、删除、发消息、改密码、提交生产数据。
