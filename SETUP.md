# 配置这台机器

你是读者的 coding agent。这个仓库是**资产**，不是安装器：模型角色表、终端配置模板、Pi 插件与 Skills、桌面控制 CLI 源码。你的工作是把这些资产落到系统标准位置，并把读者的 Pi 配成作者那套工作站。

环境要求：Apple Silicon、macOS 14+、已安装 Homebrew、Node 20.6+（由 Homebrew 提供）。以下命令中 `<repo>` 指本仓库根目录的绝对路径。

## 三条落地规则

每一次写文件都遵守这三条，全文不再重复：

1. **复制**——配置文件复制到系统标准位置。落点即真身。
2. **合并**——目标已存在时并入我们的键，冲突处以我们的值为准，读者自己加的键原样保留。
3. **留底**——改动读者任何已有文件之前，先在原地把原件复制一份加 `.bak` 后缀（已存在 `.bak` 时改用带时间戳的后缀）。

## 人工关口

以下四件事只能由读者本人做，你在到达时停下、给出明确指令、等确认后再继续：Pi 里 `/login` 登录供应商（步骤 3）；`bcu setup` 与系统设置里的两项授权（步骤 8）；输入 Brave / Exa API Key、Bark 地址、Context7 OAuth（步骤 10）；在隔离浏览器里登录需要登录态的网站（步骤 9 之后按需）。

## 步骤 1：Pi 与 Herdr

```bash
npm install --global --ignore-scripts @earendil-works/pi-coding-agent@latest
curl -fsSL https://herdr.dev/install.sh -o /tmp/herdr-install.sh && /bin/sh /tmp/herdr-install.sh
herdr channel set stable
herdr integration install pi
```

Herdr 装在 `~/.local/bin/herdr`，该目录进 PATH 的动作留到步骤 7 统一写进 `workstation.zsh`；本步骤内先用绝对路径 `~/.local/bin/herdr` 调用。

**完成标准**：`pi --version` 与 `~/.local/bin/herdr --version` 各自打印版本号。

可选——让 `herdr server` 开机自启：在 `~/Library/LaunchAgents/` 下写一个 plist，`ProgramArguments` 为 herdr 绝对路径加 `server`，`RunAtLoad` 为 true，`StandardOutPath` / `StandardErrorPath` 指向 `~/.local/state/herdr/` 下的日志文件，然后 `launchctl bootstrap gui/$(id -u) <plist>`。完成标准：`launchctl print gui/$(id -u)/<label>` 显示 state = running。读者不要求开机自启时跳过本段。

## 步骤 2：安装 Pi package

仓库根 `package.json` 已声明 `pi.extensions` 与 `pi.skills`，因此仓库根目录本身就是一个可直接安装的 Pi package——FireCode 插件与全部 Skills（含中文架构 Wiki `packages/skills/development/architecture-wiki`）随之进入 Pi。

```bash
pi install <repo>
pi install npm:pi-antigravity
```

**完成标准**：`pi list` 的输出中同时出现 `firecode` 与 `pi-antigravity`。

## 步骤 3：登录供应商（人工关口）

告诉读者：启动 `pi`，执行 `/login`，至少完成一个供应商的认证；作者的样板用到 `openai-codex`、`anthropic`、`xai`、`deepseek`、`kimi-coding`、`antigravity`。

登录完成后运行 `pi --list-models`，这份输出是后续所有模型字段的唯一可选集——步骤 4、5 只能填出现在这里的 `provider/model`。

**完成标准**：`pi --list-models` 至少列出一个模型。

## 步骤 4：模型角色表

读者不需要配得和作者一模一样。按下表的**角色**，从 `pi --list-models` 里挑读者已登录的模型填进去；一个模型可以兼任多个角色。作者的实际取值分属两层，各管各的：`config/models.json` 是 Pi 层，给模型别名表、默认模型、shift+tab 循环顺序与 Pi 键位；`packages/firecode/config.example.jsonc` 是 FireCode 层，给 presets、review、master、watcher 的字段形状与 thinking 档。

