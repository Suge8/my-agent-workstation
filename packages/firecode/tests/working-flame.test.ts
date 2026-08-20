import { expect, test } from "bun:test";
import { FLAME_FRAME_COUNT, flameFrameLines, flameFrameWidth } from "../flame-frames.js";
import { flameFitHeight, flameHeightFor, registerWorkingFlame } from "../session/working-flame.js";

const microtask = () => new Promise<void>((resolve) => queueMicrotask(resolve));

// Working 行可见性的最终仲裁：审查占用期 agent_end 不得复显 Working...，
// 占用释放且无回合时才复显——这是两模块共写同一开关的竞态回归现场。
test("working line stays hidden while review holds occupancy across turn boundaries", async () => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let occupancy: ((data: { active?: boolean }) => void) | undefined;
	const visible: boolean[] = [];
	const widgets: boolean[] = [];
	registerWorkingFlame({
		on: (name: string, handler: never) => handlers.set(name, handler),
		events: { on: (_name: string, handler: never) => { occupancy = handler; } },
	} as never);
	const ctx = {
		mode: "tui",
		ui: {
			setWorkingVisible: (value: boolean) => visible.push(value),
			setWidget: (_key: string, content: unknown) => widgets.push(Boolean(content)),
		},
	};
	occupancy?.({ active: true });
	await handlers.get("agent_start")?.({}, ctx);
	await handlers.get("agent_end")?.({}, ctx);
	await microtask();
	expect(visible.at(-1)).toBe(false);
	expect(widgets.every((shown) => !shown)).toBe(true);

	occupancy?.({ active: false });
	await microtask();
	expect(visible.at(-1)).toBe(true);
});

// 素材层不变量：声明宽度必须≥实际可见宽度，否则窄屏适配按小宽放行、渲染却溢出。
test("declared flame width covers actual visible width for every height and frame", () => {
	for (const height of [3, 6, 10]) {
		const declared = flameFrameWidth(height);
		for (let frame = 0; frame < FLAME_FRAME_COUNT; frame += 1) {
			for (const line of flameFrameLines(height, frame)) {
				expect(line.replace(/\u001b\[[0-9;]*m/gu, "").length).toBeLessThanOrEqual(declared);
			}
		}
	}
});

// 高矮自适应：矮终端缩小、正常终端满高，钳位 3–10。
test("flame height tracks terminal rows with clamps", () => {
	expect(flameHeightFor(undefined)).toBe(10);
	expect(flameHeightFor(59)).toBe(10);
	expect(flameHeightFor(28)).toBe(7);
	expect(flameHeightFor(8)).toBe(3);
});

// 宽度不够时逐级降高而不是直接消失；窄到装不下最小火焰才隐藏。
test("flame shrinks to fit narrow widths before hiding", () => {
	expect(flameFitHeight(10, flameFrameWidth(10))).toBe(10);
	const narrow = flameFrameWidth(10) - 1;
	const fitted = flameFitHeight(10, narrow);
	expect(fitted).toBeGreaterThan(0);
	expect(fitted).toBeLessThan(10);
	expect(flameFitHeight(10, 0)).toBe(0);
});
