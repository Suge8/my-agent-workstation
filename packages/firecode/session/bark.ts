/**
 * Bark 通知：每轮任务彻底落定（agent_settled 且不再自动续跑）时，
 * 把最后一条回复推送到 iPhone 的 Bark App。
 *
 * - Worker 进程静默：通知全部由指挥官会话发出（判据同 herdr-display.ts）。
 * - 子代理池里有待拍板的子代理（Herdr blocked 态）时升 timeSensitive 并带副标题，
 *   可穿透专注模式；平时为默认 active。
 * - 同会话固定 id：新通知经 APNs CollapseID 顶掉旧通知，通知栏每会话只留最新一条。
 * - 推送地址在 ~/.pi/agent/bark-key（整行即 https://api.day.app/<key>/），
 *   缺失时静默停用；~/.pi/agent/bark-crypto.json 存在时走 AES-256-GCM 端到端加密。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadMasterState, masterStatePath } from "../master/state.js";

const KEY_FILE = path.join(os.homedir(), ".pi", "agent", "bark-key");
const CRYPTO_FILE = path.join(os.homedir(), ".pi", "agent", "bark-crypto.json");
const MAX_BODY_LENGTH = 200;
// pi.dev 的 logo 是白色透明背景 SVG，通知图标不支持矢量图；经 wsrv.nl 转黑底 PNG。
const ICON_URL = "https://wsrv.nl/?url=pi.dev/logo.svg&w=256&h=256&output=png&bg=black";

export interface BarkPayload {
	title: string;
	subtitle?: string;
	body: string;
	group: string;
	id: string;
	level: "active" | "timeSensitive";
	icon: string;
}

export function buildBarkPayload(input: {
	title: string;
	body: string;
	group: string;
	sessionId: string;
	awaitingDecision: boolean;
}): BarkPayload {
	return {
		title: input.title,
		...(input.awaitingDecision ? { subtitle: "待拍板" } : {}),
		body: input.body || "任务已完成",
		group: input.group,
		id: input.sessionId,
		level: input.awaitingDecision ? "timeSensitive" : "active",
		icon: ICON_URL,
	};
}

/** 只读旁路判定：状态文件损坏由 Master 自己报告与恢复，通知不放大故障，一律按无待拍板降级。 */
export function hasBlockedWorker(statePath: string): boolean {
	try {
		return loadMasterState(statePath)?.workers.some((worker) => worker.status === "blocked") ?? false;
	} catch {
		return false;
	}
}

export function registerBark(pi: ExtensionAPI): void {
	// Worker 也加载本插件；通知只归指挥官会话。
	if (process.env.FIRECODE_MASTER_WORKER) return;

	let lastAssistantText = "";

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const text = extractText(event.message);
		if (text) lastAssistantText = text;
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.isIdle?.() !== true) return;
		const sessionId = ctx.sessionManager.getSessionId();
		const dirName = ctx.cwd ? path.basename(ctx.cwd) : "pi";
		void sendBark(
			buildBarkPayload({
				// 优先会话名；家目录直接跑 pi 时目录名恰好是用户名，不适合当标题。
				title: pi.getSessionName() || dirName,
				body: cleanMarkdown(lastAssistantText).slice(0, MAX_BODY_LENGTH),
				group: dirName,
				sessionId,
				awaitingDecision: hasBlockedWorker(masterStatePath(sessionId)),
			}),
		);
	});
}

async function sendBark(payload: BarkPayload): Promise<void> {
	const barkUrl = readBarkUrl();
	if (!barkUrl) return;
	const cryptoConfig = readCryptoConfig();
	// 加密时 id 必须提到顶层明文：折叠（CollapseID）由服务端写 APNs 头，密文内的 id 它读不到；
	// id 只是本地会话 uuid，无内容敏感性。level/subtitle 等内容字段由设备端解密后应用，留在密文内。
	const body = cryptoConfig
		? { ciphertext: encryptPayload(payload, cryptoConfig.key, cryptoConfig.iv), iv: cryptoConfig.iv, id: payload.id }
		: payload;
	try {
		await fetch(barkUrl.endsWith("/") ? barkUrl : `${barkUrl}/`, {
			method: "POST",
			headers: { "Content-Type": "application/json; charset=utf-8" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(5000),
		});
	} catch {
		// 推送是旁路能力，失败不打扰正常会话。
	}
}

function readBarkUrl(): string | undefined {
	try {
		const url = fs.readFileSync(KEY_FILE, "utf8").trim();
		return url.length > 0 ? url : undefined;
	} catch {
		return undefined;
	}
}

function readCryptoConfig(): { key: string; iv: string } | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(CRYPTO_FILE, "utf8"));
		if (typeof parsed.key === "string" && typeof parsed.iv === "string") return parsed;
	} catch {
		// 未配置加密时走明文。
	}
	return undefined;
}

/** AES-256-GCM，密文+authTag 拼接后 base64，与 Bark 官方客户端解密逻辑一致。 */
function encryptPayload(payload: unknown, key: string, iv: string): string {
	const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(key, "utf8"), Buffer.from(iv, "utf8"));
	const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
	return Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64");
}

function extractText(message: { content?: unknown }): string {
	const blocks = Array.isArray(message?.content) ? message.content : [];
	return blocks
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text as string)
		.join("\n")
		.trim();
}

/** 去掉 markdown 标记，通知栏显示纯文字。 */
function cleanMarkdown(text: string): string {
	return text
		.replace(/```\w*\n?([\s\S]*?)```/g, "$1")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^[-*+>]\s+/gm, "")
		.replace(/\*\*(.+?)\*\*/g, "$1")
		.replace(/__(.+?)__/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\n{2,}/g, "\n")
		.trim();
}
