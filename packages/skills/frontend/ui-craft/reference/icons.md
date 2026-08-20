# Icon 静态规范

图标的观感由光学重量、状态表达和渲染尺寸决定，不由动效决定。动效见 SKILL.md 第 7 节。

## 描边匹配相邻文字

图标与紧邻文字的光学重量必须接近：细描边配半粗文字看起来像坏了，粗描边配常规文字会抢注意力。24px 网格的描边参考值：

| 相邻文字 | stroke-width |
|---|---:|
| Regular 400，14–16px | 1.5px |
| Medium / Semibold 500–600 | 2px |
| Bold 700，或强调型独立图标 | 2.5px |

- 一个界面只用一套光学策略。同一工具栏不混用描边约定不同的图标库；所选图标集没有描边变体时保持其原生描边，用尺寸和颜色做强调。
- 与文字同行时图标尺寸取 `1em`–`1.25em`，按 cap height 对齐，让两者一起缩放。

## 一个 SVG，用颜色表达状态

default、hover、selected、disabled 不做多份资源。SVG 用 `currentColor` 绘制，状态由 CSS 的 `color` 驱动：

```html
<svg fill="none" stroke="currentColor" stroke-width="2">…</svg>
```

```css
.icon-button { color: var(--ink-muted); }
.icon-button:hover { color: var(--ink); }
.icon-button[aria-pressed="true"] { color: var(--accent); }
```

导入第三方图标时把内部硬编码的 `fill="#666"`、`stroke="#000"` 一律改成 `currentColor`，否则状态色失效。

## Outline 默认，Fill 表示选中

图标集同时提供描边和填充变体时，把两者当成一对状态，不混用：

| 变体 | 用途 |
|---|---|
| Outline | 默认态：工具栏、列表行、与文字同行 |
| Fill | 选中或激活态：当前 Tab、已收藏、已点赞 |

全部用填充会让激活态失去信号。变体切换按 SKILL.md 第 7 节的 cross-fade 处理，槽位固定。

### Cross-fade 配方（无依赖）

两个图标同时留在 DOM，一个绝对定位叠在另一个上面；因为都不卸载，进出场都能用可中断的 transition 完成。非绝对定位的那个撑起槽位尺寸：

```html
<span class="icon-swap" data-active>
  <svg class="icon-active">…</svg>
  <svg class="icon-inactive">…</svg>
</span>
```

```css
.icon-swap { position: relative; display: inline-flex; }
.icon-swap .icon-active { position: absolute; inset: 0; }
.icon-swap svg {
  transition: opacity var(--duration-state) var(--ease-state),
              scale var(--duration-state) var(--ease-state);
}
.icon-swap:not([data-active]) .icon-active,
.icon-swap[data-active] .icon-inactive {
  opacity: 0;
  scale: 0.25;
}
```

项目已用 Motion 时改用 `AnimatePresence mode="popLayout"` 加 `initial={false}`，语义相同；不为图标切换新增动效依赖。

## 按渲染尺寸设计

- 每个图标都要在它实际最小的渲染尺寸（通常 16px）下检查是否仍可辨认；细内部线条和紧凑内白在小尺寸会糊成一团。
- 使用图标集的原生网格尺寸（16 / 20 / 24），不要用分数缩放把 24px 图标塞进 16px 槽位，否则边缘发虚。
- 小尺寸场景优先换用简化字形，而不是缩小复杂图形。
- 始终用 SVG，不用位图，保证任意像素密度下清晰。

## RTL 方向

`dir="rtl"` 下只翻转含义依赖阅读方向的图标：

| 翻转 | 不翻转 |
|---|---|
| 前进 / 后退箭头、导航 chevron | Logo 与品牌标记 |
| 文本块类图标（对齐、列表、缩进） | 对勾 |
| 音量波纹（沿阅读方向发散） | 实物：时钟、杯子、铅笔 |
| 发送类方向性图标 | 媒体播放控制（指磁带方向，惯例保持 LTR） |

```css
[dir="rtl"] .icon-directional { scale: -1 1; }
```

复合图标逐部件判断：叠加的角标或斜杠可能在主字形翻转后仍保持原位。

## 无障碍

- 图标按钮必须有 accessible name（可见文字、`aria-label` 或 visually hidden 文本），名称写动作而不是图标形状。
- 纯装饰图标加 `aria-hidden="true"`，避免读屏器重复播报相邻文字。
- 状态不得只靠颜色表达；填充变体、对勾或文字标签之一必须同时存在。

## 验收

- 图标描边与相邻文字字重匹配，同一界面只有一套光学策略。
- 所有状态由一份 SVG 加 `currentColor` 驱动，没有多份状态资源，也没有硬编码色值。
- Outline 与 Fill 成对使用，激活态有可见信号。
- 在 16px 下逐个确认可辨认，无分数缩放导致的模糊。
- RTL 下方向性图标已翻转，实物、对勾、Logo 和媒体控制未被误翻。
- 图标按钮有准确 accessible name，装饰图标对读屏器隐藏。

## 依据

- Apple HIG：[SF Symbols](https://developer.apple.com/design/human-interface-guidelines/sf-symbols)
- Material Design：[Applying icons](https://m3.material.io/styles/icons/applying-icons)、[Bidirectionality](https://m2.material.io/design/usability/bidirectionality.html)
- MDN：[`currentcolor`](https://developer.mozilla.org/en-US/docs/Web/CSS/color_value)
- W3C WAI：[Decorative Images](https://www.w3.org/WAI/tutorials/images/decorative/)
- W3C i18n：[Bidi CSS and markup](https://www.w3.org/International/questions/qa-bidi-css-markup)
- jakubkrehel/skills（MIT）：better-ui / icons
