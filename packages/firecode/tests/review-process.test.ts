import { afterEach, describe, expect, test } from "bun:test";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

type RunPiProcess = typeof import("../review/process.js").runPiProcess;

async function loadRunner(): Promise<RunPiProcess> {
	const module = (await loadFirecodeModule("review/process.js")) as {
		runPiProcess: RunPiProcess;
	};
	return module.runPiProcess;
}

/** 用 node 当假 pi：按 `--mode json` 的逐行事件协议输出。 */
function fakePi(script: string) {
	return { command: process.execPath, args: ["-e", script] };
}

const emit = (event: unknown) =>
	`process.stdout.write(JSON.stringify(${JSON.stringify(event)}) + "\\n");`;

function assistantEvent(text: string) {
	return {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text }] },
	};
}

afterEach(cleanupFirecodeModules);

describe("pi subprocess stdout handling", () => {
	// 回归：stdout 曾套用 stderr 的「只留尾部 16KiB」策略，会把最后一条 message_end
	// 的行首切掉，整行 JSON 解析失败后长输出被误判为空。stdout 是逐行事件流，只能按行消费。
	test("extracts the full assistant text when the event stream exceeds the old 16 KiB tail", async () => {
		const runPiProcess = await loadRunner();
		const body = `FAIL\n${"发现内容 ".repeat(4000)}`;
		expect(body.length).toBeGreaterThan(16 * 1024);
		const script = [
			`const noise = ${JSON.stringify(JSON.stringify({ type: "message_start" }))};`,
			"for (let i = 0; i < 200; i++) process.stdout.write(noise + \"\\n\");",
			emit(assistantEvent(body)),
		].join("\n");
		const result = await runPiProcess({
			...fakePi(script),
			cwd: process.cwd(),
			timeoutMs: 30_000,
		});
		expect(result.kind).toBe("output");
		expect(result.kind === "output" && result.text).toBe(body);
	});

	test("consumes a trailing event that arrives without a final newline", async () => {
		const runPiProcess = await loadRunner();
		const script = `process.stdout.write(JSON.stringify(${JSON.stringify(
			assistantEvent("PASS\nok"),
		)}));`;
		const result = await runPiProcess({
			...fakePi(script),
			cwd: process.cwd(),
			timeoutMs: 30_000,
		});
		expect(result.kind === "output" && result.text).toBe("PASS\nok");
	});

	test("streams parsed events to onEvent for live progress", async () => {
		const runPiProcess = await loadRunner();
		const script = [
			emit({ type: "tool_execution_start", toolName: "read", args: { file: "a.ts" } }),
			emit(assistantEvent("PASS\nok")),
		].join("\n");
		const seen: string[] = [];
		await runPiProcess({
			...fakePi(script),
			cwd: process.cwd(),
			timeoutMs: 30_000,
			onEvent: (event) => {
				if (typeof event.type === "string") seen.push(event.type);
			},
		});
		expect(seen).toEqual(["tool_execution_start", "message_end"]);
	});

	test("reports empty output only when the process really produced no assistant text", async () => {
		const runPiProcess = await loadRunner();
		const result = await runPiProcess({
			...fakePi('process.stdout.write("not json\\n");'),
			cwd: process.cwd(),
			timeoutMs: 30_000,
		});
		expect(result.kind).toBe("empty");
	});
});
