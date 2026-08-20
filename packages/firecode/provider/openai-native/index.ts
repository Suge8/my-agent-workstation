/** OpenAI / Codex 请求层：verbosity、Fast（priority）、可选原生压缩。 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_PATH, loadConfig } from "../../config.js";
import openAINativeExtension from "./src/extension.ts";

export function registerOpenAINative(pi: ExtensionAPI): void {
	openAINativeExtension(pi, CONFIG_PATH, loadConfig().config.keys.fast);
}
