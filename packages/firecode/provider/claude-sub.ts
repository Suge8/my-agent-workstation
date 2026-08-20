/**
 * Anthropic OAuth 会话按 Claude Code 的归因格式发请求：补 user-agent 与
 * 系统提示词首块的 billing header，缺失时注入，已存在则原样通过。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BILLING_PREFIX = "x-anthropic-billing-header:";
const FALLBACK_CLAUDE_CODE_VERSION = "2.1.229";
const DEFAULT_ENTRYPOINT = "cli";
const BILLING_SALT = "59cf53e54c78";

type TextBlock = {
	type: "text";
	text: string;
	cache_control?: { type: "ephemeral"; ttl?: "1h" };
};

interface PayloadLike {
	system?: unknown;
	messages?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTextBlock(value: unknown): value is TextBlock {
	return isObject(value) && value.type === "text" && typeof value.text === "string";
}

function shouldApply(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	return !!model && model.provider === "anthropic" && ctx.modelRegistry.isUsingOAuth(model);
}

function detectClaudeCodeVersion(): string {
	const explicit = process.env.PI_CLAUDE_CODE_VERSION;
	if (explicit) return explicit;

	try {
		const output = execFileSync("claude", ["--version"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 1000,
		});
		const match = output.match(/\b\d+\.\d+\.\d+\b/);
		if (match) return match[0];
	} catch {
		// 本地未装 Claude Code 时用回退版本号，不阻塞启动。
	}

	return FALLBACK_CLAUDE_CODE_VERSION;
}

const claudeCodeVersion = detectClaudeCodeVersion();

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(isTextBlock)
		.map((block) => block.text)
		.join("\n");
}

function firstUserText(messages: unknown): string {
	const list = Array.isArray(messages) ? messages : [];
	const firstUser = list.find((message) => isObject(message) && message.role === "user");
	return isObject(firstUser) ? textOf(firstUser.content) : "";
}

function versionSuffix(messageText: string): string {
	const explicit = process.env.PI_CLAUDE_CODE_VERSION_SUFFIX;
	if (explicit) return explicit;

	const sampled = [4, 7, 20].map((index) => messageText[index] ?? "0").join("");
	return createHash("sha256")
		.update(`${BILLING_SALT}${sampled}${claudeCodeVersion}`)
		.digest("hex")
		.slice(0, 3);
}

function buildBillingHeader(messages: unknown): string {
	const version = `${claudeCodeVersion}.${versionSuffix(firstUserText(messages))}`;
	const entrypoint =
		process.env.PI_CLAUDE_CODE_ENTRYPOINT ?? process.env.CLAUDE_CODE_ENTRYPOINT ?? DEFAULT_ENTRYPOINT;
	const workload = process.env.PI_CLAUDE_CODE_WORKLOAD ?? process.env.CLAUDE_CODE_WORKLOAD;
	const workloadPart = workload ? ` cc_workload=${workload};` : "";
	return `${BILLING_PREFIX} cc_version=${version}; cc_entrypoint=${entrypoint}; cch=00000;${workloadPart}`;
}

function log(details: Record<string, unknown>): void {
	const logFile = process.env.PI_CLAUDE_OAUTH_LOG_FILE;
	if (!logFile) return;

	const path = resolve(logFile);
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...details })}\n`, "utf8");
	} catch {
		// 调试日志是可选的。
	}
}

export function registerClaudeSub(pi: ExtensionAPI): void {
	pi.registerProvider("anthropic", {
		headers: {
			"user-agent": `claude-cli/${claudeCodeVersion} (external, cli)`,
			"x-app": "cli",
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload;
		if (!shouldApply(ctx) || !isObject(payload)) return;

		const { system, messages } = payload as PayloadLike;
		const blocks = Array.isArray(system) ? system : [];
		if (blocks.some((block) => isTextBlock(block) && block.text.startsWith(BILLING_PREFIX))) return;

		const header: TextBlock = { type: "text", text: buildBillingHeader(messages) };
		log({ event: "billing_header_injected", header: header.text });
		return { ...payload, system: [header, ...blocks] };
	});
}
