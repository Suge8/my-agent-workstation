import { expect, test } from "bun:test";

type CommandHandler = (args: string, ctx: unknown) => Promise<void> | void;
type ShortcutHandler = (ctx: unknown) => Promise<void> | void;

async function loadRenameSession() {
	const { registerSessionName } = await import(
		`../session/rename.ts?test=${crypto.randomUUID()}`
	);
	return registerSessionName as (pi: unknown) => void;
}

test("renames through Pi and binds Ctrl+R", async () => {
	let commandHandler: CommandHandler | undefined;
	let shortcut: string | undefined;
	let sessionName = "old";
	const notifications: string[] = [];

	(await loadRenameSession())({
		setSessionName(name: string) {
			sessionName = name;
		},
		exec() {
			throw new Error("rename must not call any external CLI");
		},
		registerShortcut(key: string) {
			shortcut = key;
		},
		registerCommand(_name: string, options: { handler: CommandHandler }) {
			commandHandler = options.handler;
		},
	} as never);

	await commandHandler?.("new name", {
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
	});

	expect(shortcut).toBe("ctrl+r");
	expect(sessionName).toBe("new name");
	expect(notifications).toEqual(["会话已改名：new name"]);
});

test("Ctrl+R prompts for and applies a session name", async () => {
	let shortcutHandler: ShortcutHandler | undefined;
	let sessionName = "old";

	(await loadRenameSession())({
		getSessionName() {
			return sessionName;
		},
		setSessionName(name: string) {
			sessionName = name;
		},
		registerShortcut(_key: string, options: { handler: ShortcutHandler }) {
			shortcutHandler = options.handler;
		},
		registerCommand() {},
	} as never);

	await shortcutHandler?.({
		hasUI: true,
		ui: {
			input: async () => "new name",
			notify() {},
		},
	});

	expect(sessionName).toBe("new name");
});

test("rejects an empty rename without touching the session", async () => {
	let commandHandler: CommandHandler | undefined;
	let sessionName = "old";
	const notifications: Array<[string, string]> = [];

	(await loadRenameSession())({
		setSessionName(name: string) {
			sessionName = name;
		},
		registerShortcut() {},
		registerCommand(_name: string, options: { handler: CommandHandler }) {
			commandHandler = options.handler;
		},
	} as never);

	await commandHandler?.("   ", {
		ui: {
			notify(message: string, level: string) {
				notifications.push([message, level]);
			},
		},
	});

	expect(sessionName).toBe("old");
	expect(notifications).toEqual([["用法：/rename <新名字>", "error"]]);
});