| 角色 | 档次要求 | 用在哪 | 作者样板 |
| --- | --- | --- | --- |
| 主力实现 | 强推理、能长时间跑工具 | `defaultModel`、preset `alt+3` | gpt-5.6-sol |
| 快速轻量 | 低延迟、便宜 | preset `alt+4` | gemini-3.7-flash |
| 便宜并行调研 | 便宜、可大量并发 | preset `alt+5` | deepseek-v4-flash |
| 高级架构顾问 | 最强推理，慢也可以 | preset `alt+1`、review advisor | claude-fable-5 |
| 综合前端 | 强代码 + 强前端 | preset `alt+2` | claude-opus-5 |
| 视觉设计 | 长上下文、审美好 | preset `alt+6` | k3-256k |
| 另一高性能 | 与主力不同家的强模型 | preset `alt+7` | grok-4.6 |
| 每回合观察员 | 便宜、快 | watcher | gpt-5.6-sol |

表里的角色名只描述档次，落点是 `defaultModel`、presets、review advisor 与 watcher。FireCode 指挥官的子代理角色是另一组概念——名字固定为调研员、工程师、全栈、架构师、设计师、哨兵，在步骤 5 的 `master.roles` 里单独绑定，可以复用这里选出的同一批模型。

**观察员会产生额外开销**：watcher 在每个主会话回合结束后额外调用一次模型。把这句话原样转达读者，读者接受后再启用。

**完成标准**：你手上有一张表，八个角色各自对应一个来自 `pi --list-models` 的 `provider/model` 字符串。

## 步骤 5：写 Pi 配置

三个文件，全部按合并规则处理（`~/.pi/agent/keybindings.json` 里读者已有的其他键位保留）。

`~/.pi/agent/settings.json` 需要四项：`warnings.anthropicExtraUsage` = `false`；`defaultProvider` / `defaultModel` = 主力实现模型（作者取 `config/models.json` 的 `default` 别名）；`defaultThinkingLevel` = `"medium"`；`enabledModels` = 读者想要的 `provider/model` 列表，**数组顺序就是 shift+tab 的循环顺序**，作者的顺序见同文件 `cycle`。

`~/.pi/agent/keybindings.json` 并入 `config/models.json` 的 `keybindings` 段（六条绑定，原样照抄）。其中 `tui.input.tab` 是空数组，意图是腾出 Tab 给 thinking 切换，保留空值、别当无效项删掉。

`~/.pi/agent/extensions/firecode/config.jsonc`——**扩展名是 `.jsonc`，内容按纯 JSON 写**。权威 schema 是 `packages/firecode/config.example.jsonc`，**以它为基底复制过去再替换模型字段**：

```bash
mkdir -p ~/.pi/agent/extensions/firecode
cp <repo>/packages/firecode/config.example.jsonc ~/.pi/agent/extensions/firecode/config.jsonc
```

基底里 features 已全开、keys 与 `openai` 段直接可用，作者的立场是愿意用就用原样。三个 feature 有前置条件，读者未满足时置为 `false`：`claudeSub` 要求已登录 `anthropic`；`openaiNative` 要求已登录 `openai-codex` 或 `xai`；`bark` 基底里就是 `false`，步骤 10 配了 Bark 地址后才改为 `true`。

**陷阱：模型字段有三种写法。** `presets` 把 provider、model 和 thinking 档拆成 `provider`、`model`、`thinkingLevel` 三个独立字段；`review` 与 `watcher` 用两段式 `"provider/model"` 字符串，thinking 档在同级的 `thinking` 字段里；`master.roles` 用三段式 `"provider/model/thinking"` 字符串，thinking 档并在字符串结尾、没有独立字段。写混了 FireCode 认不出模型。

**陷阱：`master.roles` 是角色名到模型的映射。** 六个角色名是固定集合，照基底原样保留、只换每个值里的模型。每个值含三段式 `model` 与一句 `use`——`use` 是指挥官选角色的依据，照基底写法给出强项与代价；可选的 `fallback` 是至多两条备选模型的数组，写法与 `model` 相同。

替换范围就这些：`presets` 按步骤 4 的表绑定 `alt+1` 到 `alt+7`，别名自取、thinking 档沿用基底；`watcher` 换成步骤 4 的观察员模型；`master.roles` 六个角色逐个换成读者已登录的模型，含各自的 `fallback`；`review` 只改 advisor 与 reviewers，其余字段沿用基底值。

