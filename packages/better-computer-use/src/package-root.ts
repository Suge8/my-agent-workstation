import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SETUP_HELPER_PATH = path.join("scripts", "setup-helper.mjs");

export function setupHelperScriptPath(moduleUrl = import.meta.url): string {
	let directory = path.dirname(fileURLToPath(moduleUrl));
	for (;;) {
		const candidate = path.join(directory, SETUP_HELPER_PATH);
		if (existsSync(candidate)) return candidate;
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new Error(`Cannot locate ${SETUP_HELPER_PATH} from ${fileURLToPath(moduleUrl)}.`);
}
