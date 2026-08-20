# statusbar：底部两行

第一行位置/会话名/指挥官徽标（扩展状态 `master` 键，窄屏整段丢弃），第二行模型/额度/上下文/缓存/速度。

`render.ts` 与 `layout` 相关函数是纯函数，测试覆盖在 `tests/layout.test.ts`。

## 额度

🔋 显示订阅额度余量，支持 openai-codex、anthropic、xai（后两者需 OAuth 登录，xai 读 `~/.grok/auth.json`
里官方 CLI 的登录态）。抓取由会话启动、切换模型、每轮结束触发，没有定时轮询。结果与失败退避写在
`~/.pi/agent/tmp/firecode-quota-<provider>.json`，同时开多个 pi 会话时共享同一次请求；连续失败按
1 → 2 → 5 分钟退避。
