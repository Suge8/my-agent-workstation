# UI 信息减法

只减少重复信息，不改变信息架构、功能、响应式行为或设计系统。目标是让用户快速确认当前位置、主要状态和下一步操作。

## 执行顺序

1. 分别列出桌面与窄屏首个视口中的可见文字和操作，不边看边删。
2. 给每项标记职责：定位、状态、指令、动作、后果或帮助。没有职责，或只复述同屏内容的项目删除。
3. 先决定每条信息的唯一可见来源，再修改 JSX 与样式；删除文字后同步删除空 Header、间距、分割线和装饰背景。
4. 最后检查窄屏、深链、长内容和读屏器。视觉去重不得破坏程序化名称与定位。

## 保留判断

| 内容 | 保留 | 删除 |
|---|---|---|
| Eyebrow / 页面标题 | 导航不可见、内容可独立访问、页面很长或标题增加新范围 | 与同屏持久导航当前项同名 |
| Description | 补充格式、范围、前置条件、后果或下一步 | 改写标题，或只说“在这里管理/选择” |
| Helper text | 说明例外、安全影响、不可逆结果或输入要求 | 复述控件名、默认交互或屏上已有示例 |
| Input Label / Placeholder | 持久 Label 说明字段；Placeholder 仅作非必要示例 | 两者同义，或删除 Label 只留 Placeholder |
| CTA | 当前对象的唯一主要动作，使用具体动词 | Header、正文和 Empty state 重复同一动作 |

## 导航与标题

- 持久双栏桌面中，左侧选中项与右侧内容同时可见时，右侧不显示同名 Eyebrow 或页面标题。内容区通过 `aria-labelledby` 或准确的 accessible name 保持可定位。
- 若窄屏隐藏左侧导航，右侧在该断点显示简短页面标题；不得为了保留定位而把既有侧栏改成顶部导航。
- Tabs 的 panel 很短且 tab list 始终可见时可省略内部标题。窄屏、长内容或读屏导航需要时可重复 tab label，并正确关联 `tab` 与 `tabpanel`。
- 页面始终保留唯一、随视图更新的文档 `<title>`。Heading 只用于定位、层级或真实分组。
- 单问题页面可让 `label` 或 `legend` 同时承担 H1，避免两个节点朗读同一句话。

## 文案

- 使用用户熟悉的词和 sentence case。Button 与链接写具体动作或目的；上下文已唯一确定对象时不重复对象名。
- 标题已经说明内容时不追加同义正文。只有不影响决策或任务完成的补充细节才放入 Tooltip、Details 或帮助链接。
- 安全、错误、不可逆后果、颜色之外的状态文字和可访问名称属于必要冗余，必须保留；表单与反馈按 `forms-and-feedback.md` 放置。
- 用层级、留白、对齐和精确控件建立极简感；不得缩小字体、隐藏关键标签或让用户猜。

## 验收

- 桌面每条信息只有一个可见来源，窄屏仍能定位。
- 每段保留文字都能指出新增的信息。
- 删除重复文字后没有空 Header、孤立分割线或多余顶部留白。
- 同义 Label/Placeholder 去重后，输入与 autofill 状态仍有持久 Label。
- 文档 title、landmark、Heading、Label、Tab/Panel 关系和读屏名称完整。
- 信息架构、响应式行为、操作语义与安全信息未改变。

## 依据

- Apple HIG：[Writing](https://developer.apple.com/design/human-interface-guidelines/writing)、[Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)、[Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)
- Microsoft：[User Interface Text](https://learn.microsoft.com/en-us/windows/win32/uxguide/text-ui)、[Recommendations for writing user interface content](https://learn.microsoft.com/en-us/power-platform/well-architected/experience-optimization/user-interface-content)
- GOV.UK Design System：[Tabs](https://design-system.service.gov.uk/components/tabs/)、[Making labels and legends headings](https://design-system.service.gov.uk/get-started/labels-legends-headings/)
- W3C WCAG 2.2：[2.4.2 Page Titled](https://www.w3.org/WAI/WCAG22/Understanding/page-titled)、[2.4.6 Headings and Labels](https://www.w3.org/WAI/WCAG22/Understanding/headings-and-labels.html)
- Carbon Design System：[Writing style](https://carbondesignsystem.com/guidelines/content/writing-style/)、[Content switcher](https://carbondesignsystem.com/components/content-switcher/usage/)
