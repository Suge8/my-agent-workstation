---
name: gsap
description: GSAP、GreenSock、ScrollTrigger、时间线、滚动或 React GSAP 动画任务；按需读取本地参考。
---

# GSAP

这是 GSAP 的唯一 active skill 入口。按任务读取需要的文件。

## 路由

- 核心补间、缓动、stagger、响应式动画、`prefers-reduced-motion`：`gsap-core.md`
- 多步骤编排、时间线、标签、position parameter、嵌套、播放控制：`gsap-timeline.md`
- ScrollTrigger、滚动触发、pin、scrub、视差、刷新、清理：`gsap-scrolltrigger.md`
- React、Next.js、`@gsap/react`、`useGSAP()`、refs、scope、卸载清理：`gsap-react.md`
- Vue、Svelte、Nuxt、SvelteKit、生命周期、`gsap.context()` 清理：`gsap-frameworks.md`
- 插件、SplitText、MorphSVG、Flip、ScrollSmoother、ScrollToPlugin、Draggable、Observer：`gsap-plugins.md`
- `gsap.utils`、clamp、mapRange、normalize、interpolate、random、snap、toArray、wrap、pipe：`gsap-utils.md`
- 性能、60fps、jank、transform、will-change、batch、ScrollTrigger 性能：`gsap-performance.md`
- 最小参考示例：`examples.md`

## 事实

- 从公开 npm 包安装：`npm install gsap`。
- React 里安装：`npm install @gsap/react`。
- 不需要 `.npmrc`、认证 token、私有 registry 或 Club 会员。
- 插件使用前注册：`gsap.registerPlugin(ScrollTrigger)`。
- 涉及 DOM 生命周期时必须清理：React 用 `useGSAP()`；Vue/Svelte/Nuxt 用 `gsap.context()` 并在卸载时 `revert()`。
- 涉及可访问性时尊重 `prefers-reduced-motion`。
