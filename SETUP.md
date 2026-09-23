# 配置这台机器

你是读者的 coding agent。`config/` 下是作者机器上真实在用的文件，不是模板；你的工作是把它们落到系统标准位置，并装上作者用的那几个包。

环境要求：Apple Silicon、macOS 14+、Homebrew、Node 20.6+。`<repo>` 指本仓库根目录的绝对路径。

## 落地规则

1. **复制**——配置文件复制到系统标准位置，落点即真身。
2. **合并**——JSON 目标已存在时并入我们的键，冲突以我们的值为准，读者自己的键原样保留。
3. **留底**——改动读者已有文件前，原地复制一份加 `.bak` 后缀。

## 人工关口

只能读者本人做的事，到达时停下、给出明确指令、等确认再继续：Pi `/login`（步骤 3）；`bcu setup` 与系统设置授权（步骤 6）；填写 TinyFish key 与 Bark 地址（步骤 8）；在隔离浏览器里登录站点（步骤 7 之后按需）。

## 步骤 1：Pi 与 Herdr

```bash
npm install --global --ignore-scripts @earendil-works/pi-coding-agent@latest
curl -fsSL https://herdr.dev/install.sh -o /tmp/herdr-install.sh && /bin/sh /tmp/herdr-install.sh
export PATH="$HOME/.local/bin:$PATH"
herdr channel set stable
herdr integration install pi
herdr plugin install -y smarzban/herdr-file-viewer
```

`config/herdr/config.toml` 复制到 `~/.config/herdr/config.toml`。侧边栏那行会话名由 pi 集成上报，`prefix+f` 的文件浏览器来自上面的插件，两者缺一对应内容就消失。

**完成标准**：`pi --version` 与 `herdr --version` 各自打印版本号；`herdr config check` 输出 `ok`。

## 步骤 2：Pi 配置

`config/pi/` 逐个落到 `~/.pi/agent/`：

| 文件 | 落点 | 方式 |
| --- | --- | --- |
| `settings.json` | `~/.pi/agent/settings.json` | 合并 |
| `keybindings.json` | `~/.pi/agent/keybindings.json` | 合并 |
| `models.json` | `~/.pi/agent/models.json` | 合并 |
| `SYSTEM.md` | `~/.pi/agent/SYSTEM.md` | 整体替换 |
| `themes/midnight-rose.json` | `~/.pi/agent/themes/midnight-rose.json` | 复制 |
| `firecode.jsonc` | `~/.pi/agent/extensions/firecode/config.jsonc` | 整体写入 |

转达读者：SYSTEM.md 会把 agent 的语气、验证纪律、改动前对齐习惯换成作者那套，想保留自己的风格就跳过。

`keybindings.json` 里 `tui.input.tab` 是空数组，意图是腾出 Tab 给 thinking 切换，别当无效项删。

**完成标准**：六个文件就位。模型字段留到步骤 4 校正。

## 步骤 3：Skills、Pi 扩展与登录（人工关口）

Skills 落在所有 agent 共用的 `~/.agents/skills`，Pi 自动从这里读；architecture-wiki 的 skill 随它自己的仓库发布，clone 后 symlink 进来：

```bash
git clone https://github.com/Suge8/skills ~/.agents/skills
git clone https://github.com/Suge8/architecture-wiki ~/Project/architecture-wiki
ln -s ~/Project/architecture-wiki/skills/architecture-wiki ~/.agents/skills/development/architecture-wiki
```

Pi 扩展：

```bash
pi install git:github.com/Suge8/firecode
```

然后让读者启动 `pi` 执行 `/login`，至少完成一个供应商；作者用到 `openai-codex`、`anthropic`、`xai`、`deepseek`、`kimi-coding`。web-search 的默认搜索用 `anthropic` 与 `openai-codex` 的登录，登了哪家就只搜哪家。

**完成标准**：`pi list` 列出 firecode；`pi --list-models` 至少一个模型；`ls ~/.agents/skills/development/architecture-wiki/SKILL.md` 存在。

## 步骤 4：校正模型

`pi --list-models` 的输出是唯一可选集。`settings.json` 的 `defaultProvider` / `defaultModel` / `enabledModels`（数组顺序即 shift+tab 循环顺序）和 `firecode.jsonc` 里所有 `"provider/model/thinking"` 原子，前两段都必须出现在这份输出里；读者没有的模型，按 `firecode.jsonc` 里各处注释描述的档次换成读者有的同档模型，思考档沿用。`master.roles` 的角色名固定，只换值。

`watcher` 每回合结束后额外调用一次模型，有开销；作者关着，读者接受后再开。

**完成标准**：重启 `pi` 状态栏出现 FireCode 行，`alt+1` 切到对应模型。配置形状错误 FireCode 启动时会报出，照提示修。

## 步骤 5：终端

```bash
brew install starship fastfetch zsh-autosuggestions zsh-syntax-highlighting
brew install --cask ghostty font-maple-mono-nf
```

