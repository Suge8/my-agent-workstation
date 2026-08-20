# Better Computer Use

`bcu` 是面向 AI agent 的独立 macOS 桌面操控 CLI。CLI 客户端按需启动一个用户级 Broker；Broker 持有状态、并发调度和原生 Helper 连接，三者随本 package 一起构建和发布。

## 支持范围

- Apple Silicon（arm64）
- macOS 14 或更高版本
- Node.js 20.6 或更高版本

## 安装与权限

工作站向导负责构建并安装本仓库内的 package：

```bash
./setup apply --mode full --keep-system
```

单独开发本 package 时运行 `npm install`、`npm run build`，再执行 `npm install -g .`。

首次使用时，在“系统设置 → 隐私与安全性”中为 `/Applications/bcu.app` 授予“辅助功能”和“屏幕录制”权限。缺少权限时，`bcu doctor` 和实际命令会返回人工操作步骤；不会重置或绕过 macOS 授权。

## 快速开始

```bash
bcu find-roots --app TextEdit
bcu observe-ui --root @r1
bcu search-ui --state STATE_ID --text Save
printf '%s\n' '[{"action":"press","ref":"@e12"}]' | bcu act-ui --state STATE_ID -
```

状态查询和操作必须使用同一次观察返回的 `stateId` 与 ref。运行 `bcu --help` 查看完整命令面，完整参数见 [CLI 使用手册](./docs/usage.md)；`bcu status` 只检查 Broker，`bcu doctor` 检查 Broker、Helper、权限和配置，`bcu stop` 停止 Broker。

## 来源与改造

本发行版保留上游 [`injaneity/pi-computer-use`](https://github.com/injaneity/pi-computer-use)、原作者 **Zane Chee** 和原 MIT `LICENSE`。上游是 Pi extension；本 package 去除 Pi extension 入口和无关平台资产，保留其高价值桌面控制实现，并增加独立的 `bcu` CLI、单用户 Broker、macOS arm64 Helper 构建/安装和权限诊断流程。

这是独立发行入口，不伪装成上游 Pi package；源码改造仍按原 MIT 条款随包提供。
