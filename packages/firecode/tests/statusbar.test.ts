import { afterEach, expect, test } from "bun:test";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

afterEach(cleanupFirecodeModules);

test("状态栏观察员段随模块状态出现和消失", async () => {
	const { statusBadges } = await loadFirecodeModule("statusbar/render.js") as any;
	const statuses = new Map([
		["master", "👑 指挥官"],
		["watcher", "👓 flash/low"],
	]);

	expect(statusBadges(statuses, " ｜ ")).toBe("👑 指挥官 ｜ 👓 flash/low");
	statuses.delete("watcher");
	expect(statusBadges(statuses, " ｜ ")).toBe("👑 指挥官");
});

test("指挥官状态栏按角色首字计数，空闲合并，无子代理时只有身份", async () => {
	const { masterStatusLine } = await loadFirecodeModule("master/index.js") as any;
	const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
	const worker = (role: string, status: string) => ({ role, status });

	expect(masterStatusLine([
		worker("调研员", "working"),
		worker("调研员", "working"),
		worker("工程师", "reviewing"),
		worker("哨兵", "working"),
		worker("工程师", "idle"),
	], theme, 0)).toBe("<dim>👑 ⠋ 调2·工1·哨1·闲1</dim>");
	expect(masterStatusLine([], theme)).toBe("<dim>👑 指挥官</dim>");
});

test("底栏活动动画只在有在飞子代理时开，全部落定即停", async () => {
	const { masterActive, masterStatusLine } = await loadFirecodeModule("master/index.js") as any;
	const theme = { fg: (_color: string, text: string) => text };

	expect(masterActive([])).toBe(false);
	expect(masterActive([{ role: "工程师", status: "idle" }])).toBe(false);
	expect(masterActive([{ role: "工程师", status: "working" }])).toBe(true);
	expect(masterActive([{ role: "工程师", status: "reviewing" }])).toBe(true);

	expect(masterStatusLine([{ role: "工程师", status: "idle" }], theme, 3)).toBe("👑 闲1");
	expect(masterStatusLine([{ role: "工程师", status: "working" }], theme, 3)).toMatch(/^👑 \S 工1$/u);
});
