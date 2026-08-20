import { runProcess } from "./helper.ts";

const BROWSER_WINDOW_OPEN_TIMEOUT_MS = 10_000;

const BROWSER_BUNDLE_IDS = new Set([
	"com.apple.Safari",
	"com.google.Chrome",
	"org.chromium.Chromium",
	"company.thebrowser.Browser",
	"com.brave.Browser",
	"com.microsoft.edgemac",
	"com.vivaldi.Vivaldi",
	"net.imput.helium",
	"org.mozilla.firefox",
]);
const BROWSER_APP_NAMES = new Set([
	"safari",
	"google chrome",
	"chrome",
	"chromium",
	"arc",
	"brave browser",
	"brave",
	"microsoft edge",
	"edge",
	"vivaldi",
	"helium",
	"firefox",
]);
const CHROME_FAMILY_BUNDLE_IDS = new Set([
	"com.google.Chrome",
	"org.chromium.Chromium",
	"company.thebrowser.Browser",
	"com.brave.Browser",
	"com.microsoft.edgemac",
	"com.vivaldi.Vivaldi",
	"net.imput.helium",
]);
const CHROME_FAMILY_APP_NAMES = new Set([
	"google chrome",
	"chrome",
	"chromium",
	"arc",
	"brave browser",
	"brave",
	"microsoft edge",
	"edge",
	"vivaldi",
	"helium",
]);

function normalizeText(value: string): string {
	return value.trim().toLowerCase();
}

function escapeAppleScriptString(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function appendBrowserJavaScriptAppleEventsHint(error: Error): Error {
	const hint = [
		"Browser JavaScript Apple Events are disabled for the target browser.",
		"Ask the user to enable \"Allow JavaScript from Apple Events\" in the browser's developer menu, then retry the browser action.",
	].join(" ");
	if (!/not allowed to send javascript commands|executing javascript through applescript is turned off|allow javascript from apple events|enable javascript from apple events/i.test(error.message) || error.message.includes(hint)) {
		return error;
	}
	const enhanced = new Error(`${error.message}\n\n${hint}`);
	enhanced.name = error.name;
	return enhanced;
}

export function isBrowserApp(appName: string, bundleId?: string): boolean {
	return BROWSER_BUNDLE_IDS.has(bundleId ?? "") || BROWSER_APP_NAMES.has(normalizeText(appName));
}

export function isChromeFamilyApp(appName: string, bundleId?: string): boolean {
	return CHROME_FAMILY_BUNDLE_IDS.has(bundleId ?? "") || CHROME_FAMILY_APP_NAMES.has(normalizeText(appName));
}

function scriptForBrowserOpenLocation(target: { appName: string; bundleId?: string }, url: string): string[] | undefined {
	const appTarget = target.bundleId
		? `application id "${escapeAppleScriptString(target.bundleId)}"`
		: `application "${escapeAppleScriptString(target.appName)}"`;
	const escapedUrl = escapeAppleScriptString(url);
	const normalizedName = normalizeText(target.appName);
	if (target.bundleId === "com.apple.Safari" || normalizedName === "safari") {
		return [`tell ${appTarget} to set URL of front document to "${escapedUrl}"`];
	}
	if (isChromeFamilyApp(target.appName, target.bundleId)) {
		return [`tell ${appTarget} to set URL of active tab of front window to "${escapedUrl}"`];
	}
	return undefined;
}

export async function openBrowserLocationWithAppleScript(
	target: { appName: string; bundleId?: string },
	url: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const script = scriptForBrowserOpenLocation(target, url);
	if (!script) return false;
	const args = script.flatMap((line) => ["-e", line]);
	try {
		await runProcess("osascript", args, BROWSER_WINDOW_OPEN_TIMEOUT_MS, signal);
		return true;
	} catch (error) {
		throw appendBrowserJavaScriptAppleEventsHint(error instanceof Error ? error : new Error(String(error)));
	}
}
