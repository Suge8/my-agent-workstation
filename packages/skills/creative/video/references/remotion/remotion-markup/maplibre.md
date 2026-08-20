---
name: maps-maplibre
description: 使用 MapLibre GL JS 和 Turf 制作确定性 Remotion 地图动画。当用户为动画路线、立交桥、地图标记、标签和相机移动选择 MapLibre 时使用。
metadata:
  tags: map, map animation, maplibre, turf, geojson, route animation
---

使用MapLibreGL JS渲染Remotion中的地图。使用 Turf 进行地理空间操作，例如大圆路线、距离、切片线和沿路线的位置。

## 核心规则

- 对于地理空间工作，首选 `@turf/turf`。除非用户明确需要自定义非测地线效果，否则请勿手动滚动距离、大圆、路线切片或坐标插值。
- 使用 GeoJSON 源和 MapLibre 图层作为线条、标记和标签。避免使用 DOM `Marker` 元素，除非用户特别要求使用 HTML 标记。
- 禁用非确定性地图行为：`interactive: false`、`fadeDuration: 0`。
- 在地图加载和每帧地图更新方面使用 `delayRender()` / `continueRender()`。
- 在继续初始渲染之前，添加sources/layers，使用`jumpTo()`应用第0帧相机，然后等待`idle`。
- 不要添加`mapInstance.remove()`清理功能；它会干扰 Remotion 的渲染生命周期。
- 使用标准 MapLibre 样式 JSON URL 和 layer/source API。
- 不要安装`@types/maplibre-gl`； MapLibre 提供自己的类型。

MapLibre、Turf 和 GeoJSON 中的坐标为 `[longitude, latitude]`。

```ts
const zurich: [number, number] = [8.5417, 47.3769];
const newYork: [number, number] = [-74.006, 40.7128];
```

## 先决条件

使用项目的包管理器安装 MapLibre 和 Turf。

```bash
npm i maplibre-gl @turf/turf
```

```bash
bun i maplibre-gl @turf/turf
```

```bash
yarn add maplibre-gl @turf/turf
```

```bash
pnpm i maplibre-gl @turf/turf
```

在组件或应用程序级样式表中导入一次 MapLibre CSS：

```ts
import 'maplibre-gl/dist/maplibre-gl.css';
```

## 基本地图示例

```tsx
import {useEffect, useRef, useState} from 'react';
import {AbsoluteFill, useDelayRender, useVideoConfig} from 'remotion';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

const zurich: [number, number] = [8.5417, 47.3769];

export const MyComposition = () => {
	const containerRef = useRef<HTMLDivElement>(null);
	const {delayRender, continueRender} = useDelayRender();
	const {width, height} = useVideoConfig();
	const [loadingHandle] = useState(() => delayRender('Loading map'));

	useEffect(() => {
		if (!containerRef.current) {
			return;
		}

		const mapInstance = new maplibregl.Map({
			container: containerRef.current,
			style: 'https://demotiles.maplibre.org/style.json',
			center: zurich,
			zoom: 7,
			interactive: false,
			attributionControl: false,
			fadeDuration: 0,
			canvasContextAttributes: {
				preserveDrawingBuffer: true,
			},
		});

		mapInstance.on('load', () => {
			mapInstance.jumpTo({center: zurich, zoom: 7});
			mapInstance.once('idle', () => {
				continueRender(loadingHandle);
			});
		});
	}, [continueRender, loadingHandle]);

	return (
		<AbsoluteFill>
			<div ref={containerRef} style={{width, height, position: 'absolute'}} />
		</AbsoluteFill>
	);
};
```

动画示例应将加载的地图保持在 React 状态，并跳过每帧更新，直到设置该状态。

## 动画飞行路线示例

此示例显示了路线动画的推荐模式：

- Turf 创建路线和标记。
- Turf 对路线进行切片以显示线条动画。
- 相机具有与目标路线不同的路线。
- MapLibre的`calculateCameraOptionsFromTo()`用于相机移动。
- 帧 0 在 `continueRender()` 之前准备好。

