# GSAP skills — 参考示例

这些是遵循各 GSAP skill 的最小演示模式：transform、autoAlpha、timeline、ScrollTrigger，以及框架特定模式（React 中的 useGSAP，Vue/Nuxt 中的 onMounted/onUnmounted 与 gsap.context）。

## Vanilla（HTML + JS）

Vanilla 模式：使用 GSAP CDN ESM；用 `gsap.to()` 设置 `x` 和 `autoAlpha`；用 `gsap.timeline()` 设置 defaults 和 position parameter；在 timeline 上使用 ScrollTrigger。

```javascript
import { gsap } from "https://cdn.jsdelivr.net/npm/gsap@3.15.0/index.js";
import { ScrollTrigger } from "https://cdn.jsdelivr.net/npm/gsap@3.15.0/ScrollTrigger.js";

gsap.registerPlugin(ScrollTrigger);

gsap.to("#single", {
  x: 120,
  autoAlpha: 1,
  duration: 0.6,
  ease: "power2"
});

const timeline = gsap.timeline({ defaults: { duration: 0.5, ease: "power2" } });
timeline
  .to(".a", { x: 100 })
  .to(".b", { y: 40 }, "+=0.2")
  .to(".c", { autoAlpha: 0 }, "-=0.1");

const scrollTimeline = gsap.timeline({
  scrollTrigger: {
    trigger: "#scroll-section",
    start: "top center",
    end: "bottom center",
    scrub: true
  }
});
scrollTimeline
  .to(".panel", { x: 100 })
  .to(".panel", { rotation: 5, duration: 0.7 });

// 动态布局变化之后调用：ScrollTrigger.refresh();
```

## React

React 模式：用 `useGSAP()`，传入 `scope: containerRef`；targets 用 refs；不要使用没有 scope 的 selector；组件卸载时自动 cleanup。

```jsx
import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";

gsap.registerPlugin(useGSAP);

function App() {
  const containerRef = useRef(null);
  const boxRef = useRef(null);

  useGSAP(
    () => {
      gsap.to(boxRef.current, { x: 100, duration: 0.6, ease: "power2" });
      gsap.from(".item", { autoAlpha: 0, y: 20, stagger: 0.1 });
    },
    { scope: containerRef }
  );

  return <div ref={containerRef}>...</div>;
}
```

## Vue

Vue 模式：在 `onMounted` 中创建 `gsap.context(() => {}, scope)`；selector 通过 context 限定在容器内；在 `onUnmounted` 中 `ctx?.revert()` 清理。

```vue
<script setup>
import { ref, onMounted, onUnmounted } from "vue";
import { gsap } from "gsap";

const container = ref(null);
let ctx;

onMounted(() => {
  ctx = gsap.context(() => {
    gsap.to(".box", { x: 100, autoAlpha: 1, duration: 0.6, ease: "power2" });
    gsap.from(".item", { autoAlpha: 0, y: 20, stagger: 0.1 });
  }, container.value);
});

onUnmounted(() => {
  ctx?.revert();
});
</script>
```

## Nuxt

Nuxt 模式：集中暴露 `gsap`；注册常用插件；对少量页面才用到的插件使用 lazy import；加载后立刻 `gsap.registerPlugin(plugin)`。

```typescript
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

const pluginMap = {
  ScrollTrigger: () => import("gsap/ScrollTrigger"),
  SplitText: () => import("gsap/SplitText"),
  MorphSVGPlugin: () => import("gsap/MorphSVGPlugin"),
} as const;

type PluginName = keyof typeof pluginMap;

export default function useGsap() {
  gsap.registerPlugin(ScrollTrigger);

  async function lazyLoadPlugin(pluginName: PluginName) {
    const module = await pluginMap[pluginName]();
    const plugin = module[pluginName as keyof typeof module];
    gsap.registerPlugin(plugin);
    return plugin;
  }

  return { gsap, ScrollTrigger, lazyLoadPlugin };
}
```
