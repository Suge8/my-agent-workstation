import { execFileSync } from "node:child_process";

const SERVICES = {
	BRAVE_SEARCH_API_KEY: "my-agent-workstation.brave",
	EXA_API_KEY: "my-agent-workstation.exa",
};

export function credential(name) {
	if (process.env[name]) return process.env[name];
	const service = SERVICES[name];
	if (!service || process.platform !== "darwin") return undefined;
	try {
		return execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim() || undefined;
	} catch {
		return undefined;
	}
}
