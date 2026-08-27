import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_AI_COMPAT_URL, PI_CODING_AGENT_URL } from "./loader.ts";

const { fauxAssistantMessage, fauxToolCall, registerFauxProvider } = await import(PI_AI_COMPAT_URL) as any;
const DELIVERY_TEXT = "queued delivery";
let directory: string | undefined;
let faux: any;

afterEach(async () => {
	faux?.unregister();
	faux = undefined;
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

test("streaming steer delivery preserves the sent prefix and reaches the next request after tool results", async () => {
	directory = await mkdtemp(join(tmpdir(), "firecode-delivery-contract-"));
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	const extensionsDir = join(agentDir, "extensions");
	await Promise.all([mkdir(cwd), mkdir(extensionsDir, { recursive: true })]);
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "faux-key" } }));
	await writeFile(join(extensionsDir, "delivery.ts"), `
export default function (pi) {
	let delivered = false;
	pi.on("tool_execution_start", () => {
		if (delivered) return;
		delivered = true;
		pi.sendMessage(
			{ customType: "delivery-contract", content: ${JSON.stringify(DELIVERY_TEXT)}, display: false },
			{ deliverAs: "steer", triggerTurn: true },
		);
	});
}
`);

	faux = registerFauxProvider();
	const { createAgentSession, ModelRuntime, SessionManager } = await import(PI_CODING_AGENT_URL) as any;
	const model = faux.getModel();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [model],
	});
	const requests: any[][] = [];
	faux.setResponses([
		(context: any) => {
			requests.push(structuredClone(context.messages));
			return fauxAssistantMessage(fauxToolCall("contract_wait", {}), { stopReason: "toolUse" });
		},
		(context: any) => {
			requests.push(structuredClone(context.messages));
			return fauxAssistantMessage("delivery observed");
		},
	]);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime,
		tools: ["contract_wait"],
		customTools: [{
			name: "contract_wait",
			label: "Contract wait",
			description: "Completes one deterministic tool call",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			execute: async () => ({ content: [{ type: "text", text: "tool completed" }], details: {} }),
		}],
		sessionManager: SessionManager.inMemory(cwd),
	});

	try {
		await session.prompt("start contract run");
		const [inFlightRequest, nextRequest] = requests;
		const messageText = (message: any) => typeof message.content === "string"
			? message.content
			: message.content?.map((part: any) => part.text ?? "").join("") ?? "";

		expect(requests).toHaveLength(2);
		expect(inFlightRequest.some((message) => messageText(message) === DELIVERY_TEXT)).toBe(false);
		expect(nextRequest.slice(0, inFlightRequest.length)).toEqual(inFlightRequest);
		expect(nextRequest.slice(inFlightRequest.length).map((message) => message.role)).toEqual([
			"assistant",
			"toolResult",
			"user",
		]);
		expect(messageText(nextRequest.at(-2))).toContain("tool completed");
		expect(messageText(nextRequest.at(-1))).toBe(DELIVERY_TEXT);
	} finally {
		session.dispose();
	}
}, 10_000);

test("idle wake via sendUserMessage runs before_agent_start on every request", async () => {
	directory = await mkdtemp(join(tmpdir(), "firecode-delivery-wake-"));
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	const extensionsDir = join(agentDir, "extensions");
	await Promise.all([mkdir(cwd), mkdir(extensionsDir, { recursive: true })]);
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "faux-key" } }));
	await writeFile(join(extensionsDir, "mark.ts"), `
export default function (pi) {
	pi.on("before_agent_start", async (event) => ({ systemPrompt: event.systemPrompt + "\\n\\nGUIDELINES-MARK" }));
}
`);

	faux = registerFauxProvider();
	const { createAgentSession, ModelRuntime, SessionManager } = await import(PI_CODING_AGENT_URL) as any;
	const model = faux.getModel();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
	const prompts: string[] = [];
	faux.setResponses([
		(context: any) => {
			prompts.push(context.systemPrompt ?? "");
			return fauxAssistantMessage(fauxToolCall("contract_wait", {}), { stopReason: "toolUse" });
		},
		(context: any) => {
			prompts.push(context.systemPrompt ?? "");
			return fauxAssistantMessage("woken");
		},
	]);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime,
		tools: ["contract_wait"],
		customTools: [{
			name: "contract_wait",
			label: "Contract wait",
			description: "Completes one deterministic tool call",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			execute: async () => ({ content: [{ type: "text", text: "tool completed" }], details: {} }),
		}],
		sessionManager: SessionManager.inMemory(cwd),
	});

	try {
		// 会话歇透时的前门唤醒：deliver.ts 空闲分支依赖的宿主契约。
		await session.sendUserMessage("delivered while idle");
		expect(prompts).toHaveLength(2);
		expect(prompts.every((prompt) => prompt.includes("GUIDELINES-MARK"))).toBe(true);
	} finally {
		session.dispose();
	}
}, 10_000);
