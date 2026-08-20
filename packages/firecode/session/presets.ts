/**
 * 预设：一键切换模型、思考等级、工具集与附加指令。
 * 入口有 `--preset`、`/preset [名字]`、Option+1-9、Ctrl+Shift+U 循环。
 * 预设定义见 firecode/config.jsonc 的 presets 节。
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { type Preset, loadConfig } from "../config.js";

const CLEAR_ITEM = "（无）";
const INSTRUCTIONS_PREVIEW_CHARS = 30;
const SELECTOR_MAX_ROWS = 10;

/** 会话可用的等级比预设可配置的多（含 max），快照要按前者存。 */
type OriginalState = {
	model: Model<Api> | undefined;
	thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
	tools: string[];
};

const title = (text: string): string =>
	text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;

function describe(preset: Preset): string {
	const parts: string[] = [];
	if (preset.provider && preset.model) parts.push(`${preset.provider}/${preset.model}`);
	if (preset.thinkingLevel) parts.push(`thinking:${preset.thinkingLevel}`);
	if (preset.tools) parts.push(`tools:${preset.tools.join(",")}`);
	if (preset.instructions) {
		const preview =
			preset.instructions.length > INSTRUCTIONS_PREVIEW_CHARS
				? `${preset.instructions.slice(0, INSTRUCTIONS_PREVIEW_CHARS - 3)}...`
				: preset.instructions;
		parts.push(`"${preview}"`);
	}
	return parts.join(" | ");
}

