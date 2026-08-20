---
name: timing
description: Remotion 中的插值和计时 — 更喜欢使用贝塞尔曲线缓动进行插值；弹簧作为专门选项
metadata:
  tags: easing, bezier, interpolation, spring, timing
---

在明确的帧范围内使用 `interpolate()` 驱动运动。优先使用 `interpolate()` 而不是 `spring()`，除非用户明确要求基于物理的运动。要自定义计时，请使用 **`Easing.bezier`**。四个参数与CSS`cubic-bezier(x1, y1, x2, y2)`相同。

使用 `interpolate` 函数完成简单的线性插值。

```ts title="Going from 0 to 1 over 100 frames"
import { interpolate } from "remotion";

const opacity = interpolate(frame, [0, 100], [0, 1]);
```

默认情况下，这些值不会被限制，因此该值可能会超出范围 [0, 1]。
以下是如何夹紧它们：

```ts title="Going from 0 to 1 over 100 frames with extrapolation"
const opacity = interpolate(frame, [0, 100], [0, 1], {
  extrapolateRight: "clamp",
  extrapolateLeft: "clamp",
});
```

## Studio-可编辑的动画图案

当动画应该在 Remotion Studio 中可编辑时，请将 `interpolate()` 调用直接保留在 `style` 属性中，并首选单独的 CSS 变换属性：

```tsx
// 👍 Inline editable keyframes and transform shorthands
style={{
  scale: interpolate(frame, [0, 100], [0, 1]),
  translate: interpolate(frame, [0, 100], ["0px 0px", "100px 100px"]),
  rotate: interpolate(frame, [0, 100], ["20deg", "90deg"]),
}}

// 👎 Hidden values and transform strings become computed in Studio
const translateY = interpolate(frame, [0, 100], [0, 120]);
const rotation = interpolate(frame, [0, 100], [0, 20]);

style={{
  transform: `translateY(${translateY}px) rotate(${rotation}deg)`,
}}
```

仅当单个 CSS 变换属性不覆盖效果时才使用 `transform` 字符串，例如 `skew()`、`perspective()` 或顺序敏感的多重变换链。

## 贝塞尔曲线缓动

在 `interpolate` 选项对象中使用 `Easing.bezier(x1, y1, x2, y2)`。该曲线在本质上与 CSS 动画和过渡相同，这有助于您从网络或设计师的规范中窃取时间。

```ts
import { interpolate, Easing } from "remotion";

const opacity = interpolate(frame, [0, 60], [0, 1], {
  easing: Easing.bezier(0.16, 1, 0.3, 1),
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
});
```

### 示例（复制粘贴曲线）

**1。清晰的 UI 入口（强缓出，无过冲）** — 很好地减慢到剩余值；类似于许多系统“减速”曲线。

```tsx
const enter = interpolate(frame, [0, 45], [0, 1], {
  easing: Easing.bezier(0.16, 1, 0.3, 1),
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
});
```

**2。社论/缓慢淡出（平衡缓入出）** — 在保持友好的移动中对称加速和减速。

```tsx
const progress = interpolate(frame, [0, 90], [0, 1], {
  easing: Easing.bezier(0.45, 0, 0.55, 1),
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
});
```

**3。有趣的超调（控制点 y > 1）** — 稍微超出目标然后稳定下来；谨慎使用以强调。

```tsx
const pop = interpolate(frame, [0, 30], [0, 1], {
  easing: Easing.bezier(0.34, 1.56, 0.64, 1),
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
});
```

## 预设缓动（`Easing.in` / `Easing.out` / 命名曲线）

可以将缓动添加到 `interpolate` 函数中，无需自定义立方体：

```ts
import { interpolate, Easing } from "remotion";

const value1 = interpolate(frame, [0, 100], [0, 1], {
  easing: Easing.inOut(Easing.cubic),
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
});
```

默认缓动为 `Easing.linear`。
凸点：

- `Easing.in` — 缓慢启动并加速
- `Easing.out` — 快速启动并减速
- `Easing.inOut`

命名曲线（从最线性到最弯曲）：

- `Easing.quad`
- `Easing.cubic`（当您不需要自定义立方体时，这是很好的默认值）
- `Easing.sin`
- `Easing.exp`
- `Easing.circle`

### enter/exit 动画的缓动方向

使用 `Easing.out` 表示进入动画（快速启动，减速到位），使用 `Easing.in` 表示退出动画（缓慢启动，加速离开）。这感觉很自然，因为元素随着动量到达并随着重力离开。当您需要设计特定曲线时，更喜欢单个 `Easing.bezier(...)` 而不是堆叠预设。

## 组合插值

当多个属性共享相同的时序并且不需要 Studio 关键帧编辑（例如滑入面板和视频移位）时，请避免为每个属性重复完整插值。相反，创建一个标准化进度值（0 到 1）并从中派生每个属性：

```tsx
const slideIn = interpolate(
  frame,
  [slideInStart, slideInStart + slideInDuration],
  [0, 1],
  {
    easing: Easing.bezier(0.22, 1, 0.36, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  },
);
const slideOut = interpolate(
  frame,
  [slideOutStart, slideOutStart + slideOutDuration],
  [0, 1],
  { easing: Easing.in(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" },
);
const progress = slideIn - slideOut;

// Derive multiple properties from the same progress
const overlayX = interpolate(progress, [0, 1], [100, 0]);
const videoX = interpolate(progress, [0, 1], [0, -20]);
const opacity = interpolate(progress, [0, 1], [0, 1]);
```

关键思想：将**timing**（何时以及多快）与**mapping**（在什么值之间进行动画处理）分开。

如果值应该在 Studio 中以视觉方式设置关键帧，则更喜欢在相关样式属性中内联 `interpolate()` 调用，即使它会重复计时。
