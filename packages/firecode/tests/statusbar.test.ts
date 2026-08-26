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

test("指挥官状态栏只投影 v7 工作、审查、空闲三态", async () => {
	const { masterStatusLine } = await loadFirecodeModule("master/index.js") as any;
	const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
	const worker = (status: string) => ({ status });

	expect(masterStatusLine([
		worker("working"),
		worker("working"),
		worker("reviewing"),
		worker("idle"),
	], theme)).toBe(
		"<dim>👑 指挥官</dim><dim>/工作2</dim><dim>/审1</dim><dim>/闲1</dim>",
	);
	expect(masterStatusLine([], theme)).toBe("<dim>👑 指挥官</dim>");
});
