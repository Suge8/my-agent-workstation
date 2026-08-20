import { afterAll, describe, expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-tui", () => ({
	visibleWidth: (text: string) => text.length,
	truncateToWidth: (text: string, width: number, ellipsis = "") =>
		text.length <= width
			? text
			: `${text.slice(0, Math.max(0, width - ellipsis.length))}${ellipsis}`,
}));

import { cacheColor, contextColor, thinkingColor } from "../theme.js";

const {
	alignRight,
	fitMetadataLine,
	fitStatusLine,
	reviewStatus,
	latestCacheHitPercent,
	renderCache,
	renderContext,
	renderLocation,
	renderQuota,
	renderTps,
} = await import(`../statusbar/render.js?test=${Date.now()}`);

const separator = " ｜";
const status = {
	model: "🧠 gpt-4.1/max · ⚡fast",
	modelCompact: "🧠 gpt-4.1/max",
	quota: "",
	quotaCompact: "",
	context: "📦 12.4%/272k",
	contextCompact: "📦 12.4%",
	cache: "♻️ 98%",
	tps: "↗ 42t/s",
};
const statusWithQuota = {
	...status,
	quota: "🔋 5h 26%/7d 88%",
	quotaCompact: "🔋 5h 26%",
};

const joined = (...parts: string[]) => parts.join(separator);

afterAll(() => mock.restore());

describe("two-line footer layout", () => {
	test("renders the selected spacing exactly", () => {
		expect(
			fitMetadataLine(
				"📍.pi · 🌿 main",
				"💬 Footer 改版",
				80,
				separator,
			),
		).toBe("📍.pi · 🌿 main ｜💬 Footer 改版");
		expect(fitStatusLine(status, 120, separator)).toBe(
			"🧠 gpt-4.1/max · ⚡fast ｜📦 12.4%/272k ｜♻️ 98% ｜↗ 42t/s",
		);
	});

	test("drops transient TPS without moving stable segments", () => {
		const stable = joined(status.model, status.context, status.cache);
		expect(fitStatusLine(status, stable.length, separator)).toBe(stable);
	});

	test("compacts fast mode before dropping cache and context detail", () => {
		const withoutFast = joined(
			status.modelCompact,
			status.context,
			status.cache,
		);
		const withoutCache = joined(status.modelCompact, status.context);

		expect(fitStatusLine(status, withoutFast.length, separator)).toBe(
			withoutFast,
		);
		expect(fitStatusLine(status, withoutCache.length, separator)).toBe(
			withoutCache,
		);
	});

	test("still supports quota segments when they are supplied", () => {
		expect(fitStatusLine(statusWithQuota, 140, separator)).toBe(
			"🧠 gpt-4.1/max · ⚡fast ｜🔋 5h 26%/7d 88% ｜📦 12.4%/272k ｜♻️ 98% ｜↗ 42t/s",
		);
	});

	test("keeps model and context in an extremely narrow terminal", () => {
		const essential = joined(status.modelCompact, status.contextCompact);
		expect(fitStatusLine(status, essential.length, separator)).toBe(essential);
	});

	test("omits a missing title without leaving a separator", () => {
		expect(
			fitMetadataLine("📍.pi · 🌿 main", "", 80, separator),
		).toBe("📍.pi · 🌿 main");
	});

	test("appends the master badge after the title and drops it whole when narrow", () => {
		const location = "📍firecode · 🌿 main";
		const title = "💬 脚标";
		const badge = "👑 指挥官/工作1/等1/审1";
		const full = joined(location, title, badge);
		expect(fitMetadataLine(location, title, full.length, separator, badge)).toBe(full);
		// 宽度不够：整段丢 badge，不出半截残渣。
		expect(fitMetadataLine(location, title, full.length - 1, separator, badge)).toBe(
			joined(location, title),
		);
		// 无会话名时 badge 直接跟在位置后。
		expect(fitMetadataLine(location, "", 80, separator, badge)).toBe(joined(location, badge));
	});
});

