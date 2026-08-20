# 领域文档

工程技能在探索代码库时应如何使用本仓库的领域文档。

## 探索前读取这些文件

- 仓库根目录的 **`CONTEXT.md`**，或
- 如果存在仓库根目录的 **`CONTEXT-MAP.md`** — 它会指向每个上下文的一个 `CONTEXT.md`。读取与主题相关的每一个文件。
- **`docs/adr/`** — 读取涉及即将处理区域的 ADR。在多上下文仓库中，还要检查 `src/<context>/docs/adr/` 中上下文范围内的决策。

如果这些文件或目录不存在，**静默继续**。不要指出它们缺失；不要建议预先创建它们。`/domain-modeling` 技能（通过 `/grill-with-docs` 和 `/improve-codebase-architecture` 进入）会在术语或决策实际解决时按需创建它们。

## 文件结构

单一上下文仓库（大多数仓库）：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

多上下文仓库（根目录存在 `CONTEXT-MAP.md`）：

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← 系统范围的决策
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← 上下文特定的决策
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## 使用术语表中的词汇

当你的输出命名领域概念（在 issue 标题、重构提案、假设、测试名称中）时，使用 `CONTEXT.md` 中定义的术语。不要改用术语表明确避免的同义词。

如果所需概念尚未出现在术语表中，这是一个信号——要么你正在创造项目未使用的语言（重新考虑），要么确实存在缺口（记录给 `/domain-modeling`）。

## 标记 ADR 冲突

如果你的输出与现有 ADR 矛盾，明确指出，而不是静默覆盖：

> _与 ADR-0007（事件溯源订单）矛盾——但值得重新打开，因为……_
