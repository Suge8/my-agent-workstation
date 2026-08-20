# 手势驱动交互

适用于拖拽、swipe-to-dismiss、bottom sheet、carousel、drag-to-reorder。核心：动效从当前呈现值开始、继承用户速度、投射动量、随时可被抓住反向。SKILL.md §5 的 spring 起调值和 §8 的实现纪律仍然适用；本文只补充手势特有的机制与参数。

## 跟踪

- pointer-down 即时反馈（高亮、scale），不等 click/touch-up；commit 发生在抬起。
- `setPointerCapture` 保证指针离开元素边界后继续跟踪；记录抓取点相对元素的 offset，不把元素吸附到指针中心。
- 约 10px 迟滞阈值后才判定手势方向，之后 1:1 跟随。
- 保留最近几次 `pointermove` 的位置 + 时间戳，用于计算释放速度；只存当前点算不出速度。
- 从第一次移动起并行检测所有候选手势，意图明确后果断取消输家；不用只报终态的 `swipeleft` 类事件，它们丢掉了连续跟踪。
- 双击检测必然延迟单击；只在真实存在双击的目标上付这个代价。

## 释放：动量决定去向

- dismiss 判定用速度，不只用距离：`velocity = |distance| / elapsedMs`，超过约 0.11 即 dismiss，轻甩即可，不必拖过距离阈值。
- 提交还是回弹由释放时速度的符号决定，不由当前位置决定。
- 落点用动量投射，再吸附到离投射终点最近的 snap point：

```js
// decelerationRate ≈ 0.998 常规滚动感；0.99 更利落
function project(velocityPxPerSecond, decelerationRate = 0.998) {
  return (velocityPxPerSecond / 1000) * decelerationRate / (1 - decelerationRate);
}
const target = nearestSnapPoint(currentPosition + project(releaseVelocity));
```

用上面的指数衰减形式，不用物理课本的 `v²/(2·decel)`；这是 Vaul、Embla 等成熟 sheet/carousel 的实际行为。

## 速度交接

- 释放后的 spring 以手指释放速度为初速度，拖拽与动画之间不得有可见的接缝。Motion 直接收绝对 px/s（`velocity` 选项）。
- API 要求相对速度时归一化：`relativeVelocity = releaseVelocity / (target - current)`。
- 2D 运动拆成独立的 X、Y 两个 spring；单个 spring 驱动 2D 距离会在两轴速度不同时失步。

## 边界阻力

越界渐增阻力，不硬停：

```js
function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}
```

## 中断与反向

- 手势可及的动效不用 CSS transition/keyframes，用 spring：中断时从元素当前屏幕值（presentation value）继续，从逻辑目标值重启会跳变。
- 动画途中被再次抓住必须立即跟手；关闭中的 sheet 被抓住直接跟随，不先关完再重开。
- 反向重定向时混合当前速度，避免速度断崖；选用重定向时携带速度的 spring 实现。

## Spring 参数（Apple 映射）

Apple 用 damping ratio + response 表达 spring；与 SKILL.md 的 `stiffness/damping/mass` 起调值是两套表达，任选一套：

| 交互 | Damping | Response |
|---|---:|---:|
| 移动 / 重定位 | 1.0 | 0.4 |
| 旋转 | 0.8 | 0.4 |
| Drawer / Sheet | 0.8 | 0.3 |

默认 damping 1.0（无回弹）；只有释放本身带动量（甩、抛）时才降到约 0.8。刚淡入的菜单出现回弹是错的，被甩出的卡片回弹是对的。Motion 的 `bounce/duration` API 与此对应：默认 `bounce: 0`，动量手势 `bounce: 0.2`。

## 验收

- 按下即有反馈；拖拽全程 1:1 且尊重抓取点，指针离开边界不中断。
- 轻甩可 dismiss；释放动画无缝继承手指速度，无接缝、无跳变。
- 越界渐增阻力；drag 开始后新增触点被忽略，换手指不跳位。
- 动画途中可抓住并反向，从当前位置继续且无速度断崖。
- 快速重复操作、中途反向、真机触屏和 reduced-motion（用短 cross-fade 替代位移）复测通过。

## 依据

- Apple WWDC 2018：[Designing Fluid Interfaces](https://developer.apple.com/videos/play/wwdc2018/803/)（动量投射与 rubber-band 公式出自其示例代码）
- Emil Kowalski：[animations.dev](https://animations.dev/)、[emilkowalski/skills](https://github.com/emilkowalski/skills)（速度阈值 dismiss、多点保护出自 Sonner/Vaul 实现）
- MDN：[Pointer Events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events)、[setPointerCapture](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture)
