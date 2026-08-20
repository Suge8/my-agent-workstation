import { macosBackend } from "./macos/backend.ts";
import { isBrowserApp, isChromeFamilyApp, openBrowserLocationWithAppleScript } from "./macos/browser.ts";
import { macosHelper } from "./macos/helper.ts";
import { ensureMacosReady } from "./macos/permissions.ts";
import type { ComputerUsePlatformBackend } from "./types.ts";

const macosPlatformBackend: ComputerUsePlatformBackend = {
	name: "macos",
	shutdown: () => macosHelper.dispose(),
	ensureReady: ensureMacosReady,
	listApps: macosBackend.listApps,
	listRoots: macosBackend.listRoots,
	getFrontmost: macosBackend.getFrontmost,
	focusWindow: macosBackend.focusWindow,
	observe: macosBackend.observe,
	act: macosBackend.act,
	actBatch: macosBackend.actBatch,
	readText: macosBackend.readText,
	waitFor: macosBackend.waitFor,
	isBrowserApp,
	isChromeFamilyApp,
	openBrowserLocation: openBrowserLocationWithAppleScript,
};

export function platformBackendForRuntime(platform: NodeJS.Platform = process.platform): ComputerUsePlatformBackend {
	if (platform !== "darwin") throw new Error(`bcu requires Apple Silicon macOS, got '${platform}'.`);
	return macosPlatformBackend;
}

export const currentPlatformBackend = platformBackendForRuntime();