**完成标准**：下面这条命令裸退出码为 0（`config.jsonc` 去掉注释后按 JSON 校验）——

```bash
node -e 'const fs=require("fs");for(const f of process.argv.slice(1)){JSON.parse(fs.readFileSync(f,"utf8").replace(/^\s*\/\/.*$/gm,""));console.log("OK",f)}' \
  ~/.pi/agent/settings.json ~/.pi/agent/keybindings.json ~/.pi/agent/extensions/firecode/config.jsonc
```

再重启 `pi`：状态栏出现 FireCode 行，按 `alt+1` 后状态栏模型名切换到 alt+1 绑定的模型。

## 步骤 6：系统提示词

把 `packages/pi-config/SYSTEM.md` 复制到 `~/.pi/agent/SYSTEM.md`，**默认替换**（作者希望读者用同款）。替换前按留底规则保留原件。

转达读者：这会改变 agent 的行为风格——语气、验证纪律、改动前的对齐习惯都会变成作者那套。读者想保留自己的风格时跳过本步骤。

**完成标准**：`~/.pi/agent/SYSTEM.md` 与 `packages/pi-config/SYSTEM.md` 内容一致；若原文件存在，同目录下有其留底副本。

## 步骤 7：终端

```bash
brew install starship fastfetch zsh-autosuggestions zsh-syntax-highlighting
brew install --cask ghostty font-maple-mono-nf
```

模板在 `config/terminal/`，逐个复制到落点，**两处占位符必须替换成本机实际值**：

| 模板 | 落点 | 替换 |
| --- | --- | --- |
| `ghostty.conf` | `~/.config/ghostty/config` | — |
| `starship.toml` | `~/.config/starship.toml` | — |
| `fastfetch/config.jsonc` | `~/.config/fastfetch/config.jsonc` | `@FASTFETCH_LOGO_PATH@` → logo.txt 落点的绝对路径 |
| `fastfetch/logo.txt` | `~/.config/fastfetch/logo.txt` | — |
| `zsh-plugins.zsh` | `~/.config/my-agent-workstation/workstation.zsh` | `@HOMEBREW_PREFIX@` → `brew --prefix` 的输出 |

`ghostty.conf` 里 `macos-option-as-alt` 保持 `true`——步骤 5 配的 alt 预设键全靠它才能到达 Pi。其余细节读模板本身。

模板 `zsh-plugins.zsh` 只有两条插件 source。把下面这段**插到模板内容之前**，让 `workstation.zsh` 的最终顺序为「本段 → 两条插件 source」：

```zsh
export PATH="$HOME/.local/bin:$PATH"
export STARSHIP_CONFIG="$HOME/.config/starship.toml"
if [[ -o interactive ]]; then
  fastfetch
  eval "$(starship init zsh)"
fi
```

顺序是硬依赖：`zsh-syntax-highlighting` 要在所有 zle widget 定义之后 source 才生效，而 `starship init` 会定义 widget——所以 starship 在前、插件 source 在后。

然后向 `~/.zshrc` **末尾追加一行** `source ~/.config/my-agent-workstation/workstation.zsh`。`.zshrc` 只追加不合并，追加前留底。

**完成标准**：新开一个 Ghostty 窗口，fastfetch 打印带自定义 logo 的信息，提示符为 starship 样式，输入命令时出现灰色补全建议，`echo $PATH` 含 `~/.local/bin`。

## 步骤 8：桌面控制 BCU

```bash
cd <repo>/packages/better-computer-use
npm install --ignore-scripts && npm run build
npm install --global --ignore-scripts "./$(npm pack --silent)"
node "$(npm root -g)/better-computer-use/scripts/setup-helper.mjs" --runtime
```

`setup-helper.mjs` 必须从**全局安装后的包**里跑，它把原生 helper 装到 `/Applications/bcu.app`（无权限时落 `~/Applications/bcu.app`）。

人工关口——转达读者逐字执行：终端运行 `bcu setup`；打开「系统设置 → 隐私与安全性」，给 `bcu.app` 勾选**辅助功能**和**屏幕录制**两项；回终端按回车让 `bcu setup` 完成校验。

