# 搜索与通知凭据

Brave 用于精确和时效搜索，Exa 用于语义与代码检索，Context7 用于当前版本的官方库文档，Bark 只负责可选通知。四项独立启用；缺少 Bark 凭据时必须保持关闭。

`credentials.schema.json` 只记录启用状态与认证健康度，故意没有任何承载密钥、令牌或 Bark 地址的字段。安装器以不回显输入收集凭据：Brave 与 Exa 写入 macOS 钥匙串，Bark 写入 FireCode 使用的 `0600` 用户文件。不得把明文写入 Shell 配置、仓库、日志、备份或状态文件。

Context7 由 `npx ctx7 login` 发起 OAuth，并由 Context7 自己保存认证。诊断只报告 `missing`、`valid` 或 `invalid`；已有有效认证直接跳过配置，认证失效时只能重新配置或禁用，不能静默切换后端或报告成功。
