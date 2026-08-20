---
name: ship
disable-model-invocation: true
description: 发布/提交流程：用户说 ship、发布、提交、推送、commit、更新版号、changelog、打 tag、开源准备时使用，凡是要把工作区改动变成提交/版本/Release 的时刻都算，即使用户只说了"提交一下"。按仓库自身风格做细粒度原子提交、更新版本与 changelog、盯 CI 到绿。不用于：写代码、修 bug、PR review。
---
# Ship

把工作区收干净并发布。**不做代码修改**（lint 自动修复除外）。

所有风格从仓库现学，零硬编码——同一个用户的不同仓库风格可能完全不同（有的 emoji 前缀，有的纯 conventional；有的 changelog 双语，有的只有英文）。写死必错，现学必对。

## Step 0 — 事实收集（并行执行）

- `git status` + `git diff`：改动全貌，确认没有半成品
- `git log --oneline -20`：学本仓库 commit 风格（是否 emoji 前缀、type/scope 惯例、test/docs 是否独立提交）
- CHANGELOG 头部 30 行：学格式（是否双语、分节方式、Unreleased 段）
- 版本文件位置（package.json / Cargo.toml / 多包 monorepo 逐个确认）
- `.github/workflows/`：确认 CI 和 release 触发方式（tag push？）

## Step 1 — 一句话确认

问用户：**是否更新版号（Y/N）**。用户调用时已说明的直接跳过。

## Step 2 — 提交（Y/N 都做）

1. **脱敏扫描**：diff 里查密钥/token/内网地址/个人路径模式，命中即停，报告用户
2. **细粒度原子拆分**：按逻辑单元分组暂存（`git add -p` / 按文件），每个 commit 单一意图、可独立 revert、可被 bisect 定位。禁止 `git add .` 一把梭。test/docs 是否独立提交，跟随 Step 0 学到的仓库惯例
3. commit message 严格匹配仓库现有风格
4. lint / typecheck（仓库有就跑），失败先修 lint 问题再提交
5. push，确认工作区干净

拆分示例——一次改动同时含新功能、附带修复和文档：

```
feat(session): persist selected conversation
fix(session): drop stale draft on conversation switch
test(session): cover persistence and stale draft
docs(changelog): note session persistence
```

而不是一个 `feat: update session stuff` 装下全部。判断标准：revert 任意一个 commit，其余仍应独立成立。

## Step 3 — 仅 Y：发布

发布顺序是硬边界：先完成 Step 2 的全部用户改动提交，再修改版本与 CHANGELOG 并创建 release commit；tag 必须指向这个最终 release commit。禁止先提交 release 元数据、再把业务改动补在 tag 前后。

1. 按 semver 判定新版号（用户没指定时自己判定，执行前一句话告知，不阻塞）
2. 更新版本文件 + CHANGELOG：新条目从本次 commits 生成，用户向语言，不写实现细节；双语仓库两种语言都写；文风走 stop-slop
3. `chore(release): prepare vX.Y.Z` 提交（匹配仓库风格）→ 打 tag → push tag
4. **盯 CI 到绿**：`gh run watch`（外部系统无事件接口，等待即业务语义）。红了：分析日志，属本次发布的问题就修并重走流程；历史遗留问题报告用户
5. 确认 release 产物生成，报告最终链接

## 硬规则

- 全程不改业务代码；发现代码问题只报告，不顺手修
- 不合并无关改动进同一 commit
- CI 没绿不算结束，不许中途宣布完成

