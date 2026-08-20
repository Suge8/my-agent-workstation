# GSAP 插件
## 何时使用此技能
在使用或查看使用 GSAP 插件的代码时应用：注册插件、滚动到、翻转/FLIP 动画、可拖动元素、SVG（DrawSVG、MorphSVG、MotionPath）、文本（SplitText、ScrambleText）、物理、缓动插件（CustomEase、EasePack、CustomWiggle、CustomBounce）或 GSDevTools。 ScrollTrigger 有自己的技能（gsap-scrolltrigger）。
**相关技巧：**对于核心补间使用**gsap-core**；对于 ScrollTrigger，请使用 **gsap-scrolltrigger**；对于 React，请使用 **gsap-react**。
## 许可和安装（重要）
每个 GSAP 插件都是**免费**，包括商业用途。自 [Webflow's acquisition of GSAP](https://gsap.com/blog/webflow-GSAP/) 起，Club GSAP 不再是付费层，并且**没有插件需要会员资格、许可证密钥或身份验证令牌** - 这包括以前仅限 Club 的插件（**SplitText**、**MorphSVG** 等）。
- ✅ 安装公共 `gsap` npm 包中的所有内容：`npm install gsap`。包含所有插件 - 将它们导入为 `gsap/SplitText`、`gsap/MorphSVGPlugin` 等。
- ❌不要**使用 GreenSock 身份验证令牌生成 `.npmrc`，建议使用私有 `npm.greensock.com` 注册表，或告诉用户注册 Club GSAP 来访问插件。这些说明已经过时了。
## 注册插件
每个插件注册一次，以便 GSAP（和捆绑器）知道要包含它。对项目中使用的每个插件使用 **gsap.registerPlugin()**：
```javascript
import gsap from "gsap";
import { ScrollToPlugin } from "gsap/ScrollToPlugin";
import { Flip } from "gsap/Flip";
import { Draggable } from "gsap/Draggable";

gsap.registerPlugin(ScrollToPlugin, Flip, Draggable);
```
- ✅ 在任何补间或 API 调用中使用插件之前进行注册。
- ✅ 在 React 中，在顶层注册或在应用程序中注册一次（例如在第一次使用 GSAP 之前）；不要在重新渲染的组件内注册。 useGSAP是一个插件，使用前需要注册。
## 滚动
### 滚动到插件
动画滚动位置（窗口或可滚动元素）。用于“滚动到元素”或“滚动到位置”，无需 ScrollTrigger。
```javascript
gsap.registerPlugin(ScrollToPlugin);

gsap.to(window, { duration: 1, scrollTo: { y: 500 } });
gsap.to(window, { duration: 1, scrollTo: { y: "#section", offsetY: 50 } });
gsap.to(scrollContainer, { duration: 1, scrollTo: { x: "max" } });
```
**ScrollToPlugin — 关键配置（scrollTo 对象）：**
|选项 |描述 |
|--------|-------------|
| `x`、`y` |目标滚动位置（数字），或 `"max"` 以获得最大 |
| __保留_3__ |要滚动到的选择器或元素（用于滚动到视图）|
| `offsetX`、`offsetY` |距目标位置的偏移量（以像素为单位）|
### 滚动更平滑
平滑滚动包装器（平滑原生滚动）。需要 ScrollTrigger 和特定的 DOM 结构（内容包装器 + 平滑包装器）。当需要平滑的动量式滚动时使用。请参阅 GSAP 文档进行设置；在 ScrollTrigger 之后注册。 DOM 结构如下所示：
```html
<body>
	<div id="smooth-wrapper">
		<div id="smooth-content">
			<!--- ALL YOUR CONTENT HERE --->
		</div>
	</div>
	<!-- position: fixed elements can go outside --->
</body>
```
## DOM / 用户界面
### 翻动
使用 `Flip.getState()` 捕获状态，然后应用更改（例如布局或类更改），然后使用 `Flip.from()` 将动画从先前状态更改为新状态（翻转：首先、最后、反转、播放）。在两种布局状态（列表、网格、展开/折叠）之间设置动画时使用。
```javascript
gsap.registerPlugin(Flip);

const state = Flip.getState(".item");
// change DOM (reorder, add/remove, change classes)
Flip.from(state, { duration: 0.5, ease: "power2.inOut" });
```
**Flip — 关键配置 (Flip.from vars):**
|选项 |描述 |
|--------|-------------|
| __保留_0__ |在翻转过程中使用 `position: absolute` （默认值：`false`） |
| __保留_3__ |如果为 true，则仅测量子级的第一级（对于嵌套转换更好）|
| __保留_4__ |当 true 时，缩放元素以适应（避免拉伸）；默认 `true` |
| __保留_6__ |如果为 true，则仅对位置/比例进行动画处理（更快，不太准确）|
| `duration`、`ease` |标准补间选项 |
#### 更多信息
__保留_0__
### 可拖动
使元素可通过鼠标/触摸进行拖动、旋转或投掷。用于滑块、卡片、可重新排序列表或任何拖动交互。
```javascript
gsap.registerPlugin(Draggable, InertiaPlugin);

Draggable.create(".box", { type: "x,y", bounds: "#container", inertia: true });
Draggable.create(".knob", { type: "rotation" });
```
**可拖动 - 关键配置选项：**
|选项 |描述 |
|--------|-------------|
| __保留_0__ | `"x"`、`"y"`、`"x,y"`、`"rotation"`、`"scroll"` |
| __保留_6__ |限制拖动的元素、选择器或 `{ minX, maxX, minY, maxY }` |
| __保留_8__ | `true` 启用投掷/动量（需要 InertiaPlugin）|
| __保留_10__ | 0–1；拖动超过界限时的阻力|
| __保留_11__ |拖动期间的 CSS 光标 |
| `onDragStart`、`onDrag`、`onDragEnd` |回调；接收事件和目标|
| `onThrowUpdate`、`onThrowComplete` |惯性激活时的回调 |
### 惯性（InertiaPlugin）
与 Draggable 一起使用以获取释放后的动量，或跟踪任何对象的任何属性的惯性/速度，以便它可以使用简单的补间无缝滑行到停止位置。使用 `inertia: true` 时向 Draggable 注册：
```javascript
gsap.registerPlugin(Draggable, InertiaPlugin);
Draggable.create(".box", { type: "x,y", inertia: true });
```
或者跟踪属性的速度：
```javascript
InertiaPlugin.track(".box", "x");
```
然后使用 `"auto"` 继续当前速度并滑翔至停止位置：
```javascript
gsap.to(obj, { inertia: { x: "auto" } });
```
### 观察者
规范跨设备的指针和滚动输入。用于滑动、滚动方向或自定义手势逻辑，无需像 ScrollTrigger 那样直接绑定到滚动位置。
```javascript
gsap.registerPlugin(Observer);

Observer.create({
  target: "#area",
  onUp: () => {},
  onDown: () => {},
  onLeft: () => {},
  onRight: () => {},
  tolerance: 10
});
```
**观察者 - 关键配置选项：**
|选项 |描述 |
|--------|-------------|
| __保留_0__ |要观察的元素或选择器 |
| `onUp`、`onDown`、`onLeft`、`onRight` |当滑动/滚动超过该方向的公差时回调 |
| __保留_5__ |检测到方向之前的像素；默认 10 |
| __保留_6__ | `"touch"`、`"pointer"` 或 `"wheel"`（默认值：`"touch,pointer"`）|
## 文本
### 分割文本
将元素的文本拆分为字符、单词和/或线条（每个都在其自己的元素中）以实现交错或按单元动画。在逐字符、逐字或逐行制作文本动画时使用。返回具有 **chars**、**words**、**lines** 的实例（当设置 `mask` 时，还返回 **masks**）。使用 **revert()** 恢复原始标记或让 **gsap.context()** 恢复。与 **gsap.context()**、**matchMedia()** 和 **useGSAP()** 集成。 API：**SplitText.create(target, vars)**（目标 = 选择器、元素或数组）。
```javascript
gsap.registerPlugin(SplitText);

const split = SplitText.create(".heading", { type: "words, chars" });
gsap.from(split.chars, { opacity: 0, y: 20, stagger: 0.03, duration: 0.4 });
// later: split.revert() or let gsap.context() cleanup revert
```
使用 **onSplit()** (v3.13.0+)，当使用 **autoSplit** 时，动画会在每次分割和重新分割时运行；从 **onSplit()** 返回补间/时间线可以让 SplitText 清理并同步重新分割的进度：
```javascript
SplitText.create(".split", {
  type: "lines",
  autoSplit: true,
  onSplit(self) {
    return gsap.from(self.lines, { y: 100, opacity: 0, stagger: 0.05, duration: 0.5 });
  }
});
```
**SplitText — 关键配置（SplitText.create vars）：**
|选项 |描述 |
|--------|-------------|
| **类型** |以逗号分隔：`"chars"`、`"words"`、`"lines"`。默认 `"chars,words,lines"`。仅分割性能所需的内容（例如 `"words, chars"` 如果不使用行）。避免仅使用字符而没有单词/行，或使用 **smartWrap: true** 来防止奇怪的换行符。 |
| **charsClass**、**wordsClass**、**linesClass** |每个分割元素上的 CSS 类。追加 `"++"` 以添加递增的类（例如 `linesClass: "line++"` → `line1`、`line2`、...）。 |
| **咏叹调** | `"auto"`（默认）、`"hidden"` 或 `"none"`。辅助功能：`"auto"` 在 split 元素上添加 `aria-label`，在 line/word/char 元素上添加 `aria-hidden`，以便屏幕阅读器读取标签； `"hidden"` 对读者隐藏所有内容； `"none"` 使 aria 保持不变。如果必须公开嵌套链接/语义，请使用 `"none"` 加上仅限屏幕阅读器的副本。 |
| **自动分割** |当 `true` 时，当字体完成加载或元素宽度更改（并且行被分割）时恢复并重新分割，避免错误的换行符。 **动画必须在 onSplit() 内部创建**，以便它们针对新分割的元素； **从 **onSplit()** 返回**动画，以便在重新分割时自动清理和时间同步。 |
| **onSplit（自我）** |分割完成时的回调（如果 **autoSplit** 为 `true`，则每次重新分割时）。接收 SplitText 实例。返回 GSAP 补间或时间线可以在重新分割时自动恢复/同步该动画。 |
| **面具** | `"lines"`、`"words"` 或 `"chars"`。使用 `overflow: clip` 将每个单元包装在一个额外的元素中，以实现遮罩/显示效果。只有一种类型；访问实例的 **masks** 数组上的包装器（如果设置了类，则使用类 `-mask` ）。 |
| **标签** |包装元素标签；默认 `"div"`。使用 `"span"` 进行内联（注意：旋转/缩放等变换可能不会在某些浏览器中的内联元素上呈现）。 |
| **深度切片** |当 `true` （默认）时，跨多行的嵌套元素（例如 `<strong>`）将被细分，因此行不会垂直拉伸。仅适用于分割线时。 |
| **忽略** |选择器或元素保持不分割（例如 `ignore: "sup"`）。 |
| **智能包裹** |仅拆分 **字符** 时，将单词包装在 `white-space: nowrap` 范围内以避免中间单词换行。如果单词或行被分割，则忽略。默认 `false`。 |
| **字分隔符** |字边界：字符串（默认 `" "`）、RegExp 或 `{ delimiter: RegExp, replaceWith: string }` 用于自定义拆分（例如，主题标签的零宽度连接符或非拉丁语）。 |
| **prepareText（文本，父级）** |接收原始文本和父元素的函数；在分割之前返回修改后的文本（例如，为没有空格的语言插入分隔标记）。 |
| **属性索引** |当 `true` 时，在每个分割元素上添加带有索引的 CSS 变量（例如 `--word: 1`、`--char: 2`）。 |
| **减少空白** |折叠连续空格；默认 `true`。从 v3.13.0 开始，还支持换行符，并且可以为 `<pre>` 插入 `<br>`。 |
| **onRevert** |实例恢复时的回调。 |
**提示：** 仅拆分动画内容（例如，如果仅对单词进行动画处理，则跳过字符）。对于自定义字体，在加载后进行分割（例如 `document.fonts.ready.then(...)`）或使用 **autoSplit: true** 和 **onSplit()**。为了避免分割字符时字距调整，请使用 CSS `font-kerning: none; text-rendering: optimizeSpeed;`。避免 `text-wrap: balance`；它会干扰分裂。 SplitText 不支持 SVG `<text>`。
**了解更多：** [SplitText](https://gsap.com/docs/v3/Plugins/SplitText/)
### 打乱文本
使用打乱/故障效果对文本进行动画处理。在通过扰乱显示或过渡文本时使用。
```javascript
gsap.registerPlugin(ScrambleTextPlugin);

gsap.to(".text", {
  duration: 1,
  scrambleText: { text: "New message", chars: "01", revealDelay: 0.5 }
});
```
## SVG
### DrawSVG（DrawSVGPlugin）
通过动画 `stroke-dashoffset` / `stroke-dasharray` 显示或隐藏 SVG 元素的笔画。适用于 `<path>`、`<line>`、`<polyline>`、`<polygon>`、`<rect>`、`<ellipse>`。在“绘制”或“擦除”笔画时使用。
**drawSVG 值：** 描述笔画沿路径的 **可见段**（开始和结束位置），而不是“随时间从 A 到 B 的动画”。格式：`"start end"`（百分比或长度）。示例：`"0% 100%"` = 全行程； `"20% 80%"` = 行程仅在 20% 到 80% 之间（两端有间隙）。补间动画从元素的 **当前** 段到 **目标** 段 - 例如`gsap.to("#path", { drawSVG: "0% 100%" })` 从现在的状态变为全行程。单值（例如 `0`、`"100%"`）表示起始值为 0：`"100%"` 相当于 `"0% 100%"`。
**必需：** 元素必须具有可见笔画 — 在 CSS 中或作为 SVG 属性设置 `stroke` 和 `stroke-width` ；否则什么也不会被绘制。
```javascript
gsap.registerPlugin(DrawSVGPlugin);

// draw from nothing to full stroke
gsap.from("#path", { duration: 1, drawSVG: 0 });
// or explicit segment: from 0–0 to 0–100%
gsap.fromTo("#path", { drawSVG: "0% 0%" }, { drawSVG: "0% 100%", duration: 1 });
// stroke only in the middle (gaps at ends)
gsap.to("#path", { duration: 1, drawSVG: "20% 80%" });
```
**注意事项：** 仅影响描边（不影响填充）。优先选择单段 `<path>` 元素；多段路径在某些浏览器中可能会呈现奇怪的效果。 `<use>` 的内容无法进行可视化更改。 **DrawSVGPlugin.getLength(element)** 和 **DrawSVGPlugin.getPosition(element)** 返回笔划长度和当前位置。
**了解更多：** [DrawSVG](https://gsap.com/docs/v3/Plugins/DrawSVGPlugin)
### MorphSVG (MorphSVGPlugin)
通过设置 `d` 属性（路径数据）的动画，将一种 SVG 形状变形为另一种形状。开始和结束形状不需要相同数量的点 - MorphSVG 转换为三次贝塞尔曲线并根据需要添加点。用于图标到图标的变形、形状过渡或基于路径的动画。适用于 `<path>`、`<polyline>` 和 `<polygon>`； `<circle>`、`<rect>`、`<ellipse>` 和 `<line>` 在内部转换或通过 **MorphSVGPlugin.convertToPath(selector | element)** （用 `<path>` 替换 DOM 中的元素）。
**morphSVG 值：** 可以是 **选择器**（例如 `"#lightning"`）、**元素**、**原始路径数据**（例如 `"M47.1,0.8 73.3,0.8..."`），或者对于多边形/折线来说是 **点字符串**（例如 `"240,220 240,70 70,70 70,220"`）。对于完整配置，请使用 **对象形式** 和 **shape** 作为唯一必需的属性。
```javascript
gsap.registerPlugin(MorphSVGPlugin);

// convert primitives to path first if needed:
MorphSVGPlugin.convertToPath("circle, rect, ellipse, line");

gsap.to("#diamond", { duration: 1, morphSVG: "#lightning", ease: "power2.inOut" });
// object form:
gsap.to("#diamond", {
  duration: 1,
  morphSVG: { shape: "#lightning", type: "rotational", shapeIndex: 2 }
});

```
**MorphSVG — 关键配置（morphSVG 对象）：**
|选项 |描述 |
|--------|-------------|
| **形状** | _（必需。）_ 目标形状：选择器、元素或原始路径字符串。 |
| **类型** | `"linear"`（默认）或 `"rotational"`。旋转使用角度/长度插值，可以避免变形过程中的扭结；当线性看起来错误时尝试一下。 |
| **地图** |段的匹配方式：`"size"`（默认）、`"position"` 或 `"complexity"`。当开始/结束段未对齐时使用；如果都不起作用，则分成多个路径并对每个路径进行变形。 |
| **形状索引** |起始路径中的点映射到结束路径中的第一个点的偏移（避免形状“交叉”或反转）。单段路径的数量； **数组** 用于多段（例如 `[5, 1, -8]`）。负数反转该部分。使用 **shapeIndex: "log"** 一次记录自动计算的值，然后将数字/数组粘贴到补间中。 **findShapeIndex(start, end)**（单独的实用程序）提供交互式 UI 来查找合适的值。仅适用于闭合路径。 |
| **平滑** | （v3.14+）。添加平滑点。数字（例如 `80`）、`"auto"` 或对象：`{ points: 40 \| "auto", redraw: true \| false, persist: true \| false }`。 `redraw: false` 保留原始锚点（完美的保真度，较小的均匀间距）。 `persist: false` 在补间结束时删除添加的点。当默认变形看起来锯齿状或不自然时使用。 |
| **曲线模式** |布尔值（v3.14+）。插入控制手柄角度/长度而不是原始 x/y，以避免曲线上扭结。尝试一下变形是否有中间变形扭结。 |
| **起源** | **类型的旋转原点：“旋转”**。字符串： `"50% 50%"` （默认）或 `"20% 60%, 35% 90%"` 对于不同的开始/结束来源。 |
| **精确** |输出路径数据的小数位；默认 `2`。 |
| **预编译** |预先计算的路径字符串数组（或使用 **precompile: "log"** 一次，从控制台复制）。跳过昂贵的启动计算；用于非常复杂的变形。仅适用于 `<path>` （首先转换多边形/折线）。 |
| **渲染** |函数（rawPath，target）调用每个更新 - 例如绘制到画布上。 RawPath 是一个段数组（每个段 = 交替 x,y 三次贝塞尔坐标数组）。 |
| **更新目标** |当使用 **render** （例如仅画布）时，设置 **updateTarget: false** 以便原始 `<path>` 不会更新。 **MorphSVGPlugin.defaultUpdateTarget** 设置默认值。 |
**实用工具：** **MorphSVGPlugin.convertToPath(selector | element)** 将圆/矩形/椭圆/线/多边形/折线转换为 DOM 中的 `<path>` 。 **MorphSVGPlugin.rawPathToString(rawPath)** 和 **stringToRawPath(d)** 在路径字符串和原始数组之间进行转换。该插件将原始 `d` 存储在目标上（例如，用于补间：`morphSVG: "#originalId"` 或相同元素）。
**提示：** 对于扭曲或倒转的变形，设置 **shapeIndex** （使用 `"log"` 或 findShapeIndex()）。对于多段路径，**shapeIndex** 是一个数组（每段一个值）。仅当第一帧较慢时才进行预编译；它不会修复补间期间的卡顿（简化 SVG 或根据需要减小大小）。
**了解更多：** [MorphSVG](https://gsap.com/docs/v3/Plugins/MorphSVGPlugin)
### 运动路径（运动路径插件）
沿 SVG 路径对元素进行动画处理。沿路径（例如曲线或自定义路线）移动对象时使用。
```javascript
gsap.registerPlugin(MotionPathPlugin);

gsap.to(".dot", {
  duration: 2,
  motionPath: { path: "#path", align: "#path", alignOrigin: [0.5, 0.5] }
});
```
**MotionPath — 关键配置（motionPath 对象）：**
|选项 |描述 |
|--------|-------------|
| __保留_0__ | SVG 路径元素、选择器或路径数据字符串 |
| __保留_1__ |将目标对齐到 | 的路径元素或选择器
| __保留_2__ | `[x, y]` 原点 (0–1)；默认 `[0.5, 0.5]` |
| __保留_5__ |旋转元素以遵循路径切线 |
| __保留_6__ | 0–2；路径平滑|
### 运动路径助手
MotionPath 的可视化编辑器（对齐、偏移）。在开发过程中使用来调整路径对齐。
```javascript
gsap.registerPlugin(MotionPathPlugin, MotionPathHelperPlugin);

const helper = MotionPathHelper.create(".dot", "#path", { end: 0.5 });
// adjust in UI, then use helper.path or helper.getProgress() in your animation
```
## 缓动
### 自定义轻松
自定义缓动曲线（三次贝塞尔曲线或 SVG 路径）。当内置缓动不够时使用。 gsap-core 涵盖了基本用法；使用时注册：
```javascript
gsap.registerPlugin(CustomEase);
const ease = CustomEase.create("name", ".17,.67,.83,.67");
gsap.to(".el", { x: 100, ease: ease, duration: 1 });
```
### 轻松包
添加更多命名缓动（例如 SlowMo、RoughEase、ExpoScaleEase）。在补间中注册并使用缓动名称。
### 自定义摆动
缓和摆动/摇动。当值应该“摆动”（多次振荡）时使用。
### 自定义弹跳
具有可配置强度的弹跳式缓动。
## 物理
###Physics2D（Physics2DPlugin）
2D 物理（速度、角度、重力）。在使用简单的物理动画（例如射弹、弹跳）时使用。
```javascript
gsap.registerPlugin(Physics2DPlugin);

gsap.to(".ball", {
  duration: 2,
  physics2D: {
    velocity: 250,
    angle: 80,
    gravity: 500
  }
});
```
### 物理道具（PhysicsPropsPlugin）
将物理学应用于属性值。用于物理驱动的属性动画。
```javascript
gsap.registerPlugin(PhysicsPropsPlugin);

gsap.to(".obj", {
  duration: 2,
  physicsProps: {
    x: { velocity: 100, end: 300 },
    y: { velocity: -50, acceleration: 200 }
  }
});
```
## 发展
### GSDevTools
用于清理时间线、切换动画和调试的 UI。仅在开发期间使用；不发货。注册并创建具有时间线参考的实例。
```javascript
gsap.registerPlugin(GSDevTools);
GSDevTools.create({ animation: tl });
```
## 其他
### Pixi（Pixi插件）
将 GSAP 与 PixiJS 集成，以对 Pixi 显示对象进行动画处理。使用 GSAP 对 Pixi 对象进行动画处理时进行注册。
```javascript
gsap.registerPlugin(PixiPlugin);

const sprite = new PIXI.Sprite(texture);
gsap.to(sprite, { pixi: { x: 200, y: 100, scale: 1.5 }, duration: 1 });
```
## 最佳实践
- ✅ 在首次使用之前使用 **gsap.registerPlugin()** 注册每个插件。
- ✅ 使用 **Flip.getState()** → DOM 更改 → **Flip.from()** 进行布局转换；使用 **Draggable** + **InertiaPlugin** 进行动量拖动。
- ✅ 当组件卸载或元素被删除时恢复插件实例（例如 `SplitTextInstance.revert()`）。
## 不要
- ❌ 在补间或 API 中使用插件，无需先注册 (**gsap.registerPlugin()**)。
- ❌ 将 GSDevTools 或仅用于开发的插件交付到生产环境。
### 了解更多
__保留_0__
