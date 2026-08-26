/**
 * FireCode：个人 pi 定制层——启动横幅、状态栏、工具行渲染、预设、会话命名，
 * Claude 归因、OpenAI 请求层、对抗审查与按需 Master。各功能可在 config.jsonc 的 features 里单独关闭。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Feature, loadConfig } from "./config.js";
import { registerHeader } from "./header.js";
import { registerClaudeSub } from "./provider/claude-sub.js";
import { registerOpenAINative } from "./provider/openai-native/index.js";
import { registerPresets } from "./session/presets.js";
import { registerHerdrDisplay } from "./session/herdr-display.js";
import { registerSessionName } from "./session/rename.js";
import { registerBark } from "./session/bark.js";
import { registerStats } from "./session/stats.js";
import { registerWorkingFlame } from "./session/working-flame.js";
import { registerStatusBar } from "./statusbar/index.js";
import { registerToolRendering } from "./tools/index.js";
import { registerReview } from "./review/index.js";
import { registerMaster } from "./master/index.js";
import { currentSubsessionRole } from "./master/role.js";
import { registerWatcher } from "./watcher/index.js";

const REGISTRARS: Record<Exclude<Feature, "review" | "master" | "watcher" | "statusbar" | "bark">, (pi: ExtensionAPI) => void> = {
	header: registerHeader,
	tools: registerToolRendering,
	presets: registerPresets,
	rename: registerSessionName,
	stats: registerStats,
	claudeSub: registerClaudeSub,
	openaiNative: registerOpenAINative,
	workingFlame: registerWorkingFlame,
};

type FirecodeSessionRole = "main" | "worker" | "observer" | "reviewer" | "advisor";

export function registerFirecode(pi: ExtensionAPI, role: FirecodeSessionRole = "main"): void {
	const { config, problems } = loadConfig();
	const subsession = role !== "main";
	const reviewEnabled = config.features.review !== false;
	for (const [feature, register] of Object.entries(REGISTRARS)) {
		const enabled = config.features[feature as Exclude<Feature, "review" | "master" | "watcher" | "statusbar" | "bark">] !== false;
		if (enabled) register(pi);
	}
	if (config.features.statusbar !== false) registerStatusBar(pi, subsession);
	if (config.features.bark !== false) registerBark(pi, subsession);
	if (config.features.watcher !== false) registerWatcher(pi, {}, subsession);
	if (config.features.master !== false) registerMaster(pi, {}, subsession);
	// herdr 显示投影没有开关：herdr 之外自我禁用，只写显示层。
	registerHerdrDisplay(pi, subsession);
	// 历史卡渲染与 checkpoint 收口不受 feature 开关控制；开关只控制命令和执行循环。
	// features 整节类型错误会被安全回退成全关，但那是配置坏而非用户关闭：不封存 checkpoint。
	registerReview(pi, reviewEnabled, problems.includes("features 必须是对象"));

	if (problems.length === 0) return;
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.notify(`FireCode 配置有问题：${problems.join("；")}`, "warning");
	});
}

export default function firecode(pi: ExtensionAPI): void {
	registerFirecode(pi, currentSubsessionRole() ?? "main");
}
