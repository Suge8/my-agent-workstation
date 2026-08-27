# Agent 导览

`packages/firecode` 与 `packages/skills` 是作者本机维护源的发行快照；请在上游源仓库修改，再运行 `npm run sync` 更新这里的快照，同步会整体替换快照内容。

## 常用命令

```bash
bun run test
npm run test:bcu
npm run sync
```

## 按需读取

- **配置**：修改配置文档时读取 [SETUP.md](SETUP.md)。
- **FireCode**：修改 FireCode 时读取 `packages/firecode/AGENTS.md`，进入子目录后继续读取最近的 `AGENTS.md`。
- **BCU**：修改 BCU 时读取 `packages/better-computer-use/README.md`。
- **安全**：处理安全报告时读取 [.github/SECURITY.md](.github/SECURITY.md)。
