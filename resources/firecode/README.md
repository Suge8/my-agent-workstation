# FireCode 配置

发行快照只提供公开模板 `config.example.jsonc`，模板不参与运行。Workstation 安装器根据 Pi 已认证且当前可用的模型生成 Pi Agent 目录下的 `extensions/firecode/config.jsonc`；后续配置会保留用户自定义预设和无关字段。

常用入口：

- `features`：独立启用界面、工具和模型能力。
- `keys`：设置重命名、轮换预设和 Fast 模式快捷键；重启 Pi 后生效。
- `openai`：设置原生压缩、回答简洁度和 OpenAI/xAI 加速档。
- `presets`：定义模型、思考等级、工具、指令和可选快捷键。
- `master.models`：定义 `/fire-master` 可派发的模型及适用场景。
- `review`：定义 `/fire-review` 的顾问、审查者、轮数、超时和只读工具。

模型应通过维护的[模型档案](../models/README.md)选择，不要把私人代理地址、凭据或未认证模型写入公开模板。配置字段错误会阻止对应能力启动，不会静默回退。
