import type { MouseButtonName, UiAction } from "./contract.ts";
import { BcuError } from "./errors.ts";
import type { OutlineNode } from "./outline.ts";

export type ActionTarget = { ref: string } | { x: number; y: number } | { focus: { x: number; y: number } };

export type PreparedAction =
	| { action: "press" | "click"; target: ActionTarget; params: { button?: MouseButtonName; clickCount?: number }; establishesFocus: boolean; usesCurrentFocus: false; needsForeground: boolean }
	| { action: "setText"; target: ActionTarget; params: { text: string }; establishesFocus: false; usesCurrentFocus: false; needsForeground: false }
	| { action: "typeText"; target: ActionTarget; params: { text: string }; establishesFocus: false; usesCurrentFocus: boolean; needsForeground: false }
	| { action: "keypress"; target: ActionTarget; params: { keys: string[] }; establishesFocus: false; usesCurrentFocus: boolean; needsForeground: false }
	| { action: "scroll"; target: ActionTarget; params: { scrollX: number; scrollY: number }; establishesFocus: false; usesCurrentFocus: false; needsForeground: false }
	| { action: "drag"; target: ActionTarget; params: { path: Array<{ x: number; y: number }> }; establishesFocus: false; usesCurrentFocus: false; needsForeground: false }
	| { action: "moveMouse"; target: ActionTarget; params: Record<string, never>; establishesFocus: false; usesCurrentFocus: false; needsForeground: false }
	| { action: "wait"; params: { ms: number }; establishesFocus: false; usesCurrentFocus: false; needsForeground: false };

export interface ActionState {
	currentFocus: boolean;
}

type ActionName = UiAction["action"];
type ActionField = Exclude<keyof UiAction, "action">;
type ActionRecord = Record<string, unknown>;

const ACTION_FIELDS = {
	press: ["ref", "x", "y", "button", "clickCount"],
	click: ["ref", "x", "y", "button", "clickCount"],
	doubleClick: ["ref", "x", "y", "button"],
	setText: ["ref", "x", "y", "text"],
	typeText: ["ref", "x", "y", "text"],
	keypress: ["ref", "x", "y", "keys"],
	scroll: ["ref", "x", "y", "scrollX", "scrollY"],
	drag: ["ref", "x", "y", "path"],
	moveMouse: ["ref", "x", "y"],
	wait: ["ms"],
} as const satisfies Record<ActionName, readonly ActionField[]>;

const REQUIRED_FIELDS = {
	press: [], click: [], doubleClick: [], scroll: [], moveMouse: [], wait: [],
	setText: ["text"], typeText: ["text"], keypress: ["keys"], drag: ["path"],
} as const satisfies Record<ActionName, readonly ActionField[]>;

const TARGET_REQUIRED_ACTIONS = new Set<ActionName>([
	"press", "click", "doubleClick", "setText", "scroll", "moveMouse",
]);

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isPoint(value: unknown): boolean {
	if (Array.isArray(value)) return value.length === 2 && value.every(isFiniteNumber);
	if (!value || typeof value !== "object") return false;
	const point = value as Record<string, unknown>;
	return Object.keys(point).every((key) => key === "x" || key === "y")
		&& isFiniteNumber(point.x)
		&& isFiniteNumber(point.y);
}

const FIELD_VALIDATORS = {
	ref: (value) => typeof value === "string" && value.trim().length > 0,
	x: isFiniteNumber,
	y: isFiniteNumber,
	text: (value) => typeof value === "string",
	keys: (value) => Array.isArray(value) && value.length > 0 && value.every((key) => typeof key === "string" && key.trim().length > 0),
	scrollX: (value) => isFiniteNumber(value) && value >= -10_000 && value <= 10_000,
	scrollY: (value) => isFiniteNumber(value) && value >= -10_000 && value <= 10_000,
	path: (value) => Array.isArray(value) && value.length >= 2 && value.every(isPoint),
	button: (value) => value === "left" || value === "right" || value === "middle",
	clickCount: (value) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 3,
	ms: (value) => isFiniteNumber(value) && value >= 0 && value <= 60_000,
} satisfies Record<ActionField, (value: unknown) => boolean>;

