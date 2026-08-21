import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { brokerHandshakeIfRunning, requestBroker, requestRunningBroker } from "./client.ts";
import {
	type ActParams,
	type CliCommandExecutor,
	type CliCommandName,
	type CliCommandParams,
	type EvaluateBrowserParams,
	type ExpandUiParams,
	type FindParams,
	type InspectUiParams,
	type LaunchBrowserParams,
	type NavigateBrowserParams,
	type ObserveParams,
	type ReadTextParams,
	type SearchUiParams,
	type ToolResult,
	type UiAction,
	type WaitForParams,
} from "./contract.ts";
import { BcuError, formatCliError, normalizeCliError } from "./errors.ts";

function executor<Name extends CliCommandName>(name: Name): CliCommandExecutor<Name> {
	return async (params, signal) => await requestBroker<ToolResult>(name, params, signal);
}

export const CLI_COMMANDS = {
	"find-roots": executor("find-roots"),
	"observe-ui": executor("observe-ui"),
	"search-ui": executor("search-ui"),
	"expand-ui": executor("expand-ui"),
	"inspect-ui": executor("inspect-ui"),
	"act-ui": executor("act-ui"),
	"read-text": executor("read-text"),
	"wait-for": executor("wait-for"),
	"launch-browser": executor("launch-browser"),
	"navigate-browser": executor("navigate-browser"),
	"evaluate-browser": executor("evaluate-browser"),
} satisfies { [Name in CliCommandName]: CliCommandExecutor<Name> };

const USAGE = `Usage: bcu <command> [options]

Commands:
  find-roots       Find desktop windows and browser pages
  observe-ui       Observe one root and return a stateId
  search-ui        Search a saved UI outline
  expand-ui        Expand one saved element
  inspect-ui       Inspect one saved element
  act-ui           Read an action array from stdin and execute it
  read-text        Read text owned by a saved state
  wait-for         Wait for text or a role to appear or disappear
  browser launch   Launch a managed browser
  browser navigate Navigate a browser state
  browser eval     Evaluate JavaScript in a browser state
  status           Report Broker status without starting it
  doctor           Start and diagnose Broker, helper, permissions, and config
  setup            Register and verify macOS permissions
  stop             Stop the Broker if it is running

Global options:
  --json           Emit one JSON result on stdout
  -h, --help       Show this help

Run docs/usage.md for the complete option reference.`;

type OptionKind = "string" | "number" | "boolean";
interface OptionSpec {
	key: string;
	kind: OptionKind;
	values?: readonly string[];
}
interface ParsedOptions {
	values: Record<string, string | number | boolean>;
	positionals: string[];
}

const STATE = { key: "stateId", kind: "string" } as const;
const IMAGE = { key: "image", kind: "string", values: ["auto", "always", "never"] } as const;

function invalid(message: string): never {
	throw new BcuError("invalid_arguments", message);
}

function parseOptions(args: string[], specs: Record<string, OptionSpec>): ParsedOptions {
	const values: ParsedOptions["values"] = {};
	const positionals: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (!argument.startsWith("--")) {
			positionals.push(argument);
			continue;
		}
		const spec = specs[argument];
		if (!spec) invalid(`Unknown option '${argument}'.`);
		if (spec.key in values) invalid(`Option '${argument}' may be supplied only once.`);
		if (spec.kind === "boolean") {
			values[spec.key] = true;
			continue;
		}
		const raw = args[++index];
		if (raw === undefined || raw.startsWith("--")) invalid(`Option '${argument}' requires a value.`);
		if (spec.kind === "number") {
			const value = Number(raw);
			if (!Number.isFinite(value)) invalid(`Option '${argument}' requires a number.`);
			values[spec.key] = value;
		} else {
			if (spec.values && !spec.values.includes(raw)) invalid(`Option '${argument}' must be one of: ${spec.values.join(", ")}.`);
			values[spec.key] = raw;
		}
	}
	return { values, positionals };
}

function noPositionals(parsed: ParsedOptions): void {
	if (parsed.positionals.length > 0) invalid(`Unexpected argument '${parsed.positionals[0]}'.`);
}

function required(values: ParsedOptions["values"], key: string, option: string): string {
	const value = values[key];
	if (typeof value !== "string" || !value.trim()) invalid(`Option '${option}' is required.`);
	return value.trim();
}

