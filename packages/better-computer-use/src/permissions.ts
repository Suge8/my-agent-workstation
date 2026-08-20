// Which process identity the permission answers reflect. Platforms may
// attribute grants to a responsible parent process rather than the helper
// executable itself.
export type PermissionAttribution = "helper-app" | "caller";
export type PermissionKind = "accessibility" | "screenRecording";

export interface PermissionSource {
	attribution: PermissionAttribution;
	pid?: number;
	parentPid?: number;
	executablePath?: string;
	parentPath?: string;
	parentBundleId?: string;
	os?: string;
}

export interface PermissionStatus {
	accessibility: boolean;
	screenRecording: boolean;
	screenRecordingPreflight?: boolean;
	source?: PermissionSource;
}

export class PermissionMissingError extends Error {
	readonly code = "permission_missing";

	constructor(message: string, missing: PermissionKind[]) {
		super(`${message}\nMissing permissions: ${missing.join(" and ")}. Run 'bcu setup' to grant them, then retry.`);
		this.name = "PermissionMissingError";
	}
}

export function ensurePermissions(
	status: PermissionStatus,
	kinds: readonly PermissionKind[],
	message: string,
): PermissionStatus {
	const missing = kinds.filter((kind) => status[kind] !== true);
	if (missing.length > 0) throw new PermissionMissingError(message, missing);
	return status;
}