const FIELD_REQUIREMENTS = {
	ref: "a non-empty string",
	x: "a finite number",
	y: "a finite number",
	text: "a string",
	keys: "a non-empty array of non-empty strings",
	scrollX: "a finite number between -10000 and 10000",
	scrollY: "a finite number between -10000 and 10000",
	path: "an array of at least two finite {x,y} points or [x,y] pairs",
	button: "left, right, or middle",
	clickCount: "an integer from 1 to 3",
	ms: "a finite number from 0 to 60000",
} satisfies Record<ActionField, string>;

export interface ActionEnvironment {
	headless: boolean;
	image?: { width: number; height: number };
	node(ref: string): OutlineNode;
	center(node: OutlineNode): { x: number; y: number };
	validatePoint(x: number, y: number, label?: string): void;
}

function invalid(message: string): never {
	throw new BcuError("invalid_arguments", message);
}

function mouseButton(value: MouseButtonName | undefined): MouseButtonName {
	return value ?? "left";
}

function clickCount(value: number | undefined, fallback = 1): number {
	return value ?? fallback;
}

function scrollDelta(value: number | undefined): number {
	return Math.round(value ?? 0);
}

function path(value: UiAction["path"], env: ActionEnvironment): Array<{ x: number; y: number }> {
	return value!.map((point, index) => {
		const x = Array.isArray(point) ? point[0] : point.x;
		const y = Array.isArray(point) ? point[1] : point.y;
		env.validatePoint(x, y, `Drag point ${index + 1}`);
		return { x, y };
	});
}

function nativeTarget(action: UiAction, operation: PreparedAction["action"], env: ActionEnvironment): ActionTarget {
	if (typeof action.ref === "string" && action.ref.trim()) {
		const node = env.node(action.ref.trim());
		const semanticClick = operation === "click" || operation === "press";
		if (semanticClick && node.isTextInput) {
			const point = env.center(node);
			env.validatePoint(point.x, point.y);
			return point;
		}
		const onlyIncidentalActions = node.actions.every((candidate) => candidate === "AXShowMenu" || candidate === "AXScrollToVisible");
		if (node.wireRef && !node.pictureOnly && (!semanticClick || node.canPress || node.canFocus || node.canSetValue || !onlyIncidentalActions)) {
			return { ref: node.wireRef };
		}
		const point = env.center(node);
		env.validatePoint(point.x, point.y);
		return point;
	}
	if (isFiniteNumber(action.x) && isFiniteNumber(action.y)) {
		env.validatePoint(action.x, action.y);
		return { x: action.x, y: action.y };
	}
	if (operation === "drag" && action.path?.length) return path(action.path, env)[0];
	return invalid(`${operation} requires either ref or both x and y.`);
}

function focusedTarget(env: ActionEnvironment): ActionTarget {
	if (!env.image) throw new BcuError("action_failed", "Focused keyboard input requires an image-bearing state. Observe with --image always and retry.");
	return { focus: { x: Math.floor(env.image.width / 2), y: Math.floor(env.image.height / 2) } };
}

function containsEditable(node: OutlineNode): boolean {
	if (node.canSetValue || node.role.toLowerCase().includes("text")) return true;
	return node.children.some(containsEditable);
}

function hasTarget(action: ActionRecord): boolean {
	return typeof action.ref === "string" && action.ref.trim().length > 0
		|| isFiniteNumber(action.x) && isFiniteNumber(action.y);
}

function validateTargetFields(action: ActionRecord, name: ActionName): void {
	const hasRef = Object.hasOwn(action, "ref");
	const hasX = Object.hasOwn(action, "x");
	const hasY = Object.hasOwn(action, "y");
	if (hasX !== hasY) invalid(`${name}.x and ${name}.y must be supplied together.`);
	if (hasRef && hasX) invalid(`${name} must use either ref or coordinates, not both.`);
}

function validateActionFields(action: ActionRecord, name: ActionName): void {
	const allowed = ACTION_FIELDS[name] as readonly string[];
	for (const field of Object.keys(action)) {
		if (field === "action") continue;
		if (!allowed.includes(field)) invalid(`${name}.${field} is not supported.`);
		const actionField = field as ActionField;
		if (!FIELD_VALIDATORS[actionField](action[field])) invalid(`${name}.${field} must be ${FIELD_REQUIREMENTS[actionField]}.`);
	}
	for (const field of REQUIRED_FIELDS[name]) {
		if (!Object.hasOwn(action, field)) invalid(`${name}.${field} is required.`);
	}
	validateTargetFields(action, name);
}

