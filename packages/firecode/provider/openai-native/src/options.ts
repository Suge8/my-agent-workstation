import type { Api, Model } from "@earendil-works/pi-ai";
import { providerSettings, type OpenAINativeSettings, type TextVerbosity } from "./config";

export const FAST_STATUS_KEY = "pi-openai-native-fast";

const OPENAI_RESPONSES_APIS = new Set(["openai-responses", "openai-codex-responses"]);
const PRIORITY_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTextVerbosity(value: unknown): value is TextVerbosity {
	return value === "low" || value === "medium" || value === "high";
}

function isOpenAIResponsesModel(model: Model<Api> | undefined): model is Model<Api> {
	return model !== undefined && OPENAI_RESPONSES_APIS.has(model.api);
}

export function supportsFastMode(model: Model<Api> | undefined): boolean {
	if (!model) return false;
	if (model.provider === "xai") return true;
	return isOpenAIResponsesModel(model) && PRIORITY_MODEL_IDS.has(model.id);
}

export function fastModeEnabled(model: Model<Api> | undefined, settings: OpenAINativeSettings): boolean {
	if (!model || !supportsFastMode(model)) {
		return false;
	}
	return providerSettings(settings, model.provider)?.priority === true;
}

function resolveTextVerbosity(
	model: Model<Api>,
	settings: OpenAINativeSettings,
	verbosityOverride: unknown,
): TextVerbosity | undefined {
	if (verbosityOverride !== undefined) {
		return isTextVerbosity(verbosityOverride) ? verbosityOverride : undefined;
	}
	return providerSettings(settings, model.provider)?.textVerbosity;
}

export function applyOpenAIOptions(
	payload: Record<string, unknown>,
	model: Model<Api> | undefined,
	settings: OpenAINativeSettings,
	verbosityOverride: unknown,
): Record<string, unknown> {
	const configuredProvider = model ? providerSettings(settings, model.provider) : undefined;
	let nextPayload = payload;

	// verbosity 只属于 OpenAI Responses；xAI Completions 没有这个字段。
	if (isOpenAIResponsesModel(model)) {
		const textVerbosity = resolveTextVerbosity(model, settings, verbosityOverride);
		if (textVerbosity && (!isRecord(payload.text) || payload.text.verbosity !== textVerbosity)) {
			nextPayload = {
				...nextPayload,
				text: {
					...(isRecord(nextPayload.text) ? nextPayload.text : {}),
					verbosity: textVerbosity,
				},
			};
		}
	}

	if (
		(isOpenAIResponsesModel(model) || model?.provider === "xai") &&
		configuredProvider?.priority &&
		payload.service_tier !== "priority"
	) {
		nextPayload = nextPayload === payload ? { ...nextPayload } : nextPayload;
		nextPayload.service_tier = "priority";
	}

	return nextPayload;
}
