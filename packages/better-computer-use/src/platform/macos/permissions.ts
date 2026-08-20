import { ensurePermissions, type PermissionKind, type PermissionStatus } from "../../permissions.ts";
import { toBoolean, toFiniteNumber, toOptionalString } from "../coerce.ts";
import type { PlatformReadyState } from "../types.ts";
import { HELPER_APP_PATH, macosHelper } from "./helper.ts";
import { assertPlatformArchitecture } from "../architecture.ts";

const GRANT_INSTRUCTIONS =
	"Grant Accessibility and Screen Recording to bcu.app in System Settings → Privacy & Security. " +
	"Screen Recording lets the agent see the window; Accessibility lets it interact with the window.";

const SIGNING_MIGRATION_WARNING =
	"If these permissions were enabled before this install/update, macOS invalidated the old grants because " +
	"bcu.app was re-signed. Re-enable both toggles for the newly signed helper. " +
	"If a toggle is already on, switch it off and on again.";

const macosPermissionKinds: PermissionKind[] = ["accessibility", "screenRecording"];

function permissionStatusSummary(status: PermissionStatus): string {
	const lines = [
		`Accessibility: ${status.accessibility ? "granted" : "missing"}`,
		`Screen Recording: ${status.screenRecording ? "granted" : "missing"}`,
	];
	if (status.screenRecordingPreflight && !status.screenRecording) {
		lines.push(
			"(Screen Recording reads granted in the TCC database but a live capture probe failed — " +
			"the grant likely belongs to a different app identity, or the helper needs a restart.)",
		);
	}
	return lines.join("; ");
}

function permissionMissingMessage(status: PermissionStatus, hint?: string): string {
	return [
		"bcu is missing required macOS permissions.",
		permissionStatusSummary(status),
		GRANT_INSTRUCTIONS,
		`Helper: bcu.app (${HELPER_APP_PATH})`,
		hint,
		SIGNING_MIGRATION_WARNING,
	].filter(Boolean).join("\n");
}

export async function checkMacosPermissions(signal?: AbortSignal): Promise<PermissionStatus> {
	const result = await macosHelper.command<any>("checkPermissions", {}, { signal });
	const rawSource = result?.source;
	return {
		accessibility: toBoolean(result?.accessibility),
		// Authoritative: the helper's live ScreenCaptureKit probe.
		screenRecording: toBoolean(result?.screenRecordingCapturable),
		// Keep the preflight value separate: disagreement means stale per-process
		// TCC cache or a grant row belonging to another app identity.
		screenRecordingPreflight: toBoolean(result?.screenRecordingPreflight),
		source: rawSource && typeof rawSource === "object"
			? {
				// macOS attributes Accessibility / Screen Recording grants to the
				// responsible process at the top of the launch chain. "helper-app"
				// is the canonical installed app via LaunchServices; "caller" means
				// grants would attach to the launching app instead.
				attribution: rawSource.attribution === "helper-app" ? "helper-app" : "caller",
				pid: Math.trunc(toFiniteNumber(rawSource.pid, 0)) || undefined,
				parentPid: Math.trunc(toFiniteNumber(rawSource.parentPid, 0)) || undefined,
				executablePath: toOptionalString(rawSource.executablePath),
				parentPath: toOptionalString(rawSource.parentPath),
				parentBundleId: toOptionalString(rawSource.parentBundleId),
				os: toOptionalString(rawSource.macOS),
			}
			: undefined,
	};
}

export async function ensureMacosReady(
	state: PlatformReadyState,
	signal?: AbortSignal,
): Promise<PlatformReadyState> {
	await macosHelper.ensureInstalled(signal);
	if (!(await macosHelper.ensureDaemon(signal))) {
		throw new Error(`bcu helper app daemon did not start. Helper app: ${HELPER_APP_PATH}`);
	}
	const helperDiagnostics = await macosHelper.ensureProtocol(signal);
	assertPlatformArchitecture("macOS", helperDiagnostics);

	const now = Date.now();
	const cachedStatus = state.permissionStatus;
	const canUseCachedPermissions =
		cachedStatus?.accessibility &&
		cachedStatus.screenRecording &&
		now - state.lastPermissionCheckAt < 2_000;
	if (canUseCachedPermissions) {
		return { ...state, helperDiagnostics };
	}

	const permissionStatus = await checkMacosPermissions(signal);
	const attributionHint = permissionStatus.source?.attribution === "caller"
		? `Warning: the helper is not running as the installed bcu.app (executable: ${permissionStatus.source?.executablePath ?? "unknown"}). Grants made now would attach to the launching app instead. Restart bcu so the canonical helper is used.`
		: undefined;
	ensurePermissions(permissionStatus, macosPermissionKinds, permissionMissingMessage(permissionStatus, attributionHint));
	return { permissionStatus, lastPermissionCheckAt: now, helperDiagnostics };
}
