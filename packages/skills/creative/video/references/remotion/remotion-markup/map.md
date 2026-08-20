---
name: maps
description: 在简单静态地图、Mapbox GL JS 地图和MapLibre GL JS 地图（适用于 Remotion 视频）之间进行选择。
metadata:
  tags: map, map animation, mapbox, maplibre, static map, route animation
---

首先使用此规则进行与地图相关的 Remotion 工作。

对于几乎没有立交桥的简单地图，请考虑使用静态地图图像。

对于带有动画路线或立交桥的复杂地图，询问用户他们想要哪个渲染器：

- Mapbox：更好的默认样式和动画，需要Mapbox访问令牌。然后加载[mapbox.md](mapbox.md)。
- MapLibre：开源渲染器，默认演示样式不需要Mapbox令牌。然后加载[maplibre.md](maplibre.md)。
