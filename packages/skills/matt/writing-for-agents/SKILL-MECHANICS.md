# Skill 机制

[`writing-for-agents`](SKILL.md) 的 skill 专属分支：当文档是一个 skill 时，哪些内容会变化——frontmatter、调用方式选择和路由 skill。除此之外，关于如何编写它的一切都在 `SKILL.md` 的通用参考中。

## 调用方式

有两种选择，取舍的是两种负载：

- **模型调用**的 skill 保留 `description`，这样 agent 可以自主触发它——其他 skill 也能找到它。你仍然可以输入它的名称：模型调用始终 _包含_ 用户调用权限；description 只会增加 agent 发现它的机会，绝不会移除人的调用权限。description 是 skill 顶层的上下文指针，被强制始终加载——用持续的上下文负载换取可发现性。内容全是参考资料的模型调用 skill 也是共享参考资料的一个归处：另一个 skill 可以调用它，因此多个 skill 需要的参考资料可以集中在一处。机制：省略 `disable-model-invocation`，并编写一个面向模型的 description，其中包含触发分支（`SKILL.md` 中关于编写指针的规则全部适用）。
- **用户调用**的 skill 会将 description 从 agent 的触达范围中移除：只有输入其名称的人可以调用它，其他 skill 都不能。上下文负载为零，但会消耗认知负载——你就是索引，必须记得它存在。机制：设置 `disable-model-invocation: true`；此时 `description` 面向人类——写一行摘要，删去触发列表。

只有在 agent 必须自行找到这个 skill，或另一个 skill 必须找到它时，才选择模型调用。如果它只会被手动触发，就设为用户调用，不支付上下文负载。

两个用户调用的 skill 都需要的共享参考资料不能放在任何一个 skill 中——没有 description，谁也无法触发另一个。将它移到 skill 系统之外的普通文件中：任何 skill 都可以指向外部参考资料。

## 按调用方式拆分

调用方式是拆分依据之一（按顺序拆分见 `SKILL.md`）：当存在一个应该自行触发的独立前导词——一个你确实会在提示词中使用的触发词——或另一个 skill 必须找到它时，就拆出一个模型调用的 skill。新 skill 的 description 会带来上下文负载，因此这种独立触达必须值得付出代价。

## 路由 skill

当用户调用的 skill 多到你记不住时，可以用**路由 skill**消除这份累积的认知负载：由一个用户调用的 skill 列出其他 skill 以及何时触达每一个，让人只需记住一个 skill，而不是许多个。它只能提示，不能触发它们：用户调用的 skill 没有 description，因此只有人可以触达它们。
