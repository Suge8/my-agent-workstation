import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewerResult } from "../review/state.js";
import { cleanupFirecodeModules, loadFirecodeModule, TEST_REVIEW_CONFIG } from "./loader.ts";

type RegisterReview = typeof import("../review/index.js").registerReview;
type Flush = typeof import("../review/index.js").__reviewFlushForTests;
type WriteCheckpoint = typeof import("../review/checkpoint.js").writeCheckpoint;
type BeginCheckpoint = typeof import("../review/checkpoint.js").beginCheckpoint;
type ReadCheckpoint = typeof import("../review/checkpoint.js").readCheckpoint;
type CheckpointConflictError = typeof import("../review/checkpoint.js").CheckpointConflictError;
type InitialState = typeof import("../review/state.js").initialState;

let registerReview: RegisterReview;
let flush: Flush;
let writeCheckpoint: WriteCheckpoint;
let beginCheckpoint: BeginCheckpoint;
let readCheckpoint: ReadCheckpoint;
let CheckpointConflictErrorCtor: CheckpointConflictError;
let initialState: InitialState;

async function loadAll() {
	const index = (await loadFirecodeModule("review/index.js")) as {
		registerReview: RegisterReview;
		__reviewFlushForTests: Flush;
	};
	const checkpoint = (await loadFirecodeModule("review/checkpoint.js")) as {
		writeCheckpoint: WriteCheckpoint;
		beginCheckpoint: BeginCheckpoint;
		readCheckpoint: ReadCheckpoint;
		CheckpointConflictError: CheckpointConflictError;
	};
	const state = (await loadFirecodeModule("review/state.js")) as { initialState: InitialState };
	registerReview = index.registerReview;
	flush = index.__reviewFlushForTests;
	writeCheckpoint = checkpoint.writeCheckpoint;
	beginCheckpoint = checkpoint.beginCheckpoint;
	readCheckpoint = checkpoint.readCheckpoint;
	CheckpointConflictErrorCtor = checkpoint.CheckpointConflictError;
	initialState = state.initialState;
}

afterEach(cleanupFirecodeModules);

function makeSessionManager() {
	const entries: unknown[] = [];
	return {
		entries,
		getBranch: () => [...entries],
		getEntries: () => [...entries],
		appendCustomEntry: (customType: string, data?: unknown) => {
			entries.push({ type: "custom", customType, data });
		},
	};
}

type MockSessionManager = ReturnType<typeof makeSessionManager>;

function makeCtx(sessionManager: MockSessionManager, busy = false) {
	let idle = !busy;
	const statuses: (string | undefined)[] = [];
	const notices: string[] = [];
	return {
		statuses,
		notices,
		hasUI: true,
		cwd: "/tmp/firecode-test",
		sessionManager,
		isIdle: () => idle,
		hasPendingMessages: () => false,
		setIdle: (value: boolean) => {
			idle = value;
		},
		ui: {
			notify: (message: string) => { notices.push(message); },
			setStatus: (_key: string, value: string | undefined) => { statuses.push(value); },
		},
	};
}

function makeHeadlessCtx(sessionManager: MockSessionManager) {
	const ctx = makeCtx(sessionManager);
	ctx.hasUI = false;
	ctx.ui = new Proxy(ctx.ui, {
		get: () => { throw new Error("headless review dereferenced ctx.ui"); },
	});
	return ctx;
}

function makePi(sessionManager: MockSessionManager) {
	const registered: {
		renderers: Map<string, unknown>;
		commands: Map<string, unknown>;
		shortcuts: Map<string, unknown>;
		events: Map<string, ((...args: unknown[]) => unknown)[]>;
		sent: unknown[];
		emitted: { name: string; data: unknown }[];
	} = {
		renderers: new Map(),
		commands: new Map(),
		shortcuts: new Map(),
		events: new Map(),
		sent: [],
		emitted: [],
	};
	const pi = {
		registerMessageRenderer: (customType: string, renderer: unknown) => {
			registered.renderers.set(customType, renderer);
		},
		registerEntryRenderer: (customType: string, renderer: unknown) => {
			registered.renderers.set(customType, renderer);
		},
		registerCommand: (name: string, options: unknown) => {
			registered.commands.set(name, options);
		},
		registerShortcut: (key: string, options: unknown) => {
			registered.shortcuts.set(key, options);
		},
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			registered.events.set(event, [...(registered.events.get(event) ?? []), handler]);
		},
		sendMessage: (message: unknown) => {
			registered.sent.push(message);
		},
		appendEntry: (customType: string, data?: unknown) => {
			sessionManager.appendCustomEntry(customType, data);
		},
		events: {
			emit: (name: string, data: unknown) => registered.emitted.push({ name, data }),
		},
	};
	return { pi, registered };
}

function reviewer(index: number, status: ReviewerResult["status"], details: string): ReviewerResult {
	return { index, model: `m${index}`, thinking: "high", status, summary: "s", details };
}

async function loadReviewWithVerdict(verdict: string, maxRounds?: number) {
	const script = join(tmpdir(), `fake-review-${Date.now()}-${Math.random()}`);
	const review = (await loadFirecodeModule("review/index.js", {
		configJsonc: reviewConfig({
			reviewers: ["p/one/low"],
			...(maxRounds === undefined ? {} : { maxRounds }),
		}),
	})) as { registerReview: (pi: unknown, enabled?: boolean, broken?: boolean, dependencies?: unknown) => void };
	const checkpoint = (await loadFirecodeModule("review/checkpoint.js")) as {
		readCheckpoint: (ctx: unknown) => { phase: string } | undefined;
	};
	const outcome = (await loadFirecodeModule("review/outcome.js")) as {
		readReviewOutcome: (sessionPath: string) => { status: string; rounds?: number };
	};
	return {
		...checkpoint,
		...outcome,
		script,
		registerReview: (pi: unknown) => review.registerReview(pi, true, false, {
			runSession: async () => ({ kind: "output", text: verdict }),
		}),
	};
}

