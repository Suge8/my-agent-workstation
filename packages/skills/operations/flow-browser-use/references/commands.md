# Flow Browser 命令速查

所有命令用 wrapper：`./bin/flow-browser <command>`（或 skill 内绝对路径）。
命令随 agent-browser 版本变化，报错或参数不确定时读 `agent-browser skills get core --full`。

## 目录

- [诊断 / 启动](#诊断--启动)
- [打开 / Tab](#打开--tab)
- [读页面](#读页面)
- [报错 / 请求](#报错--请求)
- [操作](#操作)
- [语义定位](#语义定位)
- [坐标 fallback](#坐标-fallback)
- [等待](#等待)
- [局部读取](#局部读取)
- [开发专项](#开发专项)
- [React 调试](#react-调试)
- [高性能 batch](#高性能-batch)

## 诊断 / 启动

默认启动无头专属 CloakBrowser（1440x900）；已有 `9333` CDP 时直接复用，不切换模式。

```bash
./bin/flow-browser doctor          # 只读检查，不启动浏览器
./bin/flow-browser doctor --start  # 显式启动后检查
FLOW_BROWSER_HEADED=1 ./bin/flow-browser-start  # 存登录态到专属 profile / 反爬需真窗口 / 用户要在 agent 会话里看（见 SKILL.md 选择浏览器）
```

## 打开 / Tab

```bash
./bin/flow-browser tab
./bin/flow-browser tab new http://localhost:3000
./bin/flow-browser open http://localhost:3000
./bin/flow-browser reload
./bin/flow-browser back
./bin/flow-browser forward
```

## 读页面

```bash
./bin/flow-browser snapshot -i -c
./bin/flow-browser snapshot -c
./bin/flow-browser snapshot -s "#main" -i -c
./bin/flow-browser screenshot --annotate
```

## 报错 / 请求

`errors` / `console` 在 CloakBrowser 上永远为空（反检测补丁抑制事件），取 console 用 `flow-browser-console`；详见 SKILL.md “Console 与缓冲”。

```bash
./bin/flow-browser-console                    # 第一个非内部 tab，含历史重放
./bin/flow-browser-console <url子串> --wait 5  # 指定 tab，收集窗口 5s
./bin/flow-browser network requests
./bin/flow-browser network requests --type xhr,fetch
./bin/flow-browser network requests --status 400-499
./bin/flow-browser network requests --status 500-599
./bin/flow-browser network requests --filter api
```

## 操作

```bash
./bin/flow-browser click @e2
./bin/flow-browser dblclick @e2
./bin/flow-browser fill @e3 "hello"
./bin/flow-browser type @e3 "hello"
./bin/flow-browser keyboard type "hello"
./bin/flow-browser press Enter
./bin/flow-browser focus @e3
./bin/flow-browser select @e4 "value"
./bin/flow-browser check @e5
./bin/flow-browser hover @e6
./bin/flow-browser drag @e7 @e8
./bin/flow-browser upload @e9 ./file.png
./bin/flow-browser download @e10 ./downloaded.zip
./bin/flow-browser scroll down 400
./bin/flow-browser scrollintoview @e8
```

## 语义定位

ref 不够时用：

```bash
./bin/flow-browser find role button click --name "Submit"
./bin/flow-browser find label "Email" fill "test@example.com"
./bin/flow-browser find text "Sign In" click
```

## 坐标 fallback

语义 ref 失效、canvas/shadow/复杂 iframe 难以定位时，先截图标注和读取盒模型，再用 mouse 坐标兜底；必要时参考 raw CDP 的 target/frame 思路手动拆解。

```bash
./bin/flow-browser screenshot --annotate
./bin/flow-browser get box @e5
./bin/flow-browser mouse move 100 200
./bin/flow-browser mouse down left
./bin/flow-browser mouse up left
```

## 等待

```bash
./bin/flow-browser wait --load networkidle
./bin/flow-browser wait --text "Welcome"
./bin/flow-browser wait --url "**/dashboard"
./bin/flow-browser wait "#app"
./bin/flow-browser wait --fn "window.__READY__ === true"
```

## 局部读取

```bash
./bin/flow-browser get url
./bin/flow-browser get title
./bin/flow-browser get text @e1
./bin/flow-browser get html @e1
./bin/flow-browser get value @e3
./bin/flow-browser get attr @e4 href
./bin/flow-browser get count ".item"
./bin/flow-browser get box @e5
./bin/flow-browser get styles @e5
./bin/flow-browser is visible @e2
./bin/flow-browser is enabled @e2
./bin/flow-browser is checked @e2
```

## 开发专项

```bash
./bin/flow-browser set viewport 1440 900
./bin/flow-browser set media dark
./bin/flow-browser set offline on
./bin/flow-browser pushstate /dashboard
./bin/flow-browser vitals http://localhost:3000 --json
./bin/flow-browser diff snapshot
./bin/flow-browser diff screenshot --baseline
./bin/flow-browser trace start
./bin/flow-browser trace stop ./trace.json
./bin/flow-browser profiler start
./bin/flow-browser profiler stop ./profile.cpuprofile
./bin/flow-browser inspect
./bin/flow-browser highlight @e2
./bin/flow-browser clipboard read
```

## React 调试

需要组件树/重渲染证据时才启用：

```bash
./bin/flow-browser open --enable react-devtools http://localhost:3000
./bin/flow-browser react tree
./bin/flow-browser react renders start
./bin/flow-browser react renders stop --json
```

## 高性能 batch

优先把无依赖查询合并成一次调用；依赖 `@eN` ref 的步骤不要提前 batch。

```bash
./bin/flow-browser batch "snapshot -i -c" "errors" "network requests --type xhr,fetch"
./bin/flow-browser batch "open http://localhost:3000" "wait --load networkidle" "snapshot -i -c" "errors"
```
