# 表单标注与反馈放置

目标是在不让用户猜、不隐藏关键状态的前提下减少文字。判断依据是信息何时有用、用户在哪里处理，而不是追求更少 DOM 节点。

## 放置决策

| 信息 | 位置 | 持续时间 |
|---|---|---|
| 操作前必须知道的范围、例外或后果 | 控件 caption、分组说明；高风险操作用确认 Dialog | 操作前可见 |
| Toggle、选中态等控件已有明确终态 | 控件本身 | 状态存在期间 |
| 用户能在局部修复的输入错误 | 对应字段或字段组旁 | 修复前保持 |
| 整个表单或一组凭据失败 | 表单内 Alert；长表单可加错误摘要 | 解决前保持 |
| 跨区域且持续的系统问题 | 页面或区域 Banner | 恢复或关闭前保持 |
| 无需处理的短暂操作结果 | Toast 或 `role="status"` | 短暂 |
| 不影响决策和任务完成的补充解释 | Tooltip、Toggletip 或帮助链接 | 按需 |

- 同一事实只选一个主要反馈通道。控件已经显示结果时不再 Toast；同一句错误不同时出现在 Toast 和字段旁。
- 长表单的错误摘要与字段错误承担导航和修复两种职责，属于必要重复。
- Tooltip 不承载错误、安全影响、不可逆后果或完成任务所需的信息；必须同时支持 hover、focus、Escape 和 touch。含交互内容时使用 Toggletip/Popover，而不是 Tooltip。

## Toggle 与设置范围

先让设置名称准确，再考虑增加说明。若“邮件通知”实际只能控制产品邮件，优先写成：

```text
邮件
产品动态                         [开关]
安全提醒                         始终发送
```

不可调整的“安全提醒”使用静态状态，不伪装成 disabled Toggle。现有信息架构不能改时，在开关旁保留短 caption：

```text
邮件通知                         [开关]
安全提醒始终发送
```

caption 使用 `aria-describedby` 与开关关联。切换成功由开关终态表达，不弹“已开启/已关闭”。异步保存失败时恢复最后确认的状态，并在该设置旁显示可重试错误；不得让界面显示开启而服务端仍是关闭。

## Label、Placeholder 与图标

- 每个输入必须有程序化 label，默认也保持可见。认证字段、地址、付款和多字段表单不使用 visually hidden label 作为视觉减法。
- Label 回答“填什么”，Placeholder 只提供非必要的格式或示例。两者同义时保留 Label、删除 Placeholder；空输入框是正常状态。
- Placeholder 会在输入、自动填充后消失。必填状态、输入要求、安全说明和错误不得只写在 Placeholder 中。密码字段通常不需要 Placeholder。
- Leading icon 只能辅助扫描，不能承担字段名称。装饰图标使用 `aria-hidden="true"`；没有明确收益时删除用户名、锁等重复图标。显示密码、清空等可操作 trailing icon 必须是 Button，并有准确 accessible name。
- 默认使用简短的上置 Label：Label 与输入间距 4–8px，字段组之间 16–20px。Label 是控件文字，不做成第二级标题。
- 紧凑界面只能复用项目现有、已验证的 floating-label 组件。真实 `<label>` 在 focus、已填值、浏览器 autofill、错误和恢复状态下都必须持续可见；不得为节省一行自行实现。
- 只有目的从同屏上下文完全明确的单用途输入，例如紧邻搜索操作的站内搜索，才可隐藏视觉 Label；仍需程序化名称。用户名、当前密码、新密码和确认密码不属于例外。
- 登录输入设置正确的 `type`、`name` 和 `autocomplete`：标识符使用 `autocomplete="username"`，登录密码使用 `current-password`，注册或重置密码使用 `new-password`。

推荐：

```text
邮箱
[ name@example.com ]   可选示例，不需要时留空

密码
[                  ] [显示密码]
```

避免：

```text
用户名
[ 👤 用户名 ]          Label 与 Placeholder 重复

[ 🔒 密码 ]            输入后只剩含义不唯一的图标
```