const FAIL_VERDICT = [
	"FAIL",
	"## 发现 1",
	"- 严重程度: 中",
	"- 问题: x",
	"- 证据: a.ts",
	"- 违反的契约或期望行为: y",
	"- 需要运行的验证命令: bun test",
].join("\n");

async function loadSingleFailReview() {
	return loadReviewWithVerdict(FAIL_VERDICT);
}

const OCCUPIED = { name: "herdr:blocked", data: { active: true, label: "对抗审查进行中" } };
const RELEASED = { name: "herdr:blocked", data: { active: false } };
const reviewConfig = (overrides: Record<string, unknown> = {}) =>
	JSON.stringify({ review: { ...TEST_REVIEW_CONFIG, ...overrides } });

describe("registerReview wiring", () => {
	test("registers the card renderer eagerly (top level, not in session_start)", async () => {
		await loadAll();
		const { pi, registered } = makePi(makeSessionManager());
		registerReview(pi as never);
		expect(registered.renderers.has("firecode-review-card")).toBe(true);
		expect(registered.renderers.size).toBe(1);
	}, 20_000);

	test("registers the fire-review command and session lifecycle events", async () => {
		await loadAll();
		const { pi, registered } = makePi(makeSessionManager());
		registerReview(pi as never);
		expect(registered.commands.has("fire-review")).toBe(true);
		expect(registered.events.has("session_start")).toBe(true);
		expect(registered.events.has("resources_discover")).toBe(true);
		expect(registered.events.has("agent_settled")).toBe(true);
		expect(registered.events.has("agent_end")).toBe(true);
		expect(registered.events.has("session_shutdown")).toBe(true);
	});

	test("holds Herdr occupancy exactly once until user cancellation", async () => {
		await loadAll();
		// 标签必须经 metadata state_labels 送达：herdr 会丢弃 report_agent 的 message（实测），
		// Master 的占用判定只读 state_labels。这里用桩 socket 验证持有/释放两次投递。
		const net = await import("node:net");
		const { mkdtemp, rm } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const directory = await mkdtemp(join(tmpdir(), "firecode-occupancy-"));
		const socketPath = join(directory, "herdr.sock");
		const metadataRequests: Array<Record<string, unknown>> = [];
		const waiters: Array<() => void> = [];
		// 首次清除注入失败：验证释放路径的重试，而不是只覆盖成功响应。
		let failNextClear = true;
		const server = net.createServer((socket) => {
			socket.on("data", (chunk) => {
				for (const line of chunk.toString().split("\n").filter(Boolean)) {
					const request = JSON.parse(line) as { params?: { clear_state_labels?: boolean } };
					metadataRequests.push(request as Record<string, unknown>);
					const fail = request.params?.clear_state_labels === true && failNextClear;
					if (fail) failNextClear = false;
					socket.write(`${JSON.stringify(fail ? { error: { code: "busy" } } : { result: { type: "ok" } })}\n`);
					for (const wake of waiters.splice(0)) wake();
				}
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		const awaitRequests = (count: number) =>
			new Promise<void>((resolve, reject) => {
				const deadline = setTimeout(() => reject(new Error("herdr stub timeout")), 2_000);
				const check = () => {
					if (metadataRequests.length < count) return waiters.push(check);
					clearTimeout(deadline);
					resolve();
				};
				check();
			});
		const previousEnv = { ...process.env };
		Object.assign(process.env, {
			HERDR_ENV: "1",
			HERDR_PANE_ID: "w1:pR",
			HERDR_SOCKET_PATH: socketPath,
		});
		try {
			await holdAndReleaseOccupancy();
		} finally {
			process.env = previousEnv;
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		}

		async function holdAndReleaseOccupancy() {
			await occupancyScenario();
			// 持有（带 TTL 租约）→ 清除（注入失败）→ 清除重试（成功）。
			await awaitRequests(3);
			expect(metadataRequests[0]).toMatchObject({
				method: "pane.report_metadata",
				params: {
					pane_id: "w1:pR",
					source: "firecode-review",
					state_labels: { blocked: "对抗审查进行中" },
					ttl_ms: 60_000,
				},
			});
			expect(metadataRequests[1]).toMatchObject({
				method: "pane.report_metadata",
				params: { source: "firecode-review", clear_state_labels: true },
			});
			expect(metadataRequests[2]).toMatchObject({
				method: "pane.report_metadata",
				params: { source: "firecode-review", clear_state_labels: true },
			});
			const seqs = metadataRequests.map((request) =>
				Number((request.params as Record<string, unknown>)?.seq),
			);
			expect(seqs[1]).toBeGreaterThan(seqs[0]);
			expect(seqs[2]).toBeGreaterThan(seqs[1]);
		}

		async function occupancyScenario() {
			const sessionManager = makeSessionManager();
			const { pi, registered } = makePi(sessionManager);
			registerReview(pi as never);
			const ctx = makeCtx(sessionManager, true);
			await runOccupancy(registered, ctx);
		}

		async function runOccupancy(
			registered: ReturnType<typeof makePi>["registered"],
			ctx: unknown,
		) {
			const command = registered.commands.get("fire-review") as {
				handler: (args: string, ctx: unknown) => Promise<void>;
			};
			await command.handler("", ctx);
			await flush();
			await command.handler("", ctx);
			await flush();
			expect(registered.emitted).toEqual([OCCUPIED]);

			const shutdown = (registered.events.get("session_shutdown") ?? [])[0] as (
				event: { reason: "quit" },
				ctx: unknown,
			) => Promise<void>;
			await shutdown({ reason: "quit" }, ctx);
			await flush();
			expect(registered.emitted).toEqual([OCCUPIED, RELEASED]);
		}
	});

	test("a missing control prompt settles as an infrastructure error", async () => {
		const module = (await loadFirecodeModule("review/index.js", {
			extraFiles: { "review/prompts/review.zh.md": "" },
		})) as { registerReview: (pi: unknown) => void };
		const checkpoint = (await loadFirecodeModule("review/checkpoint.js")) as {
			readCheckpoint: (ctx: unknown) => { phase: string; history: { result: string; details: string }[] } | undefined;
		};
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		module.registerReview(pi);
		const ctx = makeCtx(sessionManager);
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", ctx);
		for (let wait = 0; wait < 80; wait += 1) {
			if (checkpoint.readCheckpoint({ sessionManager })?.phase === "settled") break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		const state = checkpoint.readCheckpoint({ sessionManager });
		expect(state?.phase).toBe("settled");
		expect(state?.history.at(-1)?.result).toBe("error");
		expect(state?.history.at(-1)?.details).toContain("system prompt 为空");
	}, 10_000);

	test("releases Herdr occupancy when a review passes", async () => {
		const verdict = "PASS\n验证命令 exit 0。\n证据：文件=a.ts；命令=bun test";
		const { registerReview, readCheckpoint, script } = await loadReviewWithVerdict(verdict);
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const ctx = makeCtx(sessionManager);
		ctx.cwd = tmpdir();
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", ctx);
		for (let wait = 0; wait < 200; wait += 1) {
			if (readCheckpoint({ sessionManager })?.phase === "settled") break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
		expect(registered.emitted).toEqual([OCCUPIED, RELEASED]);
		await rm(script, { force: true });
	}, 20_000);

	test("a pass runs a summary turn: prompt delivered, occupancy held until the turn ends", async () => {
		const verdict = "PASS\n验证命令 exit 0。\n证据：文件=a.ts；命令=bun test";
		const { registerReview, readCheckpoint, script } = await loadReviewWithVerdict(verdict);
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const ctx = makeCtx(sessionManager);
		ctx.cwd = tmpdir();
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", ctx);
		// 质量裁决落地 → 总结提示已投递（awaiting_start），占用仍持有。
		for (let wait = 0; wait < 200; wait += 1) {
			if (readCheckpoint({ sessionManager })?.summary?.status === "awaiting_start") break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(readCheckpoint({ sessionManager })?.phase).toBe("summarizing");
		const sent = registered.sent as { customType?: string; content?: string; display?: boolean }[];
		const summaryIndex = sent.findIndex((message) => message.customType === "firecode-review-summary");
		const cardIndex = sent.findIndex((message) => message.customType === "firecode-review-card");
		expect(summaryIndex).toBeGreaterThan(cardIndex); // 结果卡先于总结提示
		expect(sent[cardIndex]?.content?.startsWith("<firecode_review>\n")).toBe(true);
		expect(sent[cardIndex]?.content?.endsWith("\n</firecode_review>")).toBe(true);
		expect(sent[summaryIndex]?.content?.startsWith("<firecode_review>\n")).toBe(true);
		expect(sent[summaryIndex]?.content).toContain("对抗审查已通过");
		expect(sent[summaryIndex]?.content).toContain("不要修改代码");
		expect(sent[summaryIndex]?.content?.endsWith("\n</firecode_review>")).toBe(true);
		expect(sent[summaryIndex]?.display).toBe(false);
		expect(registered.emitted).toEqual([OCCUPIED]);
		// 总结回合启动与结束 → settled，占用释放。
		for (const handler of registered.events.get("agent_start") ?? []) await handler({}, ctx);
		for (const handler of registered.events.get("agent_end") ?? [])
			await handler({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
		for (let wait = 0; wait < 80; wait += 1) {
			if (readCheckpoint({ sessionManager })?.phase === "settled") break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
		expect(readCheckpoint({ sessionManager })?.summary ?? null).toBeNull();
		expect(registered.emitted).toEqual([OCCUPIED, RELEASED]);
		await rm(script, { force: true });
	}, 20_000);

	test("releases Herdr occupancy when max rounds stops the review", async () => {
		const { registerReview, readCheckpoint, script } = await loadReviewWithVerdict(FAIL_VERDICT, 1);
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const ctx = makeCtx(sessionManager);
		ctx.cwd = tmpdir();
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", ctx);
		for (let wait = 0; wait < 200; wait += 1) {
			if (readCheckpoint({ sessionManager })?.phase === "settled") break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(readCheckpoint({ sessionManager })?.history.at(-1)?.result).toBe("failed");
		expect(registered.emitted).toEqual([OCCUPIED, RELEASED]);
		await rm(script, { force: true });
	}, 20_000);

	test("an occupancy signal failure does not stop the review", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		pi.events.emit = () => { throw new Error("Herdr unavailable"); };
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager, true);
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.phase).toBe("queued");

		const shutdown = (registered.events.get("session_shutdown") ?? [])[0] as (
			event: { reason: "quit" },
			ctx: unknown,
		) => Promise<void>;
		await shutdown({ reason: "quit" }, ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
	});

	test("headless review runs to a readable terminal verdict without UI access", async () => {
		const verdict = "PASS\n验证命令 exit 0。\n证据：文件=a.ts；命令=bun test";
		const { registerReview, readCheckpoint, readReviewOutcome, script } = await loadReviewWithVerdict(verdict);
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const ctx = makeHeadlessCtx(sessionManager);
		ctx.cwd = tmpdir();
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", ctx);
		for (let wait = 0; wait < 200; wait += 1) {
			if (readCheckpoint({ sessionManager })?.phase === "summarizing") break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(readCheckpoint({ sessionManager })?.phase).toBe("summarizing");
		for (const handler of registered.events.get("agent_start") ?? []) await handler({}, ctx);
		for (const handler of registered.events.get("agent_end") ?? [])
			await handler({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
		await flush();
		const sessionPath = `${script}.jsonl`;
		await writeFile(sessionPath, sessionManager.entries.map((entry) => JSON.stringify(entry)).join("\n"));
		expect(readReviewOutcome(sessionPath)).toMatchObject({ status: "passed", rounds: 1 });
		await rm(script, { force: true });
		await rm(sessionPath, { force: true });
	}, 20_000);

	test("headless session shutdown cancels the active review session", async () => {
		let started!: () => void;
		const sessionStarted = new Promise<void>((resolve) => { started = resolve; });
		const module = (await loadFirecodeModule("review/index.js", {
			configJsonc: reviewConfig({ reviewers: ["p/one/low"] }),
		})) as {
			registerReview: (pi: unknown, enabled?: boolean, broken?: boolean, dependencies?: unknown) => void;
			__reviewFlushForTests: () => Promise<void>;
		};
		const checkpoint = (await loadFirecodeModule("review/checkpoint.js")) as {
			readCheckpoint: (ctx: unknown) => { phase: string } | undefined;
		};
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		module.registerReview(pi, true, false, {
			runSession: ({ signal }: { signal?: AbortSignal }) => new Promise((resolve) => {
				started();
				signal?.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true });
			}),
		});
		const ctx = makeHeadlessCtx(sessionManager);
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", ctx);
		await sessionStarted;
		const shutdown = (registered.events.get("session_shutdown") ?? [])[0] as (
			event: { reason: "quit" },
			ctx: unknown,
		) => Promise<void>;
		await shutdown({ reason: "quit" }, ctx);
		await module.__reviewFlushForTests();
		expect(checkpoint.readCheckpoint({ sessionManager })?.phase).toBe("settled");
	}, 10_000);

	test("installs the activity bar and locks editor when review starts", async () => {
		const module = (await loadFirecodeModule("review/index.js", {
			configJsonc: reviewConfig(),
		})) as { registerReview: (pi: unknown) => void; __reviewFlushForTests: () => Promise<void> };
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		module.registerReview(pi);
		let widgetInstalled = false;
		let editorLocked = false;
		const ctx = makeCtx(sessionManager);
		Object.assign(ctx.ui, {
			setWidget: (key: string, next: unknown) => {
				if (key === "fire-review" && next !== undefined) widgetInstalled = true;
			},
			setEditorComponent: (next: unknown) => {
				if (next !== undefined) editorLocked = true;
			},
		});
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", ctx);
		await module.__reviewFlushForTests();
		expect(widgetInstalled).toBe(true);
		expect(editorLocked).toBe(true);
	});

	test("queued user cancellation notifies immediately without persisting a result card", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager, true);
		let editorFactory: ((tui: unknown, theme: unknown, keys: unknown) => { handleInput: (data: string) => void }) | undefined;
		Object.assign(ctx.ui, {
			setWidget: () => {},
			setWorkingVisible: () => {},
			setEditorComponent: (factory?: typeof editorFactory) => { editorFactory = factory; },
		});
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", ctx);
		await flush();
		if (!editorFactory) throw new Error("review editor was not installed");
		const editor = editorFactory(
			{ requestRender: () => {}, addInputListener: () => () => {} },
			{ borderColor: (text: string) => text, selectList: {} },
			{ matches: (data: string, action: string) => action === "app.interrupt" && data === "\x1b" },
		);
		editor.handleInput("\x1b");
		await flush();
		expect(ctx.notices).toContain("⏸ 审查已取消\n已按你的操作停止");
		expect(registered.sent.some((message) =>
			(message as { details?: { kind?: string } }).details?.kind === "cancel"
		)).toBe(false);
	});

	test("does not send cards or start reviewers before the current run is fully settled", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager, true);
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};

		await command.handler("", ctx);
		await flush();
		// streaming 时 sendMessage 会成为 steer；零发送是不能打断当前回复的关键合同。
		expect(registered.sent).toHaveLength(0);
		expect(readCheckpoint({ sessionManager })?.phase).toBe("queued");
		expect(ctx.statuses.at(-1)).toMatch(/^🔥 执行中 · 完成后自动审查 · 0(?:\.0)?s$/u);

		// FireCode 入口把 review 注册在所有自动续跑模块之后；收到 settled 时，
		// 先前 handler 已完成且没有发起续跑，才会到这里。
		ctx.setIdle(true);
		for (const handler of registered.events.get("agent_settled") ?? [])
			await handler({}, ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.phase).not.toBe("queued");
		expect(registered.sent.length).toBeGreaterThan(0);
	});

	test("the FireCode entry keeps the renderer when every feature is disabled", async () => {
		const entry = (await loadFirecodeModule("index.js", {
			configJsonc: JSON.stringify({
				features: {
					header: false,
					statusbar: false,
					tools: false,
					presets: false,
					rename: false,
					stats: false,
					claudeSub: false,
					openaiNative: false,
					review: false,
					master: false,
					watcher: false,
				},
			}),
		})) as { default: (pi: unknown) => void };
		const { pi, registered } = makePi(makeSessionManager());
		entry.default(pi);
		expect(registered.renderers.has("firecode-review-card")).toBe(true);
		expect(registered.commands.size).toBe(0);
	});

	test("Master remains available when review is disabled", async () => {
		const entry = (await loadFirecodeModule("index.js", {
			configJsonc: JSON.stringify({
				features: {
					header: false,
					statusbar: false,
					tools: false,
					presets: false,
					rename: false,
					stats: false,
					claudeSub: false,
					openaiNative: false,
					review: false,
					master: true,
				},
			}),
		})) as { default: (pi: unknown) => void };
		const { pi, registered } = makePi(makeSessionManager());
		entry.default({
			...pi,
			events: { ...pi.events, on() {} },
			registerTool() {},
			getActiveTools: () => [],
			setActiveTools() {},
		});
		expect(registered.commands.has("fire-review")).toBe(false);
		expect(registered.commands.has("fire-master")).toBe(true);
	});

	test("Master remains available when review configuration is invalid", async () => {
		const entry = (await loadFirecodeModule("index.js", {
			configJsonc: JSON.stringify({
				features: {
					header: false,
					statusbar: false,
					tools: false,
					presets: false,
					rename: false,
					stats: false,
					claudeSub: false,
					openaiNative: false,
					review: true,
					master: true,
				},
				review: { reviewers: "invalid" },
			}),
		})) as { default: (pi: unknown) => void };
		const { pi, registered } = makePi(makeSessionManager());
		entry.default({
			...pi,
			events: { ...pi.events, on() {} },
			registerTool() {},
			getActiveTools: () => [],
			setActiveTools() {},
		});
		expect(registered.commands.has("fire-master")).toBe(true);
	});

	test("review accepts focus text and rejects flags in the configured language", async () => {
		const module = (await loadFirecodeModule("review/index.js", {
			configJsonc: reviewConfig({ language: "en" }),
		})) as {
			registerReview: (pi: unknown) => void;
			__reviewFlushForTests: () => Promise<void>;
		};
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		module.registerReview(pi);
		const ctx = makeCtx(sessionManager, true);
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("--unknown=value", ctx);
		expect(ctx.notices).toContain("Invalid fire-review arguments.");
		await command.handler("focus", ctx);
		await module.__reviewFlushForTests();
		expect(registered.emitted).toEqual([OCCUPIED]);
	});

	test("disabled review still renders history and settles an active checkpoint", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		const state = {
			...initialState("disabled"),
			phase: "queued" as const,
			startedAt: 1,
			updatedAt: 1,
		};
		beginCheckpoint(pi as never, { sessionManager } as never, state);
		registerReview(pi as never, false);
		expect(registered.renderers.has("firecode-review-card")).toBe(true);
		expect(registered.commands.has("fire-review")).toBe(false);
		for (const handler of registered.events.get("session_start") ?? [])
			await handler({}, makeCtx(sessionManager));
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
	});

	test("a broken features config preserves the active checkpoint instead of sealing it", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		const state = {
			...initialState("config-broken"),
			phase: "queued" as const,
			startedAt: 1,
			updatedAt: 1,
		};
		beginCheckpoint(pi as never, { sessionManager } as never, state);
		// features 整节类型错误被安全回退成全关，但那是配置坏而非用户关闭：不得封存。
		registerReview(pi as never, false, true);
		expect(registered.commands.has("fire-review")).toBe(false);
		for (const handler of registered.events.get("session_start") ?? [])
			await handler({}, makeCtx(sessionManager));
		expect(readCheckpoint({ sessionManager })?.phase).toBe("queued");
	});
});

describe("checkpoint persistence", () => {
	test("write then read round-trips; a remembered-expected mismatch is a conflict", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi } = makePi(sessionManager);
		const ctx = { sessionManager };
		const state = initialState("run-1");
		// 首次写用 beginCheckpoint（无条件替换旧终态），返回本次写入凭证
		const first = beginCheckpoint(pi as never, ctx, state);
		expect(readCheckpoint(ctx)?.runId).toBe("run-1");
		expect(first).toEqual({ runId: "run-1", seq: 1 });

		// 后续写带凭证（本 controller 记住的上一次写入）；匹配则成功且 seq 递增
		const next = { ...state, phase: "queued" as const, updatedAt: 5 };
		const second = writeCheckpoint(pi as never, ctx, next, first);
		expect(readCheckpoint(ctx)?.phase).toBe("queued");
		expect(second.seq).toBe(2);

		// 陈旧写者：Run ID 相同但 seq 落后——只比 Run ID 时无法识别，必须拒绝
		expect(() => writeCheckpoint(pi as never, ctx, next, first)).toThrow(
			CheckpointConflictErrorCtor,
		);

		// 另一场审查的凭证同样冲突
		expect(() =>
			writeCheckpoint(pi as never, ctx, next, { runId: "run-9", seq: 2 }),
		).toThrow(CheckpointConflictErrorCtor);
	});

	test("real persist path detects a concurrent checkpoint writer and stops the review", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager, true) as never;
		const commandHandler = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		const shutdownHandler = (registered.events.get("session_shutdown") ?? [])[0] as (
			event: { type: string; reason: "quit" },
			ctx: unknown,
		) => unknown;

		// 1. 排队开始审查（busy）→ 首次写落 g1
		await commandHandler.handler("", ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.runId).toBeTruthy();
		const firstRunId = readCheckpoint({ sessionManager })?.runId;

		// 2. 模拟并发写者塞入不同 Run ID 的 checkpoint
		sessionManager.appendCustomEntry("firecode-review-checkpoint", {
			version: 5,
			seq: 1,
			runId: "foreign-writer",
			phase: "queued",
			round: 0,
			focus: "",
			history: [],
			active: null,
			pending: null,
			repair: null,
			summary: null,
			consecutiveFailures: 0,
			startedAt: 1,
			roundStartedAt: 1,
			updatedAt: 1,
		});

		// 3. quit 关闭 → CANCEL 落盘时撞上外来 Run ID → 冲突 → 停写并通知
		await shutdownHandler({ type: "session_shutdown", reason: "quit" }, ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.runId).toBe("foreign-writer");
		expect(firstRunId).toBeTruthy();
	});
});

