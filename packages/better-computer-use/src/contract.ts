export type RootSelector = string | number;
export type ImageMode = "auto" | "always" | "never";
export type MouseButtonName = "left" | "right" | "middle";

export interface ToolImage {
	data: string;
	mimeType: "image/jpeg" | "image/png";
}

export interface ScreenshotArtifact {
	path: string;
	mimeType: ToolImage["mimeType"];
	width: number;
	height: number;
}

export interface ToolResult<Details = unknown> {
	text: string;
	details: Details;
	image?: ToolImage;
	screenshot?: ScreenshotArtifact;
}

export interface ObserveTargetParams {
	app?: string;
	windowTitle?: string;
	root?: RootSelector;
	image?: ImageMode;
}

export interface FindParams {
	query?: string;
	app?: string;
	bundleId?: string;
	pid?: number;
	/** Filters on the platform's best-effort presentation hint; only window vs transient is guaranteed. */
	kind?: "window" | "menu" | "sheet" | "popover" | "dialog" | "browser_page";
}

export interface StateTargetParams {
	stateId?: string;
	image?: ImageMode;
}

export interface NavigateBrowserParams extends StateTargetParams {
	url: string;
}

export interface LaunchBrowserParams {
	browser?: "helium" | "chrome";
	url?: string;
	port?: number;
}

export interface EvaluateBrowserParams {
	stateId: string;
	expression: string;
}

export interface ObserveParams extends ObserveTargetParams {
	mode?: "semantic" | "visual" | "fused";
	readText?: "auto" | "always" | "never";
}

export interface SearchUiParams extends StateTargetParams {
	text?: string;
	role?: string;
	action?: string;
	limit?: number;
}

export interface ExpandUiParams extends StateTargetParams {
	ref: string;
	depth?: number;
}

export interface InspectUiParams extends StateTargetParams {
	ref: string;
	includeRaw?: boolean;
}

export interface UiAction {
	action: "press" | "click" | "doubleClick" | "setText" | "typeText" | "keypress" | "scroll" | "drag" | "moveMouse" | "wait";
	ref?: string;
	x?: number;
	y?: number;
	text?: string;
	keys?: string[];
	scrollX?: number;
	scrollY?: number;
	path?: Array<{ x: number; y: number } | [number, number]>;
	button?: MouseButtonName;
	clickCount?: number;
	ms?: number;
}

export interface ActParams extends StateTargetParams {
	actions: UiAction[];
	/** Prohibits foreground fallback when true. Background is always attempted first. */
	headless?: boolean;
	/** Optional semantic postcondition checked before the transaction reports success. */
	expect?: {
		text?: string;
		role?: string;
		value?: string;
		gone?: boolean;
		timeoutMs?: number;
	};
}

export interface ReadTextParams extends StateTargetParams {
	ref?: string;
	offset?: number;
	limit?: number;
}

export interface WaitForParams extends StateTargetParams {
	text?: string;
	role?: string;
	gone?: boolean;
	timeoutMs?: number;
}

export interface CliCommandParams {
	"find-roots": FindParams;
	"observe-ui": ObserveParams;
	"search-ui": SearchUiParams;
	"expand-ui": ExpandUiParams;
	"inspect-ui": InspectUiParams;
	"act-ui": ActParams;
	"read-text": ReadTextParams;
	"wait-for": WaitForParams;
	"launch-browser": LaunchBrowserParams;
	"navigate-browser": NavigateBrowserParams;
	"evaluate-browser": EvaluateBrowserParams;
}

export const CLI_COMMAND_NAMES = [
	"find-roots",
	"observe-ui",
	"search-ui",
	"expand-ui",
	"inspect-ui",
	"act-ui",
	"read-text",
	"wait-for",
	"launch-browser",
	"navigate-browser",
	"evaluate-browser",
] as const satisfies readonly (keyof CliCommandParams)[];
export type CliCommandName = typeof CLI_COMMAND_NAMES[number];
export type CliCommandExecutor<Name extends CliCommandName> = (
	params: CliCommandParams[Name],
	signal?: AbortSignal,
) => Promise<ToolResult>;