## 验证与认证错误

- 初始空白状态不显示错误。默认在提交后验证；已有即时验证模式时等用户完成输入再检查。错误出现后可在用户修正时更新。密码强度和用户名可用性属于明确的实时状态例外。
- 格式或必填错误放在字段旁，说明问题和修复动作，并用 `aria-invalid`、`aria-describedby` 关联；修好后移除 `aria-invalid`。不得只用红色边框表达错误。
- 错误文案是指令：写怎么改而不是指责用户，不用“Oops”和感叹号，正面表述（“仅使用字母”而不是“不要用数字”）。格式要求能提前告知的，写在 caption 里，不等出错才说。同一错误大量重复发生时重做交互，不只改文案。
- 提交后把焦点移到第一个错误字段。不得在表单合法前禁用提交按钮：用户需要提交才能知道卡在哪里。
- 输入过程中不拦截字符也不实时过滤，先接受再校验；校验前先 trim，自动填充和输入法会带入首尾空格。
- 登录失败属于凭据组合错误，在表单内使用统一信息，例如“用户名或密码不正确”；不要在密码字段下确认“密码错误”，也不要泄露账号是否存在。失败后不保留密码值。
- 服务不可用、网络中断等用户不能通过改输入修复的问题使用表单内 Alert 或区域 Banner，不标红字段。
- 动态消息由状态驱动，更新稳定的 message slot。需要即时播报时，让空的 live region 先存在于 DOM，再更新内容；不要命令式地在任意按钮后追加临时节点。
- 短表单使用字段或表单内错误即可；长表单、多错误或提交后重新载入页面时增加可聚焦的错误摘要，并链接到对应字段。

## 验收

- 输入有持久、可见且与 accessible name 一致的 Label；输入和 autofill 后仍能确认字段含义。
- 没有与 Label 同义的 Placeholder，也没有用图标替代 Label。
- 安全例外在决策前可见；Tooltip 中没有关键内容。
- Toggle、复制、收藏等已有可读终态时没有重复成功 Toast。
- 字段错误、凭据错误和系统错误进入各自上下文，保持到解决，并可被键盘与读屏器发现。
- 提交失败后焦点落在第一个错误字段，提交按钮在任何阶段都可点击。
- 分别验证初始、focus、已填、autofill、错误、修正、异步失败、窄屏和 200% zoom。

## 依据

- W3C WAI：[Labeling Controls](https://www.w3.org/WAI/tutorials/forms/labels/)、[Form Instructions](https://www.w3.org/WAI/tutorials/forms/instructions/)、[Error Identification](https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html)、[ARIA19](https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA19)
- MDN：[placeholder attribute](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/placeholder)
- GOV.UK Design System：[Text input](https://design-system.service.gov.uk/components/text-input/)、[Validation](https://design-system.service.gov.uk/patterns/validation/)、[Passwords](https://design-system.service.gov.uk/patterns/passwords/)
- U.S. Web Design System：[Text input](https://designsystem.digital.gov/components/text-input/)、[Sign-in form](https://designsystem.digital.gov/templates/form-templates/sign-in-form/)、[Tooltip](https://designsystem.digital.gov/components/tooltip/)
- Fluent 2：[Field](https://fluent2.microsoft.design/components/web/react/core/field/usage)
- Carbon Design System：[Text input](https://carbondesignsystem.com/components/text-input/usage/)、[Notification](https://carbondesignsystem.com/components/notification/usage/)
- Primer：[ToggleSwitch accessibility](https://primer.style/product/components/toggle-switch/accessibility/)、[Text input](https://primer.style/design/components/text-input/)
- Shopify：[Alerts](https://shopify.dev/docs/apps/design/user-experience/alerts)、[Toast](https://polaris.shopify.com/components/feedback-indicators/toast)
- web.dev：[Sign-in form best practices](https://web.dev/articles/sign-in-form-best-practices)
- OWASP：[Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- Nielsen Norman Group：[Placeholders in Form Fields Are Harmful](https://www.nngroup.com/articles/form-design-placeholders/)