function optionalString(values: ParsedOptions["values"], key: string): string | undefined {
	const value = values[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(values: ParsedOptions["values"], key: string): number | undefined {
	const value = values[key];
	return typeof value === "number" ? value : undefined;
}

function parseFind(args: string[]): FindParams {
	const parsed = parseOptions(args, {
		"--query": { key: "query", kind: "string" },
		"--app": { key: "app", kind: "string" },
		"--bundle-id": { key: "bundleId", kind: "string" },
		"--pid": { key: "pid", kind: "number" },
		"--kind": { key: "kind", kind: "string", values: ["window", "menu", "sheet", "popover", "dialog", "browser_page"] },
	});
	noPositionals(parsed);
	return parsed.values as FindParams;
}

function parseObserve(args: string[]): ObserveParams {
	const parsed = parseOptions(args, {
		"--app": { key: "app", kind: "string" },
		"--window-title": { key: "windowTitle", kind: "string" },
		"--root": { key: "root", kind: "string" },
		"--image": IMAGE,
		"--mode": { key: "mode", kind: "string", values: ["semantic", "visual", "fused"] },
		"--read-text": { key: "readText", kind: "string", values: ["auto", "always", "never"] },
	});
	noPositionals(parsed);
	return parsed.values as ObserveParams;
}

function parseSearch(args: string[]): SearchUiParams {
	const parsed = parseOptions(args, {
		"--state": STATE,
		"--text": { key: "text", kind: "string" },
		"--role": { key: "role", kind: "string" },
		"--action": { key: "action", kind: "string" },
		"--limit": { key: "limit", kind: "number" },
	});
	noPositionals(parsed);
	required(parsed.values, "stateId", "--state");
	return parsed.values as SearchUiParams;
}

function parseExpand(args: string[]): ExpandUiParams {
	const parsed = parseOptions(args, {
		"--state": STATE,
		"--ref": { key: "ref", kind: "string" },
		"--depth": { key: "depth", kind: "number" },
	});
	noPositionals(parsed);
	return {
		stateId: required(parsed.values, "stateId", "--state"),
		ref: required(parsed.values, "ref", "--ref"),
		depth: optionalNumber(parsed.values, "depth"),
	};
}

function parseInspect(args: string[]): InspectUiParams {
	const parsed = parseOptions(args, {
		"--state": STATE,
		"--ref": { key: "ref", kind: "string" },
		"--include-raw": { key: "includeRaw", kind: "boolean" },
	});
	noPositionals(parsed);
	return {
		stateId: required(parsed.values, "stateId", "--state"),
		ref: required(parsed.values, "ref", "--ref"),
		includeRaw: parsed.values.includeRaw === true || undefined,
	};
}

const ACTIONS = new Set<UiAction["action"]>(["press", "click", "doubleClick", "setText", "typeText", "keypress", "scroll", "drag", "moveMouse", "wait"]);

async function readStdin(): Promise<string> {
	let input = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) input += chunk;
	return input;
}

async function readActions(): Promise<UiAction[]> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readStdin());
	} catch (error) {
		invalid(`act-ui stdin must be a JSON action array: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(parsed)) invalid("act-ui stdin must contain a JSON action array.");
	for (const action of parsed) {
		if (!action || typeof action !== "object" || !("action" in action) || !ACTIONS.has((action as UiAction).action)) {
			invalid("Every act-ui item must be an object with a supported action name.");
		}
	}
	return parsed as UiAction[];
}

async function parseAct(args: string[]): Promise<ActParams> {
	const parsed = parseOptions(args, {
		"--state": STATE,
		"--headless": { key: "headless", kind: "boolean" },
		"--image": IMAGE,
		"--expect-text": { key: "expectText", kind: "string" },
		"--expect-role": { key: "expectRole", kind: "string" },
		"--expect-value": { key: "expectValue", kind: "string" },
		"--expect-gone": { key: "expectGone", kind: "boolean" },
		"--timeout": { key: "timeoutMs", kind: "number" },
	});
	if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "-") invalid("act-ui requires '-' and reads its JSON action array from stdin.");
	const stateId = required(parsed.values, "stateId", "--state");
	const text = optionalString(parsed.values, "expectText");
	const role = optionalString(parsed.values, "expectRole");
	const value = optionalString(parsed.values, "expectValue");
	const gone = parsed.values.expectGone === true;
	const timeoutMs = optionalNumber(parsed.values, "timeoutMs");
	if ((gone || timeoutMs !== undefined) && !text && !role && !value) invalid("--expect-gone and --timeout require --expect-text, --expect-role, or --expect-value.");
	const expect = text || role || value ? { text, role, value, gone: gone || undefined, timeoutMs } : undefined;
	return {
		stateId,
		actions: await readActions(),
		headless: parsed.values.headless === true || undefined,
		image: parsed.values.image as ActParams["image"],
		expect,
	};
}

function parseReadText(args: string[]): ReadTextParams {
	const parsed = parseOptions(args, {
		"--state": STATE,
		"--ref": { key: "ref", kind: "string" },
		"--offset": { key: "offset", kind: "number" },
		"--limit": { key: "limit", kind: "number" },
	});
	noPositionals(parsed);
	required(parsed.values, "stateId", "--state");
	return parsed.values as ReadTextParams;
}

function parseWait(args: string[]): WaitForParams {
	const parsed = parseOptions(args, {
		"--state": STATE,
		"--text": { key: "text", kind: "string" },
		"--role": { key: "role", kind: "string" },
		"--gone": { key: "gone", kind: "boolean" },
		"--timeout": { key: "timeoutMs", kind: "number" },
	});
	noPositionals(parsed);
	required(parsed.values, "stateId", "--state");
	if (!optionalString(parsed.values, "text") && !optionalString(parsed.values, "role")) invalid("wait-for requires --text or --role.");
	return parsed.values as WaitForParams;
}

type BrowserCommand =
	| { command: "launch-browser"; params: LaunchBrowserParams }
	| { command: "navigate-browser"; params: NavigateBrowserParams }
	| { command: "evaluate-browser"; params: EvaluateBrowserParams };

function parseBrowser(args: string[]): BrowserCommand {
	const [operation, ...operationArgs] = args;
	if (operation === "launch") {
		const parsed = parseOptions(operationArgs, {
			"--browser": { key: "browser", kind: "string", values: ["helium", "chrome"] },
			"--url": { key: "url", kind: "string" },
			"--port": { key: "port", kind: "number" },
		});
		noPositionals(parsed);
		return { command: "launch-browser", params: parsed.values as LaunchBrowserParams };
	}
	if (operation === "navigate") {
		const parsed = parseOptions(operationArgs, { "--state": STATE, "--url": { key: "url", kind: "string" }, "--image": IMAGE });
		noPositionals(parsed);
		return {
			command: "navigate-browser",
			params: {
				stateId: required(parsed.values, "stateId", "--state"),
				url: required(parsed.values, "url", "--url"),
				image: parsed.values.image as NavigateBrowserParams["image"],
			},
		};
	}
	if (operation === "eval") {
		const parsed = parseOptions(operationArgs, { "--state": STATE, "--expression": { key: "expression", kind: "string" } });
		noPositionals(parsed);
		return {
			command: "evaluate-browser",
			params: {
				stateId: required(parsed.values, "stateId", "--state"),
				expression: required(parsed.values, "expression", "--expression"),
			},
		};
	}
	invalid("browser requires one subcommand: launch, navigate, or eval.");
}

function writeResult(result: unknown, json: boolean, text?: string): void {
	if (json) {
		process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
		return;
	}
	if (text) process.stdout.write(`${text.trimEnd()}\n`);
}

const CACHED_DESKTOP_DETAIL_KEYS = new Set(["config", "helper", "lookId", "note", "outline", "renderedOutline"]);

function publicToolResult(result: ToolResult): ToolResult {
	if (!result.details || typeof result.details !== "object" || Array.isArray(result.details) || !("capture" in result.details)) return result;
	const details = Object.fromEntries(
		Object.entries(result.details).filter(([key]) => !CACHED_DESKTOP_DETAIL_KEYS.has(key)),
	);
	return { ...result, details };
}

function writeToolResult(result: ToolResult, json: boolean): void {
	const screenshot = result.screenshot ? `screenshot: ${result.screenshot.path} (${result.screenshot.width}x${result.screenshot.height})` : "";
	writeResult(json ? publicToolResult(result) : result, json, [result.text, screenshot].filter(Boolean).join("\n"));
}

async function runTool<Name extends CliCommandName>(name: Name, params: CliCommandParams[Name], json: boolean): Promise<void> {
	writeToolResult(await executor(name)(params), json);
}

async function runStatus(json: boolean): Promise<void> {
	const broker = await brokerHandshakeIfRunning();
	const result = broker ? { running: true, ...broker } : { running: false };
	writeResult(result, json, broker ? `broker: running (pid ${broker.pid}, protocol ${broker.brokerVersion})` : "broker: stopped");
}

interface DoctorResult {
	broker: { pid: number };
	helper: { protocolVersion: number };
	permissions?: { accessibility: boolean; screenRecording: boolean };
}

async function runDoctor(json: boolean): Promise<void> {
	const result = await requestBroker<DoctorResult>("doctor", {});
	const permissions = result.permissions
		? `permissions: accessibility=${result.permissions.accessibility}, screenRecording=${result.permissions.screenRecording}`
		: "permissions: not required";
	writeResult(result, json, `broker: ok (pid ${result.broker.pid})\nhelper: ok (protocol ${result.helper.protocolVersion})\n${permissions}`);
}

async function runSetup(json: boolean): Promise<void> {
	if (process.platform === "win32") {
		const result = await requestBroker<Record<string, unknown>>("setup", { phase: "complete" });
		writeResult(result, json, "setup: ready");
		return;
	}
	if (process.platform === "darwin" && (!process.stdin.isTTY || !process.stderr.isTTY)) {
		throw new BcuError("permission_missing", "bcu setup requires an interactive terminal so you can grant macOS permissions.");
	}
	const registered = await requestBroker<Record<string, unknown>>("setup", { phase: "register" });
	process.stderr.write("Enable bcu in System Settings → Privacy & Security → Accessibility and Screen Recording.\n");
	const terminal = createInterface({ input: process.stdin, output: process.stderr });
	try { await terminal.question("Press Enter after both switches are enabled: "); } finally { terminal.close(); }
	const result = await requestBroker<Record<string, unknown>>("setup", { phase: "complete" });
	writeResult({ registered, ...result }, json, "setup: permissions granted");
}

async function runStop(json: boolean): Promise<void> {
	const result = await requestRunningBroker<{ stopped: boolean; pid: number }>("stop", {});
	writeResult(result ?? { stopped: true, alreadyStopped: true }, json, result ? `broker: stopped (pid ${result.pid})` : "broker: already stopped");
}

function internalRequest(args: string[]): { command: string; params: Record<string, unknown> } {
	if (args.length !== 2) invalid("Internal request requires a command and one JSON object.");
	let params: unknown;
	try { params = JSON.parse(args[1]); } catch (error) { invalid(`Internal request JSON is invalid: ${String(error)}`); }
	if (!params || typeof params !== "object" || Array.isArray(params)) invalid("Internal request args must be a JSON object.");
	return { command: args[0], params: params as Record<string, unknown> };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
	const [internalCommand, ...internalArgs] = args;
	if (internalCommand === "__serve") {
		if (internalArgs.length > 0) invalid("__serve accepts no arguments.");
		const { serveBroker } = await import("./broker.ts");
		await serveBroker();
		return;
	}
	if (internalCommand === "__request") {
		const request = internalRequest(internalArgs);
		process.stdout.write(`${JSON.stringify(await requestBroker(request.command, request.params))}\n`);
		return;
	}
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${USAGE}\n`);
		return;
	}
	const json = args.includes("--json");
	const [command, ...commandArgs] = args.filter((argument) => argument !== "--json");
	if (!command) {
		process.stdout.write(`${USAGE}\n`);
		return;
	}
	switch (command) {
		case "find-roots": return await runTool(command, parseFind(commandArgs), json);
		case "observe-ui": return await runTool(command, parseObserve(commandArgs), json);
		case "search-ui": return await runTool(command, parseSearch(commandArgs), json);
		case "expand-ui": return await runTool(command, parseExpand(commandArgs), json);
		case "inspect-ui": return await runTool(command, parseInspect(commandArgs), json);
		case "act-ui": return await runTool(command, await parseAct(commandArgs), json);
		case "read-text": return await runTool(command, parseReadText(commandArgs), json);
		case "wait-for": return await runTool(command, parseWait(commandArgs), json);
		case "browser": {
			const browser = parseBrowser(commandArgs);
			if (browser.command === "launch-browser") return await runTool(browser.command, browser.params, json);
			if (browser.command === "navigate-browser") return await runTool(browser.command, browser.params, json);
			return await runTool(browser.command, browser.params, json);
		}
		case "status":
			if (commandArgs.length > 0) invalid("status accepts no options except --json.");
			return await runStatus(json);
		case "doctor":
			if (commandArgs.length > 0) invalid("doctor accepts no options except --json.");
			return await runDoctor(json);
		case "setup":
			if (commandArgs.length > 0) invalid("setup accepts no options except --json.");
			return await runSetup(json);
		case "stop":
			if (commandArgs.length > 0) invalid("stop accepts no options except --json.");
			return await runStop(json);
		default: invalid(`Unknown command '${command}'. Run 'bcu --help'.`);
	}
}

function isEntrypoint(): boolean {
	if (!process.argv[1]) return false;
	try {
		return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isEntrypoint()) {
	try {
		await main();
	} catch (error) {
		const normalized = normalizeCliError(error);
		process.stderr.write(formatCliError(normalized));
		process.exitCode = normalized.exitCode;
	}
}