describe("reload preserves recoverable state", () => {
	test("reload shutdown keeps the checkpoint active; session_start restores it", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager, true) as never;
		const commandHandler = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		const shutdownHandler = (registered.events.get("session_shutdown") ?? [])[0] as (
			event: { type: string; reason: string },
			ctx: unknown,
		) => unknown;
		const sessionStartHandler = (registered.events.get("session_start") ?? [])[0] as (
			event: unknown,
			ctx: unknown,
		) => unknown;

		// 1. 排队开始审查（queued），checkpoint 落成 queued
		await commandHandler.handler("", ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.phase).toBe("queued");
		const runId = readCheckpoint({ sessionManager })?.runId;

		// 2. reload 关闭：不 settle，checkpoint 保持 queued（可恢复）
		expect(registered.emitted).toEqual([OCCUPIED]);
		await shutdownHandler({ type: "session_shutdown", reason: "reload" }, ctx);
		await flush();
		expect(registered.emitted).toEqual([OCCUPIED, RELEASED]);
		const afterReload = readCheckpoint({ sessionManager });
		expect(afterReload?.phase).toBe("queued");
		expect(afterReload?.runId).toBe(runId);

		// 3. 新会话（同一 session 文件，新 pi 实例）session_start：从 checkpoint 恢复
		const { pi: pi2, registered: registered2 } = makePi(sessionManager);
		registerReview(pi2 as never);
		const sessionStartHandler2 = (registered2.events.get("session_start") ?? [])[0] as (
			event: unknown,
			ctx: unknown,
		) => unknown;
		const shutdownHandler2 = (registered2.events.get("session_shutdown") ?? [])[0] as (
			event: { type: string; reason: "quit" },
			ctx: unknown,
		) => unknown;
		await sessionStartHandler2({ type: "session_start", reason: "reload" }, ctx);
		await flush();
		expect(registered2.emitted).toEqual([OCCUPIED]);

		// 4. 恢复后的 controller 正常处理后续事件：quit 关闭 → CANCEL 落终态
		await shutdownHandler2({ type: "session_shutdown", reason: "quit" }, ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
		expect(registered2.emitted).toEqual([OCCUPIED, RELEASED]);
	});

	test("headless reload immediately settles a Review Run whose persisted overall deadline elapsed", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		beginCheckpoint(pi as never, { sessionManager } as never, {
			...initialState("expired-run"),
			phase: "queued",
			startedAt: Date.now() - 201 * 60_000,
			updatedAt: Date.now() - 201 * 60_000,
		});
		registerReview(pi as never);
		const start = (registered.events.get("session_start") ?? [])[0] as (
			event: unknown,
			ctx: unknown,
		) => Promise<void>;
		await start({}, makeHeadlessCtx(sessionManager));
		await flush();
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
	});
});

