/** 会话重命名：`/rename <name>` 与 config.keys.rename，只改 pi 会话名。 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";

const MAX_TITLE_CHARS = 160;
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;
const INVISIBLE_CHARS = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g;

function cleanTitle(raw: string): string {
	const title = raw
		.replace(CONTROL_CHARS, " ")
		.replace(INVISIBLE_CHARS, "")
		.replace(/\s+/g, " ")
		.trim();
	return Array.from(title).slice(0, MAX_TITLE_CHARS).join("");
}

export function registerSessionName(pi: ExtensionAPI): void {
	const rename = (ctx: ExtensionContext, name: string) => {
		pi.setSessionName(name);
		ctx.ui.notify(`会话已改名：${name}`, "info");
	};

	pi.registerShortcut(loadConfig().config.keys.rename as never, {
		description: "重命名当前会话",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			const current = pi.getSessionName() ?? "";
			const next = await ctx.ui.input("重命名会话", current || "新名字");
			const name = cleanTitle(next ?? "");
			if (name) rename(ctx, name);
		},
	});

	pi.registerCommand("rename", {
		description: "重命名当前会话",
		handler: async (args, ctx) => {
			const name = cleanTitle(args);
			if (!name) {
				ctx.ui.notify("用法：/rename <新名字>", "error");
				return;
			}
			rename(ctx, name);
		},
	});
}
