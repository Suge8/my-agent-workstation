---
name: light-leaks
description: 使用@remotion/light-leaks.对Remotion进行漏光叠加效果
metadata:
  tags: light-leaks, overlays, effects, transitions
---

## 漏光

这仅适用于 Remotion 4.0.415 及更高版本。使用`npx remotion versions`检查您的Remotion版本，使用`npx remotion upgrade`升级您的Remotion版本。

`@remotion/light-leaks`中的`<LightLeak>`渲染基于WebGL的漏光效果。它在其持续时间的前半段显露并在后半段缩回。

通常在 `<TransitionSeries.Overlay>` 内使用，以在两个场景之间的切换点上播放。请参阅 **transitions** 规则了解 `<TransitionSeries>` 和叠加用法。

## 先决条件

```bash
npx remotion add @remotion/light-leaks
```

## TransitionSeries 的基本用法

```tsx
import { TransitionSeries } from "@remotion/transitions";
import { LightLeak } from "@remotion/light-leaks";

<TransitionSeries>
  <TransitionSeries.Sequence durationInFrames={60}>
    <SceneA />
  </TransitionSeries.Sequence>
  <TransitionSeries.Overlay durationInFrames={30}>
    <LightLeak />
  </TransitionSeries.Overlay>
  <TransitionSeries.Sequence durationInFrames={60}>
    <SceneB />
  </TransitionSeries.Sequence>
</TransitionSeries>;
```

## 道具

- `durationInFrames?` — 默认为父级 sequence/composition 持续时间。该效果在上半场显现，在下半场收回。
- `seed?` — 确定漏光图案的形状。不同的种子会产生不同的图案。默认值：`0`。
- `hueShift?` — 以度数旋转色调 (`0`–`360`)。默认值：`0`（黄色到橙色）。 `120` = 绿色，`240` = 蓝色。

## 定制外观

```tsx
import { LightLeak } from "@remotion/light-leaks";

// Blue-tinted light leak with a different pattern
<LightLeak seed={5} hueShift={240} />;

// Green-tinted light leak
<LightLeak seed={2} hueShift={120} />;
```

## 独立使用

`<LightLeak>` 也可以在 `<TransitionSeries>` 之外使用，例如作为任何组合中的装饰覆盖层：

```tsx
import { AbsoluteFill } from "remotion";
import { LightLeak } from "@remotion/light-leaks";

const MyComp: React.FC = () => (
  <AbsoluteFill>
    <MyContent />
    <LightLeak durationInFrames={60} seed={3} />
  </AbsoluteFill>
);
```
