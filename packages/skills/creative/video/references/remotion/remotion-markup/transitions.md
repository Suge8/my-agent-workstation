---
name: transitions
description: 使用 TransitionSeries 为 Remotion 进行场景转换和叠加。
metadata:
  tags: transitions, overlays, fade, slide, wipe, scenes
---

## 过渡系列

`<TransitionSeries>` 安排场景并支持两种方式来增强它们之间的切入点：

- **过渡** (`<TransitionSeries.Transition>`) — 两个场景之间的交叉淡入淡出、滑动、擦除等。缩短时间线，因为两个场景在过渡期间同时播放。
- **Overlays** (`<TransitionSeries.Overlay>`) — 在剪切点顶部渲染效果（例如漏光），而不缩短时间线。

孩子们是绝对有地位的。

## 先决条件

```bash
npx remotion add @remotion/transitions
```

## 过渡示例

```tsx
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";

<TransitionSeries>
  <TransitionSeries.Sequence durationInFrames={60}>
    <SceneA />
  </TransitionSeries.Sequence>
  <TransitionSeries.Transition
    presentation={fade()}
    timing={linearTiming({ durationInFrames: 15 })}
  />
  <TransitionSeries.Sequence durationInFrames={60}>
    <SceneB />
  </TransitionSeries.Sequence>
</TransitionSeries>;
```

## 叠加示例

任何 React 组件都可以用作叠加层。对于现成的效果，请参阅 **light-leaks** 规则。

```tsx
import { TransitionSeries } from "@remotion/transitions";
import { LightLeak } from "@remotion/light-leaks";

<TransitionSeries>
  <TransitionSeries.Sequence durationInFrames={60}>
    <SceneA />
  </TransitionSeries.Sequence>
  <TransitionSeries.Overlay durationInFrames={20}>
    <LightLeak />
  </TransitionSeries.Overlay>
  <TransitionSeries.Sequence durationInFrames={60}>
    <SceneB />
  </TransitionSeries.Sequence>
</TransitionSeries>;
```

## 混合过渡和叠加

过渡和叠加可以共存于同一个 `<TransitionSeries>` 中，但叠加不能与过渡或另一个叠加相邻。

```tsx
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
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
  <TransitionSeries.Transition
    presentation={fade()}
    timing={linearTiming({ durationInFrames: 15 })}
  />
  <TransitionSeries.Sequence durationInFrames={60}>
    <SceneC />
  </TransitionSeries.Sequence>
</TransitionSeries>;
```

## 过渡道具

`<TransitionSeries.Transition>` 要求：

- `presentation` — 视觉效果（例如`fade()`、`slide()`、`wipe()`）。
- `timing` — 控制速度和缓动（例如 `linearTiming()`、`springTiming()`）。

## 叠加道具

`<TransitionSeries.Overlay>`接受：

- `durationInFrames` — 覆盖层可见的时间长度（正整数）。
- `offset?` — 相对于剪切点中心移动叠加层。正=较晚，负=较早。默认值：`0`。

## 可用的过渡类型

从各自的模块导入过渡：

```tsx
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import { flip } from "@remotion/transitions/flip";
import { clockWipe } from "@remotion/transitions/clock-wipe";
```

## 带方向的滑动过渡

```tsx
import { slide } from "@remotion/transitions/slide";

<TransitionSeries.Transition
  presentation={slide({ direction: "from-left" })}
  timing={linearTiming({ durationInFrames: 20 })}
/>;
```

路线：`"from-left"`、`"from-right"`、`"from-top"`、`"from-bottom"`

## 计时选项

```tsx
import { linearTiming, springTiming } from "@remotion/transitions";

// Linear timing - constant speed
linearTiming({ durationInFrames: 20 });

// Spring timing - organic motion
springTiming({ config: { damping: 200 }, durationInFrames: 25 });
```

## 持续时间计算

过渡重叠相邻场景，因此总合成长度比所有序列持续时间的总和**短**。叠加不会影响总持续时间**而不是**。

例如，有两个 60 帧序列和一个 15 帧过渡：

- 无过渡：`60 + 60 = 120` 帧
- 带过渡：`60 + 60 - 15 = 105` 帧

在其他两个序列之间添加叠加不会改变总数。

### 获取转换的持续时间

在计时对象上使用 `getDurationInFrames()` 方法：

```tsx
import { linearTiming, springTiming } from "@remotion/transitions";

const linearDuration = linearTiming({
  durationInFrames: 20,
}).getDurationInFrames({ fps: 30 });
// Returns 20

const springDuration = springTiming({
  config: { damping: 200 },
}).getDurationInFrames({ fps: 30 });
// Returns calculated duration based on spring physics
```

对于没有显式 `durationInFrames` 的 `springTiming`，持续时间取决于 `fps`，因为它计算弹簧动画何时稳定。

### 计算总的乐曲持续时间

```tsx
import { linearTiming } from "@remotion/transitions";

const scene1Duration = 60;
const scene2Duration = 60;
const scene3Duration = 60;

const timing1 = linearTiming({ durationInFrames: 15 });
const timing2 = linearTiming({ durationInFrames: 20 });

const transition1Duration = timing1.getDurationInFrames({ fps: 30 });
const transition2Duration = timing2.getDurationInFrames({ fps: 30 });

const totalDuration =
  scene1Duration +
  scene2Duration +
  scene3Duration -
  transition1Duration -
  transition2Duration;
// 60 + 60 + 60 - 15 - 20 = 145 frames
```