test("adds Flow state on the right without shrinking the existing line", () => {
	expect(alignRight("left", "right", 12)).toBe("left   right");
	expect(alignRight("left", "right", 10)).toBe("left");
	expect(alignRight("left", "", 10)).toBe("left");
});

test("picks up the fire-review status and ignores unrelated extension statuses", () => {
	expect(reviewStatus(new Map())).toBe("");
	expect(
		reviewStatus(
			new Map([
				["preset", "🧩 plan"],
				["fire-review", "🔍 审查 R2 [✓ · ·]"],
			]),
		),
	).toBe("🔍 审查 R2 [✓ · ·]");
});

test("renders live and completed timing without changing its visual language", () => {
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	};
	expect(renderTps(theme, { phase: "live" })).toBe("<success>↗ …</success>");
	expect(renderTps(theme, { phase: "live", tokensPerSecond: 42 })).toBe(
		"<success>↗ 42t/s</success>",
	);
	expect(
		renderTps(theme, {
			phase: "complete",
			elapsedSeconds: 8.36,
			tokensPerSecond: 42,
		}),
	).toBe("<dim>⏱ 8.4s · </dim><success>↗ 42t/s</success>");
});

test("context thresholds warn at 50% and fail at 75%", () => {
	expect(contextColor(null)).toBe("muted");
	expect(contextColor(49.9)).toBe("success");
	expect(contextColor(50)).toBe("warning");
	expect(contextColor(74.9)).toBe("warning");
	expect(contextColor(75)).toBe("error");
});

test("cache hit thresholds prefer higher reuse", () => {
	expect(cacheColor(90)).toBe("success");
	expect(cacheColor(50)).toBe("muted");
	expect(cacheColor(20)).toBe("warning");
	expect(cacheColor(19.9)).toBe("error");
});

test("latest cache hit uses the newest assistant usage with cache activity", () => {
	expect(
		latestCacheHitPercent([
			{
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 100, cacheRead: 900, cacheWrite: 0 },
				},
			},
		]),
	).toBe(90);
	expect(
		latestCacheHitPercent([
			{
				type: "message",
				message: { role: "assistant", usage: { input: 10, cacheRead: 0, cacheWrite: 0 } },
			},
		]),
	).toBeUndefined();
});

test("renders cache hit without inventing a placeholder", () => {
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	};
	expect(renderCache(theme, undefined)).toBe("");
	expect(renderCache(theme, 97.6)).toBe(
		"<dim>♻️ </dim><success>98%</success>",
	);
});

test("thinking levels use Pi semantic colors and distinguish max", () => {
	expect(thinkingColor("off")).toBe("thinkingOff");
	expect(thinkingColor("low")).toBe("thinkingLow");
	expect(thinkingColor("medium")).toBe("thinkingMedium");
	expect(thinkingColor("high")).toBe("thinkingHigh");
	expect(thinkingColor("xhigh")).toBe("thinkingXhigh");
	expect(thinkingColor("max")).toBe("thinkingMax");
});

test("renders branch in the same color as its location", () => {
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	};
	expect(renderLocation(theme, ".pi", "main")).toBe(
		"<dim>📍.pi</dim> · <dim>🌿 main</dim>",
	);
});

test("colors quota windows independently and only colors context usage", () => {
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	};
	expect(
		renderQuota(theme, {
			state: "ready",
			windows: [
				{ label: "5h", remaining: 8 },
				{ label: "7d", remaining: 88 },
			],
		}),
	).toBe(
		"<dim>🔋 </dim><error>5h 8%</error><dim>/</dim><success>7d 88%</success>",
	);
	expect(renderQuota(theme, { state: "loading" })).toBe(
		"<dim>🔋 …</dim>",
	);
	expect(renderQuota(theme, { state: "unavailable" })).toBe(
		"<dim>🔋 —</dim>",
	);
	expect(renderContext(theme, 62.4, 272_000)).toBe(
		"<dim>📦 </dim><warning>62.4%</warning><dim>/272k</dim>",
	);
});