export function validateActions(actions: readonly unknown[]): asserts actions is readonly UiAction[] {
	if (actions.length === 0) invalid("act-ui actions must contain at least one action.");
	if (actions.length > 20) invalid("act-ui supports at most 20 actions per transaction.");
	let focusMayExist = false;
	for (const value of actions) {
		if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Every act-ui item must be an action object.");
		const action = value as ActionRecord;
		const name = action.action;
		if (typeof name !== "string" || !(name in ACTION_FIELDS)) invalid(`Unsupported action '${String(name)}'.`);
		const actionName = name as ActionName;
		validateActionFields(action, actionName);
		if ((actionName === "typeText" || actionName === "keypress") && !hasTarget(action) && !focusMayExist) {
			invalid(`${actionName} without a target requires an earlier focus-establishing action.`);
		}
		if (TARGET_REQUIRED_ACTIONS.has(actionName) && !hasTarget(action)) invalid(`${actionName} requires either ref or both x and y.`);
		if ((actionName === "press" || actionName === "click" || actionName === "doubleClick") && hasTarget(action)) focusMayExist = true;
	}
}

export function prepareAction(action: UiAction, state: ActionState, env: ActionEnvironment): PreparedAction {
	if (action.action === "wait") {
		return { action: "wait", params: { ms: Math.round(action.ms ?? 1_000) }, establishesFocus: false, usesCurrentFocus: false, needsForeground: false };
	}
	const operation = action.action === "doubleClick" ? "click" : action.action;
	const usesCurrentFocus = !env.headless && state.currentFocus && !action.ref && (operation === "typeText" || operation === "keypress");
	const target = usesCurrentFocus ? focusedTarget(env) : nativeTarget(action, operation, env);
	const establishesFocus = !env.headless && Boolean(action.ref) && (operation === "click" || operation === "press") && containsEditable(env.node(action.ref!));
	const needsForeground = !env.headless && (operation === "click" || operation === "press") && "x" in target;

	switch (operation) {
		case "press":
		case "click": return { action: operation, target, params: { button: mouseButton(action.button), clickCount: action.action === "doubleClick" ? 2 : clickCount(action.clickCount) }, establishesFocus, usesCurrentFocus: false, needsForeground };
		case "setText": return { action: operation, target, params: { text: action.text! }, establishesFocus: false, usesCurrentFocus: false, needsForeground: false };
		case "typeText": return { action: operation, target, params: { text: action.text! }, establishesFocus: false, usesCurrentFocus, needsForeground: false };
		case "keypress": return { action: operation, target, params: { keys: action.keys! }, establishesFocus: false, usesCurrentFocus, needsForeground: false };
		case "scroll": return { action: operation, target, params: { scrollX: scrollDelta(action.scrollX), scrollY: scrollDelta(action.scrollY) }, establishesFocus: false, usesCurrentFocus: false, needsForeground: false };
		case "drag": return { action: operation, target, params: { path: path(action.path, env) }, establishesFocus: false, usesCurrentFocus: false, needsForeground: false };
		case "moveMouse": return { action: operation, target, params: {}, establishesFocus: false, usesCurrentFocus: false, needsForeground: false };
	}
}

export function canRetryInForeground(action: PreparedAction, outcome: "worked" | "didnt" | "unknown", headless: boolean): boolean {
	return !headless && outcome === "didnt" && (action.action === "typeText" || action.action === "keypress");
}

export function outcomeAfterCheck(current: "worked" | "didnt" | "unknown", check: "verified" | "preexisting" | "failed"): "worked" | "didnt" | "unknown" {
	if (check === "verified") return "worked";
	if (check === "failed") return "didnt";
	return current;
}

export function outcomeAfterObservedValues(
	current: "worked" | "didnt" | "unknown",
	actions: UiAction[],
	valueForRef: (ref: string) => string | undefined,
): "worked" | "didnt" | "unknown" {
	const meaningful = actions.filter((action) => action.action !== "wait");
	if (meaningful.length === 0 || meaningful.some((action) => action.action !== "setText" || !action.ref)) return current;
	const matches = meaningful.every((action) => valueForRef(action.ref!) === (action.text ?? ""));
	return matches ? "worked" : current;
}