**完成标准**：`bcu doctor` 裸退出码为 0，且辅助功能与屏幕录制两项均报告已授权。

## 步骤 9：浏览器自动化

```bash
brew install agent-browser
npm install --global cloakbrowser && cloakbrowser install
brew install --cask helium-browser
```

策略是**隔离浏览器**：自动化只走 cloakbrowser，失败时报错而不是改用日常浏览器，也不迁移日常浏览器的 Cookie 和 Profile。读者需要登录态的站点，由读者本人在隔离浏览器里登录一次。

cloakbrowser 的二进制路径随版本变化，**现查不写死**——下面这条把实际值追到 `workstation.zsh` 末尾（在插件 source 之后，不影响步骤 7 的顺序约束）：

```bash
cloakbrowser info --quick --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  console.log(`export AGENT_BROWSER_EXECUTABLE_PATH="${JSON.parse(s).binary.path}"`);
  console.log(`export AGENT_BROWSER_NAMESPACE="my-agent-workstation"`);
})' >> ~/.config/my-agent-workstation/workstation.zsh
```

**完成标准**：新开 shell 后 `test -x "$AGENT_BROWSER_EXECUTABLE_PATH"` 退出码为 0。

## 步骤 10：凭据（人工关口）

密钥进 macOS 钥匙串，不落任何文件。让读者本人执行（key 由读者输入）：

```bash
security add-generic-password -U -a "$USER" -s my-agent-workstation.brave -w <brave-key>
security add-generic-password -U -a "$USER" -s my-agent-workstation.exa   -w <exa-key>
npx ctx7 login   # Context7，浏览器里完成 OAuth
```

Bark 推送地址写入 `~/.pi/agent/bark-key`，随后 `chmod 600` 该文件。格式必须匹配 `https://api.day.app/*/`（**结尾带斜杠**），并把步骤 5 的 `features.bark` 改为 `true`。

**完成标准**：`security find-generic-password -s my-agent-workstation.brave` 有输出；`ls -l ~/.pi/agent/bark-key` 显示 `-rw-------`。

## 落点清单

改动集中在下表。卸载时照这张表逐项人工核对再删——没有一键卸载。

| 装了什么 | 落点 | 对已有文件的改动 |
| --- | --- | --- |
| 全局 npm 包 | `pi`、`pi-antigravity` 源、`better-computer-use`、`cloakbrowser` | 新增 |
| Herdr | `~/.local/bin/herdr`；可选 `~/Library/LaunchAgents/<label>.plist` 与 `~/.local/state/herdr/*.log`；`herdr integration install pi` 写入 Pi 配置目录 | 新增 |
| Pi 扩展与 Skills | `~/.pi/agent/extensions/firecode`、`…/pi-antigravity`、Skills 注册项 | 新增 |
| Pi 设置 / 键位 | `~/.pi/agent/settings.json`、`keybindings.json` | 合并上述键，其余保留 |
| FireCode 配置 | `~/.pi/agent/extensions/firecode/config.jsonc` | 整体写入 |
| 系统提示词 | `~/.pi/agent/SYSTEM.md` | **整体替换**，原件留底 |
| Bark 地址 | `~/.pi/agent/bark-key`（0600） | 新增 |
| 终端配置 | `~/.config/` 下的 `ghostty/config`、`starship.toml`、`fastfetch/{config.jsonc,logo.txt}` | 整体写入 |
| zsh 装配 | `~/.config/my-agent-workstation/workstation.zsh` | 新增 |
| zsh 入口 | `~/.zshrc` | **末尾追加一行 source**，原件留底 |
| Homebrew 包 | ghostty、font-maple-mono-nf、helium-browser（cask）；starship、fastfetch、zsh-autosuggestions、zsh-syntax-highlighting、agent-browser | 新增 |
| BCU 原生 helper | `/Applications/bcu.app`（或 `~/Applications/bcu.app`） | 新增，另占用辅助功能/屏幕录制授权项 |
| 隔离浏览器 | cloakbrowser 自管的浏览器目录、`/Applications/Helium.app` | 新增 |
| 搜索凭据 | macOS 钥匙串 `my-agent-workstation.brave` / `.exa` | 新增 |