```tsx
import * as turf from '@turf/turf';
import {useEffect, useRef, useState} from 'react';
import {
	AbsoluteFill,
	Easing,
	interpolate,
	useCurrentFrame,
	useDelayRender,
	useVideoConfig,
} from 'remotion';
import maplibregl, {type GeoJSONSource, type Map} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

const zurich: [number, number] = [8.5417, 47.3769];
const newYork: [number, number] = [-74.006, 40.7128];

const greatCircleLine = (from: [number, number], to: [number, number]) => {
	const route = turf.greatCircle(from, to, {npoints: 100});

	if (route.geometry.type === 'LineString') {
		return turf.lineString(route.geometry.coordinates);
	}

	// Great-circle routes crossing the antimeridian can become MultiLineString.
	// Keep the example valid by choosing the longest segment.
	const longestSegment = route.geometry.coordinates.reduce((longest, segment) => {
		return segment.length > longest.length ? segment : longest;
	});

	return turf.lineString(longestSegment);
};

const targetRoute = greatCircleLine(zurich, newYork);
const targetRouteDistance = turf.length(targetRoute);

const cameraRoute = greatCircleLine(zurich, newYork);
const cameraRouteDistance = turf.length(cameraRoute);

const cityMarkers = turf.featureCollection([
	turf.point(zurich, {name: 'Zurich'}),
	turf.point(newYork, {name: 'New York'}),
]);

const clampProgress = (progress: number) => Math.min(1, Math.max(0, progress));

const distanceAlong = (totalDistance: number, progress: number) => {
	// Keep the route non-empty at progress 0; Turf can error on zero-length slices.
	return Math.max(0.001, totalDistance * clampProgress(progress));
};

const getPartialTargetRoute = (progress: number) => {
	return turf.lineSliceAlong(
		targetRoute,
		0,
		distanceAlong(targetRouteDistance, progress),
	);
};

const getCameraOptions = (
	map: Map,
	progress: number,
	cameraAltitudeMeters: number,
	cameraLatitudeOffset: number,
) => {
	const target = turf.along(
		targetRoute,
		distanceAlong(targetRouteDistance, progress),
	).geometry.coordinates;
	const camera = turf.along(
		cameraRoute,
		distanceAlong(cameraRouteDistance, progress),
	).geometry.coordinates;

	return map.calculateCameraOptionsFromTo(
		new maplibregl.LngLat(camera[0], camera[1] - cameraLatitudeOffset),
		cameraAltitudeMeters,
		new maplibregl.LngLat(target[0], target[1]),
	);
};

export const MyComposition = () => {
	const containerRef = useRef<HTMLDivElement>(null);
	const frame = useCurrentFrame();
	const {delayRender, continueRender} = useDelayRender();
	const {durationInFrames, height, width} = useVideoConfig();
	const [map, setMap] = useState<Map | null>(null);
	const [loadingHandle] = useState(() => delayRender('Loading MapLibre map'));

	useEffect(() => {
		if (!containerRef.current) {
			return;
		}

		const mapInstance = new maplibregl.Map({
			container: containerRef.current,
			style: 'https://demotiles.maplibre.org/style.json',
			center: zurich,
			zoom: 7,
			interactive: false,
			attributionControl: false,
			fadeDuration: 0,
			canvasContextAttributes: {
				preserveDrawingBuffer: true,
			},
		});

		mapInstance.on('load', () => {
			mapInstance.addSource('trace', {
				type: 'geojson',
				data: getPartialTargetRoute(0),
			});

			mapInstance.addLayer({
				id: 'trace-line',
				type: 'line',
				source: 'trace',
				layout: {
					'line-cap': 'round',
					'line-join': 'round',
				},
				paint: {
					'line-color': '#111111',
					'line-width': 7,
				},
			});

			mapInstance.addSource('city-markers', {
				type: 'geojson',
				data: cityMarkers,
			});

			mapInstance.addLayer({
				id: 'city-marker-dots',
				type: 'circle',
				source: 'city-markers',
				paint: {
					'circle-color': '#f03b20',
					'circle-radius': 12,
					'circle-stroke-color': '#ffffff',
					'circle-stroke-width': 4,
				},
			});

			mapInstance.addLayer({
				id: 'city-marker-labels',
				type: 'symbol',
				source: 'city-markers',
				layout: {
					'text-allow-overlap': true,
					'text-anchor': 'top',
					'text-field': ['get', 'name'],
					'text-offset': [0, 0.9],
					'text-size': 28,
				},
				paint: {
					'text-color': '#111111',
					'text-halo-color': '#ffffff',
					'text-halo-width': 3,
				},
			});

			mapInstance.jumpTo(getCameraOptions(mapInstance, 0, 180000, 1.1));
			mapInstance.once('idle', () => {
				setMap(mapInstance);
				continueRender(loadingHandle);
			});
		});
	}, [continueRender, loadingHandle]);

	useEffect(() => {
		if (!map) {
			return;
		}

		const handle = delayRender('Rendering MapLibre frame');
		const timelineProgress = interpolate(frame, [0, durationInFrames - 1], [0, 1], {
			extrapolateLeft: 'clamp',
			extrapolateRight: 'clamp',
		});
		const travelProgress = interpolate(timelineProgress, [0.2, 0.82], [0, 1], {
			extrapolateLeft: 'clamp',
			extrapolateRight: 'clamp',
			easing: Easing.inOut(Easing.cubic),
		});
		const cameraAltitudeMeters = interpolate(
			timelineProgress,
			[0, 0.28, 0.74, 1],
			[180000, 2200000, 2200000, 180000],
			{
				extrapolateLeft: 'clamp',
				extrapolateRight: 'clamp',
				easing: Easing.inOut(Easing.cubic),
			},
		);
		const cameraLatitudeOffset = interpolate(
			timelineProgress,
			[0, 0.28, 0.74, 1],
			[1.1, 8, 8, 1.1],
			{
				extrapolateLeft: 'clamp',
				extrapolateRight: 'clamp',
				easing: Easing.inOut(Easing.cubic),
			},
		);
		const trace = map.getSource('trace') as GeoJSONSource | undefined;

		trace?.setData(getPartialTargetRoute(travelProgress));
		map.jumpTo(
			getCameraOptions(
				map,
				travelProgress,
				cameraAltitudeMeters,
				cameraLatitudeOffset,
			),
		);

		map.once('idle', () => continueRender(handle));
		// Force an idle event even if the camera parameters are unchanged from the previous frame.
		map.triggerRepaint();
	}, [continueRender, delayRender, durationInFrames, frame, map]);

	return (
		<AbsoluteFill style={{backgroundColor: '#e8eef3'}}>
			<div ref={containerRef} style={{height, position: 'absolute', width}} />
		</AbsoluteFill>
	);
};
```

