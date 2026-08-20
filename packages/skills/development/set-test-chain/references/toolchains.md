# 各平台标准验证链速查

判断项目验证链是否达标、不达标时往哪迁移。现有项目沿用已配置工具；下表是接入方式，不是自动安装或迁移清单。

| 平台 | 标准工具链 | 关键点 |
|---|---|---|
| Tauri 2 | `@wdio/tauri-service`（embedded driver 模式） | 官方推荐；macOS 靠内嵌 WebDriver 支持（tauri-driver 不支持 macOS）；`browser.tauri.execute()` 直达后端、IPC mock、前后端日志捕获。纯前端逻辑用它的 browser mode（Vite dev server + 拦截 invoke），不用起 Tauri 二进制 |
| Electron | Playwright `_electron.launch()` | 官方实验性但成熟可用；能拿 BrowserWindow、主进程 console、IPC |
| 浏览器扩展 | Playwright `launchPersistentContext` + `--load-extension` | headless: 'new' 模式可加载扩展；能进 service worker / popup / content script 三个上下文 |
| Web 前端 | flow-browser-use（日常操作与调试）；Playwright（回归套件） | flow-browser-use 已有登录态快照，单次验证优先用它 |
| CLI 工具 | 直接调用 + 输出断言；golden file diff；bats | 固定 seed/时间，输出与 known-good 快照 diff |
| API / 服务 | curl/httpie + 响应断言；supertest/内存启动 | 断言状态码 + 响应体关键字段，不是"200 就算过" |
| npm/crate 库 | 单测 + `pack` 后在临时目录真实 install 冒烟 | 防止 exports/files 字段错误这种测试测不到的发布事故 |
| macOS 原生 app | XCUITest；accessibility API 驱动 | 无测试链时用 better-computer-use 做取证兜底：accessibility 结构化读控件 + 操作 + 截图，比 AppleScript 盲坐标可靠；但它操作真实桌面，只算兜底不算达标链 |

## 已配置静态门的接入

使用项目 scripts 和配置中的准确命令。没有配置就跳过；普通测试任务不安装工具。用户明确要求从零建立静态门时，才把下表作为最小起点，并先确认新增开发依赖。

| 生态 | Formatter check | Lint / 静态检查 | 边界 |
|---|---|---|---|
| TS / JS | 已有 Oxfmt `oxfmt --check`，或 Biome `biome format` / `biome check` 的 check 模式 | 已有 Oxlint、Biome 或 ESLint | 选项目已有的一套，不为统一而并装或迁移 |
| Python | `ruff format --check .` | `ruff check .`；类型检查沿用已有 mypy/pyright | Ruff 可同时承担格式化和 lint，不代替类型检查 |
| Rust | `cargo fmt --all -- --check` | 沿用项目的 `cargo clippy` 参数和 lint level | 不擅自加 `--all-features` 或 `-D warnings` 改变现有支持面 |
| JSON / CSS | 接入前端已选的 Biome/Oxfmt check | Biome 已配置时接入 | 不为数据文件再装第二套重复工具 |
| Vue / Svelte / Astro | 沿用框架现有 formatter | 保留 `vue-tsc`、`svelte-check`、`astro check` 等框架检查 | Biome 完整支持仍可能是实验能力；Oxlint 只 lint script 区域，不能替代框架检查 |

Formatter 只保证规范化输出。Lint、typecheck、compile 和行为测试分别覆盖不同失败模式，互不冒充。

## 反模式（见到即判不达标）

- **抢占用户输入的系统脚本**：AppleScript/cliclick/robotjs 盲坐标移动真实鼠标——不可并行、不可无头、打断用户工作（better-computer-use 使用结构化控件定位，可作兜底取证，但同样占用桌面，不能当常规测试链）
- **sleep 驱动**：固定 `sleep 3` 等页面就绪——flaky 的根源；改用条件等待（元素出现、日志行出现、端口就绪）
- **人肉点击当默认流程**：每次验证都要用户配合，验证就不会被执行
- **"没崩就算过"**：只断言退出码/无异常，不断言行为
- **截图 diff 当唯一断言**：像素级对比对字体渲染/动画帧敏感，只适合布局回归，不适合行为验证

## 建链的最小形状

不要一上来建完整回归套件。最小可用 = 一个能跑的验证入口 + 本次最值得保护的一条行为用例；仓库已配置的静态门接入同一入口。只有通过测试价值门的 bug 合同才沉淀回归用例。