describe("review config is rejected at every entry point", () => {
	// 配置错误不能静默回退默认模型：那会拿用户没配的模型真实发起调用。
	// 命令入口与 checkpoint 恢复入口必须同标准。
	const brokenConfig = `{ "review": { "reviewers": "typo" } }`;
	// 整个文件语法坏掉时 review 节根本没被读到，错误信息也不带节名——
	// 曾因此被前缀过滤漏掉，然后拿默认审查者真实开跑。
	const unparsableConfig = "{";

	async function loadWithConfig(configJsonc: string) {
		return (await loadFirecodeModule("review/index.js", { configJsonc })) as {
			registerReview: (pi: unknown) => void;
		};
	}

	test("enabled Review requires an explicit complete section with models", async () => {
		for (const configJsonc of [
			'{"features":{"review":true}}',
			reviewConfig({ advisor: "", reviewers: [] }),
		]) {
			const { registerReview } = await loadWithConfig(configJsonc);
			const sessionManager = makeSessionManager();
			const { pi, registered } = makePi(sessionManager);
			registerReview(pi);
			const notices: string[] = [];
			const ctx = makeCtx(sessionManager);
			ctx.ui.notify = (message: string) => notices.push(message);
			const command = registered.commands.get("fire-review") as {
				handler: (args: string, ctx: unknown) => Promise<void>;
			};
			await command.handler("", ctx);
			expect(notices.join()).toContain("配置有问题");
			expect(sessionManager.entries).toHaveLength(0);
		}
	});

	test("the command refuses to start and spawns nothing", async () => {
		const { registerReview } = await loadWithConfig(brokenConfig);
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const notices: string[] = [];
		const ctx = makeCtx(sessionManager);
		ctx.ui.notify = (message: string) => notices.push(message);
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", ctx);
		expect(notices.join()).toContain("配置有问题");
		// 没有写入任何 checkpoint，等于没有启动审查
		expect(sessionManager.entries).toHaveLength(0);
	});

	test("an unknown review field also blocks the command", async () => {
		const { registerReview } = await loadWithConfig(`{ "review": { "reviewerz": [] } }`);
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const ctx = makeCtx(sessionManager);
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", ctx);
		expect(sessionManager.entries).toHaveLength(0);
	});

	test("an unparsable config file also blocks the command", async () => {
		const { registerReview } = await loadWithConfig(unparsableConfig);
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const notices: string[] = [];
		const ctx = makeCtx(sessionManager);
		ctx.ui.notify = (message: string) => notices.push(message);
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", ctx);
		expect(notices.join()).toContain("配置有问题");
		expect(sessionManager.entries).toHaveLength(0);
	});

	test("recovery from an active checkpoint refuses without sealing recoverable state", async () => {
		const { registerReview } = await loadWithConfig(brokenConfig);
		const sessionManager = makeSessionManager();
		sessionManager.entries.push({
			type: "custom",
			customType: "firecode-review-checkpoint",
			data: {
				version: 5,
				seq: 1,
				runId: "g",
				phase: "reviewing",
				round: 1,
				focus: "",
				history: [],
				active: {
					round: 1,
					reviewers: [{ index: 0, model: "m", thinking: "high", status: "running", result: null }],
					settledCount: 0,
				},
				pending: null,
				repair: null,
				summary: null,
				consecutiveFailures: 0,
				startedAt: 1,
				roundStartedAt: 1,
				updatedAt: 1,
			},
		});
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const notices: string[] = [];
		const ctx = makeCtx(sessionManager);
		ctx.ui.notify = (message: string) => notices.push(message);
		const handler = (registered.events.get("session_start") ?? [])[0] as (
			event: unknown,
			ctx: unknown,
		) => Promise<void>;
		await handler({ type: "session_start", reason: "startup" }, ctx);
		// 启动告警由 FireCode 入口统一聚合，review 只负责保留可恢复 checkpoint。
		expect(notices).toEqual([]);
		expect(readCheckpoint({ sessionManager })).toMatchObject({
			runId: "g",
			phase: "reviewing",
			seq: 1,
		});
	});
});

