# gsap.utils
## 何时使用此技能
在编写或审查使用 **gsap.utils** 进行数学、数组/集合处理、单元解析或动画中的值映射的代码时应用（例如，将滚动映射到值、随机化、捕捉到网格或规范化输入）。
**相关技巧：**构建动画时与**gsap-core**、**gsap-timeline**和**gsap-scrolltrigger**一起使用； CustomEase 和其他缓动实用程序位于 **gsap-plugins** 中。
## 概述
**gsap.utils** 提供纯助手；无需注册。在补间变量（例如基于函数的值）、ScrollTrigger 或 Observer 回调中或在驱动 GSAP 的任何 JS 中使用。所有这些都在 **gsap.utils** 上（例如 `gsap.utils.clamp()`）。
**省略值：函数形式。**许多实用程序接受要转换的值作为**最后一个**参数。如果省略该参数，util 将返回一个稍后接受该值的 **函数**。当您需要使用相同配置（例如在 mousemove 处理程序或补间回调中）钳位、映射、规范化或捕捉多个值时，请使用函数形式。 **例外：random()** — 传递 **true** 作为最后一个参数以获取可重用函数（不要省略该值）；请参阅 [random()](https://gsap.com/docs/v3/GSAP/UtilityMethods/random())。
```javascript
// With value: returns the result
gsap.utils.clamp(0, 100, 150); // 100

// Without value: returns a function you call with the value later
let c = gsap.utils.clamp(0, 100);
c(150);  // 100
c(-10);  // 0
```
## 钳位和范围
### 钳位（最小值、最大值、值？）
限制最小值和最大值之间的值。省略 **value** 以获取函数：`clamp(min, max)(value)`。
```javascript
gsap.utils.clamp(0, 100, 150); // 100
gsap.utils.clamp(0, 100, -10); // 0

let clampFn = gsap.utils.clamp(0, 100);
clampFn(150); // 100
```
### mapRange（inMin，inMax，outMin，outMax，值？）
将值从一个范围映射到另一个范围。将滚动位置、进度 (0–1) 或输入范围转换为动画范围时使用。省略 **value** 以获取函数：`mapRange(inMin, inMax, outMin, outMax)(value)`。
```javascript
gsap.utils.mapRange(0, 100, 0, 500, 50);  // 250
gsap.utils.mapRange(0, 1, 0, 360, 0.5);   // 180 (progress to degrees)

let mapFn = gsap.utils.mapRange(0, 100, 0, 500);
mapFn(50);  // 250
```
### 标准化（最小值、最大值、值？）
返回给定范围标准化为 0–1 的值。当目标范围为 0–1 时映射的逆。省略 **value** 以获取函数：`normalize(min, max)(value)`。
```javascript
gsap.utils.normalize(0, 100, 50);   // 0.5
gsap.utils.normalize(100, 300, 200); // 0.5

let normFn = gsap.utils.normalize(0, 100);
normFn(50); // 0.5
```
### 插值（开始、结束、进度？）
以给定进度 (0–1) 在两个值之间进行插值。使用匹配的键处理数字、颜色和对象。省略 **progress** 以获取函数：`interpolate(start, end)(progress)`。
```javascript
gsap.utils.interpolate(0, 100, 0.5);       // 50
gsap.utils.interpolate("#ff0000", "#0000ff", 0.5); // mid color
gsap.utils.interpolate({ x: 0, y: 0 }, { x: 100, y: 50 }, 0.5); // { x: 50, y: 25 }

let lerp = gsap.utils.interpolate(0, 100);
lerp(0.5); // 50
```
## 随机和捕捉
### 随机（最小值，最大值[，snapIncrement，returnFunction]）/随机（数组[，returnFunction]）
返回**最小值**–**最大值**范围内的随机数，或**数组**中的随机元素。可选 **snapIncrement** 将结果捕捉到最接近的倍数（例如 `5` → 5 的倍数）。 **要获得可重用的函数**，请传递 **true** 作为最后一个参数 (**returnFunction**)；返回的函数不带参数，每次都会返回一个新的随机值。这是唯一使用 `true` 作为函数形式而不是省略该值的实用程序。
```javascript
// immediate value: number in range
gsap.utils.random(-100, 100);        // e.g. 42.7
gsap.utils.random(0, 500, 5);        // 0–500, snapped to nearest 5

// reusable function: pass true as last argument
let randomFn = gsap.utils.random(-200, 500, 10, true);
randomFn();  // random value in range, snapped to 10
randomFn();  // another random value

// array: pick one value at random
gsap.utils.random(["red", "blue", "green"]);  // "red", "blue", or "green"
let randomFromArray = gsap.utils.random([0, 100, 200], true);
randomFromArray();  // 0, 100, or 200
```
**补间变量中的字符串形式：**使用 `"random(-100, 100)"`、`"random(-100, 100, 5)"` 或 `"random([0, 100, 200])"`； GSAP 根据目标对其进行评估。
```javascript
gsap.to(".box", { x: "random(-100, 100, 5)", duration: 1 });
gsap.to(".item", { backgroundColor: "random([red, blue, green])" });
```
### snap(snapTo, 值？)
将值捕捉到最接近的 **snapTo** 倍数，或捕捉到允许值数组中最接近的值。省略 **value** 以获取函数：`snap(snapTo)(value)`（或 `snap(snapArray)(value)`）。
```javascript
gsap.utils.snap(10, 23);     // 20
gsap.utils.snap(0.25, 0.7);  // 0.75
gsap.utils.snap([0, 100, 200], 150); // 100 or 200 (nearest in array)

let snapFn = gsap.utils.snap(10);
snapFn(23); // 20
```
在补间中使用网格或基于步骤的动画：
```javascript
gsap.to(".x", { x: 200, snap: { x: 20 } });
```
### 随机播放（数组）
返回一个新数组，其中具有随机顺序的相同元素。用于随机化顺序（例如，从“随机”与副本错开）。
```javascript
gsap.utils.shuffle([1, 2, 3, 4]); // e.g. [3, 1, 4, 2]
```
### 分发（配置）
**返回一个函数**，该函数根据每个目标在数组（或网格）中的位置为其分配一个值。内部用于高级交错；每当您需要将值分布在多个元素（例如比例、不透明度、x、延迟）时，请使用它。返回的函数接收 `(index, target, targets)` — 手动调用它或将结果直接传递到补间； GSAP 将使用索引、元素和数组为每个目标调用它。
**配置（全部可选）：**
|物业 |类型 |描述 |
|----------|------|-------------|
| __保留_0__ |数量 |起始值。默认 `0`。 |
| __保留_2__ |数量 |分布在所有目标上的总计（添加到基础）。例如。 `amount: 1` 有 100 个目标 → 每个目标之间为 0.01。使用 **each** 来为每个目标设置固定步骤。 |
| __保留_4__ |数量 |每个目标之间添加的量（添加到基础）。例如。 `each: 1` 有 4 个目标 → 0、1、2、3。使用 **amount** 来分割总数。 |
| __保留_6__ |号码\|字符串\|数组|分配开始的位置：索引，或 `"start"`、`"center"`、`"edges"`、`"random"`、`"end"` 或类似 `[0.25, 0.75]` 的比率。默认 `0`。 |
| __保留_14__ |字符串\|数组|使用网格位置而不是平面索引：`[rows, columns]`（例如`[5, 10]`）或`"auto"`进行检测。对于平面数组省略。 |
| __保留_18__ |字符串|对于网格：限制为一个轴（`"x"` 或 `"y"`）。 |
| __保留_21__ |轻松|沿着缓动曲线分布值（例如 `"power1.inOut"`）。默认 `"none"`。 |
**在补间中：** 将 `distribute(config)` 的结果作为属性值传递； GSAP 使用 `(index, target, targets)` 为每个目标调用该函数。
```javascript
// Scale: middle elements 0.5, outer edges 3 (amount 2.5 distributed from center)
gsap.to(".class", {
  scale: gsap.utils.distribute({
    base: 0.5,
    amount: 2.5,
    from: "center"
  })
});
```
**手动使用：** 使用 `(index, target, targets)` 调用返回的函数以获取该索引的值。
```javascript
const distributor = gsap.utils.distribute({
  base: 50,
  amount: 100,
  from: "center",
  ease: "power1.inOut"
});
const targets = gsap.utils.toArray(".box");
const valueForIndex2 = distributor(2, targets[2], targets);
```
有关更多信息，请参阅 [distribute()](https://gsap.com/docs/v3/GSAP/UtilityMethods/distribute/)。
## 单位和解析
### 获取单位（值）
返回值的单位字符串（例如 `"px"`、`"%"`、`"deg"`）。在标准化或转换值时使用。
```javascript
gsap.utils.getUnit("100px");   // "px"
gsap.utils.getUnit("50%");     // "%"
gsap.utils.getUnit(42);        // "" (unitless)
```
### 统一（值，单位）
将单位附加到数字，或者按原样返回值（如果已有单位）。在构建 CSS 值或补间最终值时使用。
```javascript
gsap.utils.unitize(100, "px");  // "100px"
gsap.utils.unitize("2rem", "px"); // "2rem" (unchanged)
```
### splitColor(颜色, 返回HSL?)
将颜色字符串转换为数组：**[red, green, blue]** (0–255)，或 **[red, green, blue, alpha]**（当 alpha 存在或需要时，RGBA 为 4 个元素）。传递 **true** 作为第二个参数 (**returnHSL**) 来获取 **[色调、饱和度、亮度]** 或 **[色调、饱和度、亮度、alpha]** (HSL/HSLA)。适用于 `"rgb()"`、`"rgba()"`、`"hsl()"`、`"hsla()"`、十六进制和命名颜色（例如 `"red"`）。在设置颜色组件动画或构建渐变时使用。请参阅[splitColor()](https://gsap.com/docs/v3/GSAP/UtilityMethods/splitColor/)。
```javascript
gsap.utils.splitColor("red");                    // [255, 0, 0]
gsap.utils.splitColor("#6fb936");                // [111, 185, 54]
gsap.utils.splitColor("rgba(204, 153, 51, 0.5)"); // [204, 153, 51, 0.5] (4 elements)
gsap.utils.splitColor("#6fb936", true);          // [94, 55, 47] (HSL: hue, saturation, lightness)
```
## 数组和集合
### 选择器（范围）
返回一个作用域选择器函数，该函数仅查找给定元素（或 ref）内的元素。在组件中使用，这样像 `".box"` 这样的选择器只匹配该组件的后代，而不是整个文档。接受 DOM 元素或引用（例如 React ref；句柄 `.current`）。
```javascript
const q = gsap.utils.selector(containerRef);
q(".box");        // array of .box elements inside container
gsap.to(q(".circle"), { x: 100 });
```
### toArray(值，范围？)
将值转换为数组：选择器字符串（范围为元素）、NodeList、HTMLCollection、单个元素或数组。当将混合输入传递给 GSAP（例如目标）并且需要真正的数组时使用。
```javascript
gsap.utils.toArray(".item");           // array of elements
gsap.utils.toArray(".item", container); // scoped to container
gsap.utils.toArray(nodeList);          // [ ... ] from NodeList
```
### 管道（...函数）
组合函数：**pipe(f1, f2, f3)(value)** 返回 f3(f2(f1(value)))。在补间或回调中应用一系列变换（例如标准化→mapRange→捕捉）时使用。
```javascript
const fn = gsap.utils.pipe(
  (v) => gsap.utils.normalize(0, 100, v),
  (v) => gsap.utils.snap(0.1, v)
);
fn(50); // normalized then snapped
```
### 换行（最小值、最大值、值？）
将值包含在最小值–最大值范围内（包括最小值，不包括最大值）。用于无限滚动或循环值。省略 **value** 以获取函数：`wrap(min, max)(value)`。
```javascript
gsap.utils.wrap(0, 360, 370);  // 10
gsap.utils.wrap(0, 360, -10);   // 350

let wrapFn = gsap.utils.wrap(0, 360);
wrapFn(370); // 10
```
### wrapYoyo(最小值、最大值、值？)
用溜溜球将值包裹在范围内（在末端弹跳）。用于在一定范围内来回移动。省略 **value** 以获取函数：`wrapYoyo(min, max)(value)`。
```javascript
gsap.utils.wrapYoyo(0, 100, 150); // 50 (bounces back)

let wrapY = gsap.utils.wrapYoyo(0, 100);
wrapY(150); // 50
```
## 最佳实践
- ✅ 当多次使用相同的范围/配置时，省略 value 参数以获得可重用的函数（例如滚动处理程序、补间回调）：`let mapFn = gsap.utils.mapRange(0, 1, 0, 360); mapFn(progress)`。
- ✅ 使用 **snap** 来表示网格对齐或基于步长的值；当 GSAP 或您的代码需要来自选择器或 NodeList 的真实数组时，请使用 **toArray**。
- ✅ 在组件中使用**gsap.utils.selector(scope)**，以便选择器的范围限定为容器或引用。
## 不要
- ❌ 假设 **mapRange** / **标准化** 手柄单位；他们研究数字。当单位很重要时，使用 **getUnit** / **unitize**。
- ❌ 覆盖或依赖未记录的行为；坚持记录的 API。
### 了解更多
__保留_0__
