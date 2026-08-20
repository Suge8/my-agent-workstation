# Agent 导览

本仓库面向 Apple Silicon macOS，组装并维护一套以 Pi 为入口的 Agent 工作站。

## 目录

- `setup`：唯一安装与生命周期控制入口；用户可见行为以 `--help` 和实测为准。
- `lib/`：安装器内部的组件、备份和所有权实现，不提供第二入口。
- `packages/`：FireCode、Skills、Pi 配置与 BCU。
- `resources/`：组件清单、配置模板与模型档案。
- `scripts/`：生成模型配置，并把维护源同步为发行快照。
- `tests/`：顶层安装、配置资产和 Package 行为验证。

## 常用命令

```bash
./setup --help
./setup doctor
./setup plan --mode full
bun run check:shell
bun run test
npm run test:bcu
```

先运行最窄的受影响验证；只有接缝无法由窄测覆盖时才扩大范围。

## 按需读取

- 涉及术语或模块边界时，读取 [CONTEXT.md](CONTEXT.md)。
- 改 FireCode 时，先读取 `packages/firecode/AGENTS.md`；进入其子目录时继续读取最近的 `AGENTS.md`。
- 改 BCU 时，先读取 `packages/better-computer-use/README.md` 了解运行边界与上游归属。
- 改安装体验或公开行为时，对照 [README.md](README.md)；公开接口变化需同步更新对应用户文档。
- 同步 FireCode、Skills 或 SYSTEM 时运行 `./maintain sync`；命令只生成并验证发行快照。
- 准备贡献或处理安全报告时，分别读取 [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) 与 [.github/SECURITY.md](.github/SECURITY.md)。