describe("reload recovery actually resumes the loop", () => {
	// resources_discover 是宿主提供的 post-session 边界：只有全部异步 session_start
	// handler 返回后才发，不能用 tick 或毫秒猜测。
	test("restored reviewers wait for the post-session event after later async handlers", async () => {
		await loadAll();
		const marker = join(tmpdir(), `fire-review-marker-${Date.now()}`);
		const module = (await loadFirecodeModule("review/index.js", {
			configJsonc: reviewConfig({ reviewers: ["p/one/low"] }),
		})) as {
			registerReview: (pi: unknown, enabled?: boolean, broken?: boolean, dependencies?: unknown) => void;
			__reviewFlushForTests: () => Promise<void>;
		};
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		let resolveReview!: () => void;
		const reviewSettled = new Promise<void>((resolve) => { resolveReview = resolve; });
		const sendMessage = pi.sendMessage;
		pi.sendMessage = (...args: unknown[]) => {
			(sendMessage as (...values: unknown[]) => void)(...args);
			resolveReview();
		};
		beginCheckpoint(pi as never, { sessionManager } as never, {
			...initialState("restore-review"),
			phase: "reviewing",
			round: 1,
			active: {
				round: 1,
				reviewers: [{ index: 0, model: "p/one", thinking: "low", status: "running", result: null }],
				settledCount: 0,
			},
			startedAt: Date.now(),
			roundStartedAt: Date.now(),
			updatedAt: Date.now(),
		});
		module.registerReview(pi, true, false, {
			runSession: async () => {
				await writeFile(marker, "started");
				return { kind: "empty" };
			},
		});
		const ctx = makeCtx(sessionManager);
		ctx.cwd = tmpdir();
		const sessionStart = (registered.events.get("session_start") ?? [])[0] as (event: unknown, ctx: unknown) => Promise<void>;
		await sessionStart({}, ctx);
		await module.__reviewFlushForTests();
		expect(existsSync(marker)).toBe(false);

		// 模拟后续 master handler 异步等待后触发续跑；post-session 事件此时才到。
		ctx.setIdle(false);
		for (const handler of registered.events.get("resources_discover") ?? []) await handler({}, ctx);
		await module.__reviewFlushForTests();
		expect(existsSync(marker)).toBe(false);

		ctx.setIdle(true);
		for (const handler of registered.events.get("agent_settled") ?? []) await handler({}, ctx);
		await reviewSettled;
		expect(existsSync(marker)).toBe(true);
		await rm(marker, { force: true });
	});

	test("reload before repair agent_start re-delivers feedback without advancing the round", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		beginCheckpoint(pi as never, { sessionManager } as never, {
			...initialState("restore-repair"),
			phase: "awaiting_fix",
			round: 1,
			repair: { details: "FAIL", advisor: null, status: "awaiting_start" },
			startedAt: Date.now(),
			roundStartedAt: Date.now(),
			updatedAt: Date.now(),
		});
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager);
		const sessionStart = (registered.events.get("session_start") ?? [])[0] as (event: unknown, ctx: unknown) => Promise<void>;
		await sessionStart({}, ctx);
		ctx.setIdle(false);
		await flush();
		expect(readCheckpoint({ sessionManager })?.repair?.status).toBe("pending");
		expect(registered.sent).toHaveLength(0);

		ctx.setIdle(true);
		for (const handler of registered.events.get("resources_discover") ?? []) await handler({}, ctx);
		await flush();
		const restored = readCheckpoint({ sessionManager });
		expect(restored?.phase).toBe("awaiting_fix");
		expect(restored?.round).toBe(1);
		expect(restored?.repair?.status).toBe("awaiting_start");
		expect(
			registered.sent.some((message) => (message as { customType?: string }).customType === "firecode-review-feedback"),
		).toBe(true);
	});

	test("a queued review resumes on session_start when the session is idle", async () => {
		const { registerReview } = (await loadFirecodeModule("review/index.js", {
			configJsonc: reviewConfig(),
		})) as { registerReview: (pi: unknown) => void };
		const checkpointModule = (await loadFirecodeModule("review/checkpoint.js")) as {
			readCheckpoint: (ctx: unknown) => { phase: string } | undefined;
		};
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		registerReview(pi);
		const busyCtx = makeCtx(sessionManager, true);
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", busyCtx);
		await flush();
		expect(checkpointModule.readCheckpoint({ sessionManager })?.phase).toBe("queued");

		const shutdown = (registered.events.get("session_shutdown") ?? [])[0] as (
			event: { type: string; reason: string },
			ctx: unknown,
		) => unknown;
		await shutdown({ type: "session_shutdown", reason: "reload" }, busyCtx);
		await flush();

		const { pi: pi2, registered: registered2 } = makePi(sessionManager);
		registerReview(pi2);
		const sessionStart = (registered2.events.get("session_start") ?? [])[0] as (
			event: unknown,
			ctx: unknown,
		) => unknown;
		const restoredCtx = makeCtx(sessionManager, false);
		await sessionStart({ type: "session_start", reason: "reload" }, restoredCtx);
		await flush();
		expect(checkpointModule.readCheckpoint({ sessionManager })?.phase).toBe("queued");
		for (const handler of registered2.events.get("resources_discover") ?? []) await handler({}, restoredCtx);
		await flush();

		expect(checkpointModule.readCheckpoint({ sessionManager })?.phase).not.toBe("queued");
	});
});

