# GSAP 与 Vue、Svelte 和其他框架
## 何时使用此技能
在 Vue（或 Nuxt）、Svelte（或 SvelteKit）或其他使用生命周期（安装/卸载）的组件框架中编写或审查 GSAP 代码时应用。具体来说，对于 **React**，请使用 **gsap-react** （useGSAP hook、gsap.context()）。
**相关技能：**对于补间和时间线使用**gsap-core**和**gsap-timeline**；对于基于滚动的动画，请使用 **gsap-scrolltrigger**；对于 React，请使用 **gsap-react**。
## 原则（所有框架）
- **在**组件的 DOM 可用（例如 onMounted、onMount）之后**创建**补间和 ScrollTriggers。
- **在**卸载**（或等效）清理中**杀死或恢复**它们，这样在分离的节点上就不会运行任何内容，并且不会出现泄漏。
- **范围选择器**到组件根，因此 `.box` 和类似的仅匹配该组件内的元素，而不匹配页面的其余部分。
## Vue 3（组合 API）
请参阅 `examples/vue/` 来了解演示这些模式的可运行 Vite + Vue 3 项目。
在组件位于 DOM 中后，使用 **onMounted** 运行 GSAP。使用 **onUnmounted** 进行清理。
```javascript
import { onMounted, onUnmounted, ref } from "vue";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
gsap.registerPlugin(ScrollTrigger); // once per app, e.g. in main.js

export default {
  setup() {
    const container = ref(null);
    let ctx;

    onMounted(() => {
      if (!container.value) return;
      ctx = gsap.context(() => {
        gsap.to(".box", { x: 100, duration: 0.6 });
        gsap.from(".item", { autoAlpha: 0, y: 20, stagger: 0.1 });
      }, container.value);
    });

    onUnmounted(() => {
      ctx?.revert();
    });

    return { container };
  },
};
```
- ✅ **gsap.context(scope)** — 将容器引用（例如 `container.value`）作为第二个参数传递，以便像 `.item` 这样的选择器的作用域限于该根。当调用 **ctx.revert()** 时，将跟踪并恢复在回调内创建的所有动画和 ScrollTrigger。
- ✅ **onUnmounted** — 始终调用 **ctx.revert()**，以便补间和 ScrollTriggers 被终止并恢复内联样式。
## Vue 3（脚本设置）
与 `<script setup>` 和 refs 相同的想法：
```javascript
<script setup>
import { onMounted, onUnmounted, ref } from "vue";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

const container = ref(null);
let ctx;

onMounted(() => {
  if (!container.value) return;
  ctx = gsap.context(() => {
    gsap.to(".box", { x: 100 });
    gsap.from(".item", { autoAlpha: 0, stagger: 0.1 });
  }, container.value);
});

onUnmounted(() => {
  ctx?.revert();
});
</script>

<template>
  <div ref="container">
    <div class="box">Box</div>
    <div class="item">Item</div>
  </div>
</template>
```
## 努克斯特 4
> 请参阅 `examples/nuxt/` 了解可运行的 Nuxt 4 项目，该项目具有插件注册、延迟加载和 SSR 安全模式。
使用 **可重用可组合** 来注册 GSAP 插件以及延迟加载应用程序中未广泛使用的插件：
```typescript
// composables/useGSAP.ts
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

const PLUGINS = [
  "CSSRulePlugin",
  "CustomBounce",
  "CustomEase",
  "CustomWiggle",
  "Draggable",
  "DrawSVGPlugin",
  "EaselPlugin",
  "EasePack",
  "Flip",
  "GSDevTools",
  "InertiaPlugin",
  "MorphSVGPlugin",
  "MotionPathHelper",
  "MotionPathPlugin",
  "Observer",
  "Physics2DPlugin",
  "PhysicsPropsPlugin",
  "PixiPlugin",
  "ScrambleTextPlugin",
  "ScrollSmoother",
  "ScrollToPlugin",
  "ScrollTrigger",
  "SplitText",
  "TextPlugin",
] as const;

type Plugins = (typeof PLUGINS)[number];

// In order to dynamically load all the GSAP plugins
const pluginMap = {
  CustomEase: () => import("gsap/CustomEase"),
  Draggable: () => import("gsap/Draggable"),
  CSSRulePlugin: () => import("gsap/CSSRulePlugin"),
  EaselPlugin: () => import("gsap/EaselPlugin"),
  EasePack: () => import("gsap/EasePack"),
  Flip: () => import("gsap/Flip"),
  MotionPathPlugin: () => import("gsap/MotionPathPlugin"),
  Observer: () => import("gsap/Observer"),
  PixiPlugin: () => import("gsap/PixiPlugin"),
  ScrollToPlugin: () => import("gsap/ScrollToPlugin"),
  ScrollTrigger: () => import("gsap/ScrollTrigger"),
  TextPlugin: () => import("gsap/TextPlugin"),
  DrawSVGPlugin: () => import("gsap/DrawSVGPlugin"),
  Physics2DPlugin: () => import("gsap/Physics2DPlugin"),
  PhysicsPropsPlugin: () => import("gsap/PhysicsPropsPlugin"),
  ScrambleTextPlugin: () => import("gsap/ScrambleTextPlugin"),
  CustomBounce: () => import("gsap/CustomBounce"),
  CustomWiggle: () => import("gsap/CustomWiggle"),
  GSDevTools: () => import("gsap/GSDevTools"),
  InertiaPlugin: () => import("gsap/InertiaPlugin"),
  MorphSVGPlugin: () => import("gsap/MorphSVGPlugin"),
  MotionPathHelper: () => import("gsap/MotionPathHelper"),
  ScrollSmoother: () => import("gsap/ScrollSmoother"),
  SplitText: () => import("gsap/SplitText"),
} as const;

type PluginMap = typeof pluginMap;
type Plugins = keyof PluginMap;

// Resolves the module type for a given key, then picks the named export matching the key
// this allows to have the type definitions for autocomplete in your code editor
type PluginModule<K extends Plugins> = Awaited<ReturnType<PluginMap[K]>>;
type PluginExport<K extends Plugins> = PluginModule<K>[K & keyof PluginModule<K>];

export default function () {
  // Register all the GSAP Plugins you want at this point
  gsap.registerPlugin(ScrollTrigger);

  /*
    If you want to lazy load some of the plugins that are
    not widely used in your app (for example in just a couple
    of components or a single route), you can use this method
  */
  async function lazyLoadPlugin<K extends Plugins>(plugin: K): Promise<PluginExport<K>> {
    const loader = pluginMap[plugin];
    const m = await loader();
    const p = (m as any)[plugin];
    gsap.registerPlugin(p);
    return p;
  }

  return {
    gsap,
    ScrollTrigger,
    lazyLoadPlugin,
  };
}
```
通过 `useGSAP()` 访问组件：
```javascript
const { gsap, ScrollTrigger, lazyLoadPlugin } = useGSAP();
```
- ✅ **`useGSAP()`** 提供对 gsap 实例和延迟加载方法的类型化访问。
- ✅ **延迟加载应用程序中未广泛使用的任何插件**（SplitText、MorphSVG 等），以减少初始包大小。
- ✅ 在组件中使用 **gsap.context(scope)** 和 **onUnmounted → ctx.revert()**，与 Vue 3 相同。
## 苗条
DOM 准备好后，使用 **onMount** 运行 GSAP。使用 onMount 中的**返回的清理函数**（或跟踪上下文并在反应块/组件销毁中进行清理）进行恢复。 Svelte 5 使用不同的生命周期；同样的原则也适用：在“mounted”中创建并在“destroyed”中恢复。
```javascript
<script>
  import { onMount } from "svelte";
  import { gsap } from "gsap";
  import { ScrollTrigger } from "gsap/ScrollTrigger";

  let container;

  onMount(() => {
    if (!container) return;
    const ctx = gsap.context(() => {
      gsap.to(".box", { x: 100 });
      gsap.from(".item", { autoAlpha: 0, stagger: 0.1 });
    }, container);
    return () => ctx.revert();
  });
</script>

<div bind:this={container}>
  <div class="box">Box</div>
  <div class="item">Item</div>
</div>
```
- ✅ **bind:this={container}** — 获取对根元素的引用，以便您可以将其传递给 **gsap.context(scope)**。
- ✅ **return () => ctx.revert()** — Svelte 的 onMount 可以返回一个清理函数；在那里调用 **ctx.revert()** ，以便在组件被销毁时运行清理。
## 范围选择器
不要使用可以匹配当前组件之外的元素的全局选择器。始终将 **scope** （容器元素或引用）作为第二个参数传递给 **gsap.context(callback, range)**，以便在回调内运行的任何选择器都仅限于该子树。
- ✅ **gsap.context(() => { gsap.to(".box", ...) }, containerRef)** — `.box` 仅在 `containerRef` 内搜索。
- ❌ 在组件中没有上下文范围的情况下运行 **gsap.to(".box", ...)** 可能会影响其他实例或页面的其余部分。
## 滚动触发器清理
当您在补间/时间线上使用 `scrollTrigger` 配置或 **ScrollTrigger.create()** 时，会创建 ScrollTrigger 实例。它们**包含**在**gsap.context()**中，并在您调用**ctx.revert()**时恢复。所以：
- 在用于补间的同一个 **gsap.context()** 回调中创建 ScrollTriggers。
- 在影响触发位置的布局更改（例如数据加载后）后调用 **ScrollTrigger.refresh()**；在 Vue/Svelte 中，这通常意味着在 DOM 更新之后（例如 Vue 中的 nextTick、Svelte 中的 tick 或异步内容加载之后）。
## 何时创建 vs 删除
|生命周期 |行动|
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **已安装** |在 **gsap.context(scope)** 中创建补间和 ScrollTriggers。                                                  |
| **卸载/销毁** |调用 **ctx.revert()** 以便该上下文中的所有动画和 ScrollTriggers 都被终止并恢复内联样式。 |
不要在组件的设置中或在根元素存在之前运行的同步顶级脚本中创建 GSAP 动画。等待 **onMount** / **onMount** （或等效项），以便容器引用位于 DOM 中。
## 不要
- ❌ 在组件安装之前创建补间或滚动触发器（例如，在没有 onMounted 的设置中）； DOM 节点可能还不存在。
- ❌ 使用不带 **范围** 的选择器字符串（将容器作为第二个参数传递给 gsap.context()），因此选择器不会匹配组件外部的元素。
- ❌ 跳过清理；始终在 onUnmounted / onMount 的返回中调用 **ctx.revert()** ，以便在组件被销毁时动画和 ScrollTriggers 被终止。
- ❌ 在运行每个渲染的组件体内注册插件（这不会伤害任何东西，只是浪费）；在应用程序级别注册一次。
### 了解更多
- **gsap-react** 针对 React 特定模式的技能（useGSAP、contextSafe）。