## 相机引导

使用MapLibre的相机助手进行相机移动：

```ts
map.calculateCameraOptionsFromTo(cameraLngLat, cameraAltitudeMeters, targetLngLat);
```

一个好的模式是将两个概念分开：

- `targetRoute`：动画线所在位置以及相机所看的位置。
- `cameraRoute`：相机移动的位置。

然后使用 Turf 从两条路线读取相同进度值的位置：

```ts
const target = turf.along(targetRoute, targetDistance * progress).geometry.coordinates;
const camera = turf.along(cameraRoute, cameraDistance * progress).geometry.coordinates;

map.jumpTo(
	map.calculateCameraOptionsFromTo(
		new maplibregl.LngLat(camera[0], camera[1]),
		cameraAltitudeMeters,
		new maplibregl.LngLat(target[0], target[1]),
	),
);
```

对于缩小/旅行/放大动画，将旅行进度与相机高度分开制作动画。相机高度以米为单位测量。这避免了繁重的自定义相机数学运算。

## 线路

使用 GeoJSON 源作为线条。除非用户要求，否则不要添加发光效果或额外的装饰点。

对于测地线飞行路线，使用 Turf：

```ts
const line = greatCircleLine(start, end);
const distance = turf.length(line);
const partialLine = turf.lineSliceAlong(
	line,
	0,
	// Keep the route non-empty at progress 0.
	Math.max(0.001, distance * progress),
);
```

对于地图上的视觉直线，请在两点之间使用简单的 GeoJSON `LineString` 而不是 `greatCircle()`。

## 标记和标签

使用地图原生 GeoJSON 图层作为标记和标签：

```tsx
mapInstance.addSource('markers', {
	type: 'geojson',
	data: turf.featureCollection([
		turf.point([-118.2437, 34.0522], {name: 'Los Angeles'}),
	]),
});

mapInstance.addLayer({
	id: 'marker-dots',
	type: 'circle',
	source: 'markers',
	paint: {
		'circle-color': '#f03b20',
		'circle-radius': 12,
		'circle-stroke-color': '#ffffff',
		'circle-stroke-width': 4,
	},
});

mapInstance.addLayer({
	id: 'marker-labels',
	type: 'symbol',
	source: 'markers',
	layout: {
		'text-allow-overlap': true,
		'text-anchor': 'top',
		'text-field': ['get', 'name'],
		'text-offset': [0, 0.9],
		'text-size': 28,
	},
	paint: {
		'text-color': '#111111',
		'text-halo-color': '#ffffff',
		'text-halo-width': 3,
	},
});
```

使标记大小和标签字体大小足够大以适应合成分辨率。

## 风格

默认为库存MapLibre演示样式：

```ts
style: 'https://demotiles.maplibre.org/style.json'
```

如果用户请求其他样式，请使用任何有效的 MapLibre 样式 JSON URL。

## 渲染

对于WebGL地图渲染，更喜欢单并发和ANGLE：

```bash
bunx remotion render [composition-id] out/video.mp4 --gl=angle --concurrency=1
```

对项目使用等效的包运行程序。在npm项目中，使用`npx`；在Bun项目中，使用`bunx`。
