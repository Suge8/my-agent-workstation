# CONTEXT.md 格式

## 结构

```md
# {上下文名称}

{用一或两句话说明这个上下文是什么，以及它为什么存在。}

## 语言

**Order**：
{对该术语的一个或两个句子的描述}
_避免使用_：Purchase、transaction

**Invoice**：
交付后发送给客户的付款请求。
_避免使用_：Bill、payment request

**Customer**：
下订单的个人或组织。
_避免使用_：Client、buyer、account
```

## 规则

- **明确表达立场。**当同一概念有多个词时，选择最合适的一个，并将其他词列在 `_Avoid_` 下。
- **保持定义简洁。**最多一或两个句子。定义它是什么，而不是它做什么。
- **只包含项目上下文特有的术语。**通用编程概念（超时、错误类型、工具模式）不属于这里，即使项目大量使用它们。在添加术语前问自己：这是该上下文独有的概念，还是通用编程概念？只有前者才属于这里。
- **在自然形成术语群组时，用子标题将术语分组。**如果所有术语都属于一个连贯的领域，使用扁平列表即可。

## 单上下文与多上下文仓库

**单上下文（大多数仓库）：**仓库根目录下有一个 `CONTEXT.md`。

**多上下文：**仓库根目录下的 `CONTEXT-MAP.md` 会列出各个上下文、它们所在的位置以及它们之间的关系：

```md
# Context Map

## Contexts

- [Ordering](./src/ordering/CONTEXT.md) — 接收并跟踪客户订单
- [Billing](./src/billing/CONTEXT.md) — 生成发票并处理付款
- [Fulfillment](./src/fulfillment/CONTEXT.md) — 管理仓库拣货和发货

## Relationships

- **Ordering → Fulfillment**：Ordering 发出 `OrderPlaced` 事件；Fulfillment 消费该事件以开始拣货
- **Fulfillment → Billing**：Fulfillment 发出 `ShipmentDispatched` 事件；Billing 消费该事件以生成发票
- **Ordering ↔ Billing**：`CustomerId` 和 `Money` 的共享类型
```

该 skill 会推断应采用哪种结构：

- 如果存在 `CONTEXT-MAP.md`，读取它以查找上下文
- 如果只有根目录下的 `CONTEXT.md`，则为单上下文
- 如果两者都不存在，则在解析第一个术语时延迟创建根目录下的 `CONTEXT.md`

存在多个上下文时，推断当前主题关联的是哪个上下文。如果不清楚，就询问。
