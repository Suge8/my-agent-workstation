/**
 * 审查者 / 顾问共用的 pi 子进程执行器：spawn `pi --mode json`，解析 stdout 事件流
 * 提取最终 assistant 文本，处理超时 / 取消（进程树击杀）。可靠性参考
 * pi-flow 的 review-process + exec-file-runner 的思路，砍掉 fork-harness 与进度事件。
 */
import { spawn, type ChildProcess } from "node:child_process";

const TERM_SIGNAL: NodeJS.Signals = "SIGTERM";
const KILL_SIGNAL: NodeJS.Signals = "SIGKILL";
const TERM_GRACE_MS = 1000;
const CLOSE_FALLBACK_MS = 1000;
const STDERR_TAIL = 16_384;
/** 单行事件上限：message_end 携带完整回复，只防失控增长，不参与正常截断。 */
const MAX_LINE = 8 * 1024 * 1024;

export type PiProcessResult =
	| { kind: "output"; text: string }
	| { kind: "empty"; stderr: string }
	| { kind: "timeout"; stderr: string }
	| { kind: "aborted" }
	| { kind: "error"; message: string; stderr: string };

/** 子进程实时进度：每行 JSON 事件解析后回调，供活动条展示。 */
export type PiProcessEvent = Record<string, unknown>;

export interface PiProcessOptions {
	command: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
	onEvent?: (event: PiProcessEvent) => void;
}

export function runPiProcess(options: PiProcessOptions): Promise<PiProcessResult> {
	if (options.signal?.aborted)
		return Promise.resolve({ kind: "aborted" });
	return new Promise((resolve) => {
		const child = spawn(options.command, options.args, {
			cwd: options.cwd,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		// stdout 是逐行 JSON 事件流：按行增量消费，只留未完成的残行。
		// （旧实现套用 stderr 的尾部截断，会把最后一条 message_end 的行首切掉，
		// 整行解析失败后长输出被误判为空。）
		let pending = "";
		let stderr = "";
		let messageEndText: string | undefined;
		let agentEndText: string | undefined;
		const assistantText = () =>
			messageEndText?.trim() ? messageEndText : (agentEndText ?? "");

		const consumeLine = (line: string) => {
			if (!line.trim()) return;
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (!isRecord(event)) return;
			const text = finalAssistantText(event);
			if (text !== undefined) {
				if (event.type === "message_end") messageEndText = text;
				else agentEndText = text;
			}
			options.onEvent?.(event);
		};
		let settled = false;
		let timedOut = false;
		let aborted = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let timeoutKill: ReturnType<typeof setTimeout> | undefined;
		let closeFallback: ReturnType<typeof setTimeout> | undefined;

		const finish = (result: PiProcessResult) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			if (timeoutKill) clearTimeout(timeoutKill);
			if (closeFallback) clearTimeout(closeFallback);
			options.signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};

		const startTimeout = () => {
			timeout = setTimeout(() => {
				timedOut = true;
				killProcessTree(child, TERM_SIGNAL);
				timeoutKill = setTimeout(() => {
					if (settled) return;
					killProcessTree(child, KILL_SIGNAL);
					if (child.exitCode !== null) {
						finish({ kind: "timeout", stderr });
						return;
					}
					closeFallback = setTimeout(
						() => finish({ kind: "timeout", stderr }),
						CLOSE_FALLBACK_MS,
					);
				}, TERM_GRACE_MS);
			}, options.timeoutMs);
		};

		const onAbort = () => {
			if (aborted || settled) return;
			aborted = true;
			killProcessTree(child, KILL_SIGNAL);
			closeFallback = setTimeout(
				() => finish({ kind: "aborted" }),
				CLOSE_FALLBACK_MS,
			);
		};

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			pending += chunk;
			for (;;) {
				const index = pending.indexOf("\n");
				if (index === -1) break;
				const line = pending.slice(0, index);
				pending = pending.slice(index + 1);
				consumeLine(line);
			}
			// 单行超过上限（正常事件不会）：丢弃该行，避免内存无限增长。
			if (pending.length > MAX_LINE) pending = "";
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL);
		});
		child.on("spawn", startTimeout);
		child.on("error", (error) =>
			finish(
				aborted
					? { kind: "aborted" }
					: timedOut
						? { kind: "timeout", stderr }
						: { kind: "error", message: error.message, stderr },
			),
		);
		child.on("close", (code, signal) => {
			consumeLine(pending);
			pending = "";
			if (aborted) {
				finish({ kind: "aborted" });
				return;
			}
			if (timedOut) {
				finish({ kind: "timeout", stderr });
				return;
			}
			const text = assistantText();
			if (code === 0)
				finish(
					text.trim()
						? { kind: "output", text }
						: { kind: "empty", stderr: stderr.trim() },
				);
			else
				finish({
					kind: "error",
					message: failureMessage(code, signal),
					stderr: stderr.trim(),
				});
		});
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();
	});
}

function failureMessage(code: number | null, signal: NodeJS.Signals | null) {
	if (code !== null) return `子进程失败，退出码 ${code}`;
	return `子进程被信号 ${signal ?? "unknown"} 终止`;
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
	const pid = child.pid;
	if (!pid) return;
	if (process.platform === "win32") {
		try {
			child.kill(signal);
		} catch {
			// 已退出
		}
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// 已退出
		}
	}
}

/**
 * 从单条事件提取最终 assistant 文本（纯函数）：message_end 优先，
 * agent_end 回退取最后一条 assistant。非终局事件返回 undefined。
 */
function finalAssistantText(event: Record<string, unknown>): string | undefined {
	if (event.type === "message_end") {
		const message = asRecord(event.message);
		return message?.role === "assistant" ? messageText(message.content) : undefined;
	}
	if (event.type === "agent_end" && Array.isArray(event.messages)) {
		for (let index = event.messages.length - 1; index >= 0; index -= 1) {
			const message = asRecord(event.messages[index]);
			if (message?.role === "assistant") {
				const text = messageText(message.content);
				if (text !== undefined) return text;
			}
		}
	}
	return undefined;
}

function messageText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const part of content) {
		const record = asRecord(part);
		if (record?.type === "text" && typeof record.text === "string")
			parts.push(record.text);
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