export function registerPresets(pi: ExtensionAPI): void {
	let presets: Record<string, Preset> = {};
	let activeName: string | undefined;
	let activePreset: Preset | undefined;
	let originalState: OriginalState | undefined;

	pi.registerFlag("preset", {
		description: "要启用的预设名",
		type: "string",
	});

	const updateStatus = (ctx: ExtensionContext) =>
		ctx.ui.setStatus(
			"preset",
			activeName ? ctx.ui.theme.fg("accent", `🧩 ${title(activeName)}`) : undefined,
		);

	const noPresetsHint = (ctx: ExtensionContext) =>
		ctx.ui.notify("未定义任何预设。在 firecode/config.jsonc 的 presets 里添加。", "warning");

	async function applyPreset(name: string, preset: Preset, ctx: ExtensionContext): Promise<void> {
		// 首次应用前留一份快照，用于恢复默认。
		if (activeName === undefined) {
			originalState = {
				model: ctx.model,
				thinkingLevel: pi.getThinkingLevel(),
				tools: pi.getActiveTools(),
			};
		}

		if (preset.provider && preset.model) {
			const model = ctx.modelRegistry.find(preset.provider, preset.model);
			if (!model) {
				ctx.ui.notify(
					`Preset "${name}": Model ${preset.provider}/${preset.model} not found`,
					"warning",
				);
			} else if (!(await pi.setModel(model))) {
				ctx.ui.notify(
					`Preset "${name}": No API key for ${preset.provider}/${preset.model}`,
					"warning",
				);
			}
		}

		if (preset.thinkingLevel) pi.setThinkingLevel(preset.thinkingLevel);

		if (preset.tools?.length) {
			const known = new Set(pi.getAllTools().map((tool) => tool.name));
			const valid = preset.tools.filter((tool) => known.has(tool));
			const unknown = preset.tools.filter((tool) => !known.has(tool));
			if (unknown.length)
				ctx.ui.notify(`预设「${name}」含未知工具：${unknown.join("、")}`, "warning");
			if (valid.length) pi.setActiveTools(valid);
		}

		activeName = name;
		activePreset = preset;
	}

	async function activate(name: string, ctx: ExtensionContext): Promise<void> {
		const preset = presets[name];
		if (!preset) return;
		await applyPreset(name, preset, ctx);
		ctx.ui.notify(`已切换预设「${name}」`, "info");
		updateStatus(ctx);
	}

	async function clearPreset(ctx: ExtensionContext): Promise<void> {
		activeName = undefined;
		activePreset = undefined;
		if (originalState) {
			if (originalState.model) await pi.setModel(originalState.model);
			pi.setThinkingLevel(originalState.thinkingLevel);
			pi.setActiveTools(originalState.tools);
		}
		ctx.ui.notify("预设已清除，恢复默认", "info");
		updateStatus(ctx);
	}

	async function showSelector(ctx: ExtensionContext): Promise<void> {
		const names = Object.keys(presets);
		if (names.length === 0) {
			noPresetsHint(ctx);
			return;
		}

		const items: SelectItem[] = names.map((name) => ({
			value: name,
			label: name === activeName ? `${name}（当前）` : name,
			description: describe(presets[name]),
		}));
		items.push({
			value: CLEAR_ITEM,
			label: CLEAR_ITEM,
			description: "清除当前预设，恢复默认",
		});

		const choice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(new Text(theme.fg("accent", theme.bold("选择预设"))));

			const selectList = new SelectList(items, Math.min(items.length, SELECTOR_MAX_ROWS), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);
			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "↑↓ 选择 • enter 确认 • esc 取消")));
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput(data: string) {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!choice) return;
		if (choice === CLEAR_ITEM) await clearPreset(ctx);
		else await activate(choice, ctx);
	}

	async function cyclePreset(ctx: ExtensionContext): Promise<void> {
		const names = Object.keys(presets);
		if (names.length === 0) {
			noPresetsHint(ctx);
			return;
		}
		const cycle = [CLEAR_ITEM, ...names];
		const current = cycle.indexOf(activeName ?? CLEAR_ITEM);
		const next = cycle[current === -1 ? 0 : (current + 1) % cycle.length];
		if (next === CLEAR_ITEM) await clearPreset(ctx);
		else await activate(next, ctx);
	}

	const { keys, presets: configured } = loadConfig().config;

	pi.registerShortcut(keys.cyclePreset as never, {
		description: "轮切预设",
		handler: (ctx) => cyclePreset(ctx),
	});

	for (const [name, preset] of Object.entries(configured)) {
		if (!preset.key) continue;
		pi.registerShortcut(preset.key as never, {
			description: `启用预设「${name}」`,
			handler: (ctx) => activate(name, ctx),
		});
	}

	pi.registerCommand("preset", {
		description: "切换预设",
		handler: async (args, ctx) => {
			const name = args?.trim();
			if (!name) {
				await showSelector(ctx);
				return;
			}
			if (!presets[name]) {
				const available = Object.keys(presets).join(", ") || "(none defined)";
				ctx.ui.notify(`未知预设「${name}」，可用：${available}`, "error");
				return;
			}
			await activate(name, ctx);
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!activePreset?.instructions) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${activePreset.instructions}` };
	});

	pi.on("session_start", async (_event, ctx) => {
		// 配置问题由 index.ts 统一提示，这里只取预设。
		presets = loadConfig().config.presets;

		const flag = pi.getFlag("preset");
		if (typeof flag === "string" && flag) {
			if (presets[flag]) {
				await applyPreset(flag, presets[flag], ctx);
				ctx.ui.notify(`已切换预设「${flag}」`, "info");
			} else {
				const available = Object.keys(presets).join(", ") || "(none defined)";
				ctx.ui.notify(`未知预设「${flag}」，可用：${available}`, "warning");
			}
		} else {
			// 恢复上次会话的预设：只认名字，不重放模型与工具切换。
			const restored = ctx.sessionManager
				.getEntries()
				.filter(
					(entry: { type: string; customType?: string }) =>
						entry.type === "custom" && entry.customType === "preset-state",
				)
				.pop() as { data?: { name: string } } | undefined;
			const name = restored?.data?.name;
			if (name && presets[name]) {
				activeName = name;
				activePreset = presets[name];
			}
		}

		updateStatus(ctx);
	});

	pi.on("turn_start", async () => {
		if (activeName) pi.appendEntry("preset-state", { name: activeName });
	});
}
