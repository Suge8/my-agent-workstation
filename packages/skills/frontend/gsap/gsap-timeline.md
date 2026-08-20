# GSAP 时间表
## 何时使用此技能
在构建多步骤动画、按顺序或并行协调多个补间时，或者在用户询问 GSAP 中的时间线、排序或关键帧样式动画时应用。
**相关技能：**对于单个补间和缓动使用**gsap-core**；对于滚动驱动的时间线，请使用 **gsap-scrolltrigger**；对于 React，请使用 **gsap-react**。
## 创建时间线
```javascript
const tl = gsap.timeline();
tl.to(".a", { x: 100, duration: 1 })
  .to(".b", { y: 50, duration: 0.5 })
  .to(".c", { opacity: 0, duration: 0.3 });
```
默认情况下，补间是逐个**附加**的。使用 **位置参数** 在特定时间或相对于其他补间放置补间。
## 位置参数
第三个参数（或变量中的位置属性）控制放置：
- **绝对**：`1` — 从 1 秒开始。
- **相对（默认）**：`"+=0.5"` — 结束后 0.5 秒； `"-=0.2"` — 结束前 0.2 秒。
- **标签**：`"labelName"` — 在该标签处； `"labelName+=0.3"` — 标签后 0.3 秒。
- **放置**：`"<"` — 在最近添加的动画开始时开始； `">"` — 当最近添加的动画结束时开始（默认）； `"<0.2"` — 最近添加的动画开始后 0.2 秒。
示例：
```javascript
tl.to(".a", { x: 100 }, 0);           // at 0
tl.to(".b", { y: 50 }, "+=0.5");      // 0.5s after last end
tl.to(".c", { opacity: 0 }, "<");     // same start as previous
tl.to(".d", { scale: 2 }, "<0.2");    // 0.2s after previous start
```
## 时间线默认值
将默认值传递到时间线中，以便所有子补间继承：
```javascript
const tl = gsap.timeline({ defaults: { duration: 0.5, ease: "power2.out" } });
tl.to(".a", { x: 100 }).to(".b", { y: 50 }); // both use 0.5s and power2.out
```
## 时间线选项（构造函数）
- **paused: true** — 创建已暂停；调用 `.play()` 来启动。
- **重复**、**yoyo** — 与补间相同；适用于整个时间线。
- **onComplete**、**onStart**、**onUpdate** — 时间线级回调。
- **默认** - 变量合并到每个子补间中。
## 标签
添加和使用标签以实现可读、可维护的排序：
```javascript
tl.addLabel("intro", 0);
tl.to(".a", { x: 100 }, "intro");
tl.addLabel("outro", "+=0.5");
tl.to(".b", { opacity: 0 }, "outro");
tl.play("outro");  // start from "outro"
tl.tweenFromTo("intro", "outro"); // pauses the timeline and returns a new Tween that animates the timeline's playhead from intro to outro with no ease.
```
## 嵌套时间线
时间线可以包含其他时间线。
```javascript
const master = gsap.timeline();
const child = gsap.timeline();
child.to(".a", { x: 100 }).to(".b", { y: 50 });
master.add(child, 0);
master.to(".c", { opacity: 0 }, "+=0.2");
```
## 控制播放
- **tl.play()** / **tl.pause()**
- **tl.reverse()** / **tl.progress(1)** 然后 **tl.reverse()**
- **tl.restart()** — 从头开始。
- **tl.time(2)** — 寻找 2 秒。
- **tl.progress(0.5)** — 寻求 50%。
- **tl.kill()** — 杀死时间线及其子时间线（默认情况下）。
## 官方 GSAP 最佳实践
- ✅ 更喜欢排序的时间表
- ✅ 使用**位置参数**（第三个参数）在特定时间或相对于标签放置补间。
- ✅ 添加带有 `addLabel()` 的**标签**，以实现可读、可维护的排序。
- ✅ 将**默认**传递到时间线构造函数中，以便子补间继承持续时间、缓动等。
- ✅ 将 ScrollTrigger 放在时间轴（或顶级补间）上，而不是放在时间线内的补间上。
## 不要
- ❌当**时间线**可以对它们进行排序时，具有**延迟**的连锁动画；更喜欢 `gsap.timeline()` 和多步动画的位置参数。
- ❌ 当许多子补间共享相同的持续时间或缓动时，请忘记传递**默认值**（例如 `defaults: { duration: 0.5, ease: "power2.out" }`）。
- ❌忘记时间线构造函数上的**持续时间**与补间持续时间不同；时间线“持续时间”由其子项决定。
- ❌ 包含 ScrollTrigger 的嵌套动画； ScrollTriggers 只能位于顶级补间/时间轴上。