| 文件 | 落点 |
| --- | --- |
| `config/ghostty/config` | `~/.config/ghostty/config` |
| `config/ghostty/cursor.frag` | `~/.config/ghostty/shaders/cursor.frag` |
| `config/starship.toml` | `~/.config/starship.toml` |
| `config/fastfetch/config.jsonc`、`logo.txt` | `~/.config/fastfetch/` |
| `config/zsh/workstation.zsh` | `~/.config/my-agent-workstation/workstation.zsh` |

Ghostty 的 `macos-option-as-alt = true` 是步骤 4 alt 预设键的前提；CJK 回退字体 OPPO Sans 缺失时 Ghostty 自动跳过。

向 `~/.zshrc` **末尾追加一行** `source ~/.config/my-agent-workstation/workstation.zsh`，必须在 `compinit` 之后。读者 `.zshrc` 里已有的 autosuggestions / starship / syntax-highlighting / fastfetch 加载语句删掉，避免重复加载。

**完成标准**：新开 Ghostty 窗口出现 fastfetch 与 starship 提示符，输入时有灰色补全建议，`echo $PI_CACHE_RETENTION` 输出 `long`。

## 步骤 6：桌面控制 BCU（人工关口）

```bash
npm install --global github:Suge8/better-computer-use
ln -s "$(npm root -g)/better-computer-use/skills/better-computer-use" ~/.agents/skills/operations/better-computer-use
```

第一条装 `bcu` 命令，第二条把同一份包里的 skill 接进共用目录。helper app 在首次运行命令时自动安装。然后转达读者：终端运行 `bcu setup`，在「系统设置 → 隐私与安全性」给 `bcu.app` 勾选**辅助功能**和**屏幕录制**，回终端按回车完成校验。

**完成标准**：`bcu doctor` 裸退出码为 0。

## 步骤 7：浏览器自动化

```bash
brew install agent-browser
npm install --global cloakbrowser && cloakbrowser install
brew install --cask helium-browser
```

自动化只走隔离浏览器：默认 Chrome for Testing，需要登录态时用 cloakbrowser 加从 Helium 同步的 profile；从不动读者的日常浏览器。需要登录态的站点由读者在 Helium 里登录一次。路径由 skill 自己查找，不需要环境变量。

**完成标准**：`agent-browser --version` 与 `cloakbrowser info --quick` 均正常输出。

## 步骤 8：凭据（人工关口）

web-search 的 `--quick` 与 `fetch` 走 TinyFish，密钥写进 `~/.config/my-agent-workstation/env.zsh`（`chmod 600`，步骤 5 的片段会 source 它）：

```zsh
export TINYFISH_API_KEY='<tinyfish-key>'
```

密钥只进新开的 shell：已开的 Herdr 窗格和其中的 pi 拿不到，新开窗格再启动 pi。

Bark 推送地址写入 `~/.pi/agent/bark-key` 并 `chmod 600`，格式 `https://api.day.app/<key>/`（结尾带斜杠）。不用 Bark 就跳过，FireCode 检测不到文件即停用。

**完成标准**：新 shell 里 `echo $TINYFISH_API_KEY` 非空；`ls -l ~/.pi/agent/bark-key` 为 `-rw-------`。

## 落点清单

卸载时照这张表逐项核对再删。

| 装了什么 | 落点 | 对已有文件的改动 |
| --- | --- | --- |
| 全局 npm | `pi`、`cloakbrowser`、`better-computer-use`（来自 GitHub） | 新增 |
| Herdr | `command -v herdr`、`~/.config/herdr/`（配置、插件、会话状态）；`herdr integration install pi` 写入 Pi 配置目录 | 新增 |
| Skills | `~/.agents/skills`（clone）、`~/Project/architecture-wiki`（clone）、两个 symlink | 新增 |
| Pi package | `settings.json` 的 `packages`：firecode | 新增 |
| Pi 配置 | `~/.pi/agent/` 下 `settings.json`、`keybindings.json`、`models.json` | 合并 |
| Pi 配置 | `~/.pi/agent/SYSTEM.md`、`themes/midnight-rose.json`、`extensions/firecode/config.jsonc` | 整体写入，原件留底 |
| Bark | `~/.pi/agent/bark-key` | 新增 |
| 终端 | `~/.config/` 下 `ghostty/config`、`ghostty/shaders/cursor.frag`、`starship.toml`、`fastfetch/` | 整体写入 |
| zsh | `~/.config/my-agent-workstation/workstation.zsh`、`env.zsh` | 新增 |
| zsh 入口 | `~/.zshrc` | 末尾追加一行 source，原件留底 |
| Homebrew | ghostty、font-maple-mono-nf、helium-browser；starship、fastfetch、zsh-autosuggestions、zsh-syntax-highlighting、agent-browser | 新增 |
| BCU helper | `/Applications/bcu.app`（或 `~/Applications/bcu.app`）及两项授权 | 新增 |
| 隔离浏览器 | cloakbrowser 自管目录、`/Applications/Helium.app` | 新增 |