describe("the loop survives failing side effects", () => {
	// dispatchQueue 一旦 rejected 就再也不执行后续迁移，连 esc 取消都会失效。
	test("a throwing send keeps later dispatches (including cancel) working", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		let failNextSend = true;
		pi.sendMessage = () => {
			if (!failNextSend) return;
			failNextSend = false;
			throw new Error("UI 挂了");
		};
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager, true) as never;
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		const shutdown = (registered.events.get("session_shutdown") ?? [])[0] as (
			event: { type: string; reason: "quit" },
			ctx: unknown,
		) => unknown;

		// 启动时发卡抛错：不能让状态机就此死掉
		await command.handler("", ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.phase).toBe("queued");

		// 后续迁移仍然生效 → quit 能把审查收成终态
		await shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
		await flush();
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
	});

	// 发卡只是展示，失败不能吞掉同一迁移里的推进请求。
	test("a failing card does not swallow the effects after it", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		pi.sendMessage = () => {
			throw new Error("UI 挂了");
		};
		registerReview(pi as never);
		const ctx = makeCtx(sessionManager, false) as never;
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", ctx);
		await flush();
		// 启动卡发送失败，但仍离开 queued 并实际跑完审查者。
		expect(readCheckpoint({ sessionManager })?.phase).not.toBe("queued");
	});

	// 宿主 sendMessage 返回 void，异步失败不会 throw；必须靠 agent_start 回执超时收口，
	// 不能用同步 throw 的假 API 制造假覆盖。
	test("feedback without an agent_start receipt cancels instead of stranding awaiting_fix", async () => {
		const { registerReview, readCheckpoint, script } = await loadSingleFailReview();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		// 与真实宿主一致：调用立即返回 void，异步失败不会反馈给插件，也没有 agent_start。
		registerReview(pi);
		const ctx = makeCtx(sessionManager, false);
		ctx.cwd = tmpdir();
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", ctx);
		for (let wait = 0; wait < 200; wait += 1) {
			if (readCheckpoint({ sessionManager })?.phase === "settled") break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(
			registered.sent.some(
				(message) => (message as { customType?: string }).customType === "firecode-review-feedback",
			),
		).toBe(true);
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
		await rm(script, { force: true });
	}, 25_000);

	test("a synchronous feedback failure cancels without dispatchQueue self-deadlock", async () => {
		const { registerReview, readCheckpoint, script } = await loadSingleFailReview();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		pi.sendMessage = (message: { customType?: string }) => {
			if (message.customType === "firecode-review-feedback") throw new Error("同步拒绝");
		};
		registerReview(pi);
		const ctx = makeCtx(sessionManager);
		ctx.cwd = tmpdir();
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", ctx);
		for (let wait = 0; wait < 200; wait += 1) {
			if (readCheckpoint({ sessionManager })?.phase === "settled") break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(readCheckpoint({ sessionManager })?.phase).toBe("settled");
		await rm(script, { force: true });
	}, 20_000);

	// 持久化失败不能被当成成功继续，否则会拿不一致的状态起审查会话、投反馈。
	test("a checkpoint write failure stops the review instead of pressing on", async () => {
		await loadAll();
		const sessionManager = makeSessionManager();
		const { pi, registered } = makePi(sessionManager);
		pi.appendEntry = () => {
			throw new Error("会话写入失败");
		};
		registerReview(pi as never);
		const notices: string[] = [];
		const ctx = makeCtx(sessionManager, false);
		ctx.ui.notify = (message: string) => notices.push(message);
		const command = registered.commands.get("fire-review") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		await command.handler("", ctx);
		await flush();
		expect(notices.join()).toContain("写入失败");
		// 没有落盘，也没有把审查推进下去
		expect(sessionManager.entries).toHaveLength(0);

		// 失败必须连内存态一起释放：否则幽灵审查只是从磁盘搬进内存，
		// 后续命令永远被「已有审查在进行中」挡住且无处取消。
		notices.length = 0;
		await command.handler("", ctx);
		await flush();
		expect(notices.join()).not.toContain("已有审查在进行中");
	});
});
