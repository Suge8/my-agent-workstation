import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPONENTS = join(ROOT, "resources", "components");

async function files(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	return (await Promise.all(entries.map((entry) => {
		const path = join(root, entry.name);
		return entry.isDirectory() ? files(path) : [path];
	}))).flat();
}

test("component JSON parses and manifest assets exist", async () => {
	for (const path of await files(COMPONENTS)) {
		if (!path.endsWith(".json")) continue;
		const document = JSON.parse(await readFile(path, "utf8"));
		if (!path.endsWith("manifest.json")) continue;
		for (const component of document.components ?? []) {
			for (const asset of component.assets ?? []) {
				expect(Bun.file(join(dirname(path), asset.source)).size, `${relative(ROOT, path)}: ${asset.source}`).toBeGreaterThan(0);
			}
		}
	}
});

test("Ghostty preserves reserved defaults and maps every Herdr chord exactly", async () => {
	const config = await readFile(join(COMPONENTS, "terminal", "ghostty.conf"), "utf8");
	expect(config).toContain("macos-option-as-alt = true");
	expect(config).toContain("macos-titlebar-style = hidden");
	expect(config).toContain("font-family = Maple Mono NF");
	expect(config).toContain(String.raw`keybind = shift+enter=text:\n`);
	for (const reserved of ["super+f", "super+shift+w", "super+shift+t"]) {
		expect(config).not.toMatch(new RegExp(`^keybind\\s*=\\s*${reserved.replaceAll("+", "\\+")}=`, "m"));
	}

	const mappings = Object.fromEntries(
		[...config.matchAll(/^keybind\s*=\s*(super[^=]*)=text:(\\x02.+)$/gm)].map((match) => [match[1], match[2]]),
	);
	expect(mappings).toEqual({
		"super+n": String.raw`\x02N`,
		"super+t": String.raw`\x02c`,
		"super+w": String.raw`\x02x`,
		"super+alt+w": String.raw`\x02X`,
		"super+d": String.raw`\x02v`,
		"super+shift+d": String.raw`\x02-`,
		"super+alt+h": String.raw`\x02h`,
		"super+alt+j": String.raw`\x02j`,
		"super+alt+k": String.raw`\x02k`,
		"super+alt+l": String.raw`\x02l`,
		"super+shift+enter": String.raw`\x02z`,
	});
	expect(config).toContain("quick-terminal-position = top");
	expect(config).toContain("quick-terminal-screen = mouse");
	expect(config).toContain("quick-terminal-size = 35%");
	expect(config).toContain("quick-terminal-animation-duration = 0.12");
	expect(config).toContain("keybind = super+alt+f=write_scrollback_file:open");
	expect(config).toContain("keybind = super+,=open_config");
	expect(config).toContain("keybind = global:super+grave_accent=toggle_quick_terminal");
});

test("browser policy uses verified isolated components without generic migration", async () => {
	const manifest = JSON.parse(await readFile(join(COMPONENTS, "browser", "manifest.json"), "utf8"));
	expect(manifest.default_automation_browser).toBe("cloakbrowser");
	expect(manifest.failure_policy).toBe("error-no-fallback");
	expect(manifest.auth_policy.generic_cookie_migration).toBe(false);
	expect(manifest.auth_policy.generic_profile_migration).toBe(false);
	const cloak = manifest.components.find((component: { id: string }) => component.id === "cloakbrowser");
	expect(cloak.consumer.setting).toBe("AGENT_BROWSER_EXECUTABLE_PATH");
	const helium = manifest.components.find((component: { id: string }) => component.id === "helium-browser");
	expect(helium.install).toEqual({ kind: "homebrew-cask", name: "helium-browser" });
	expect(helium.roles).toEqual(["daily-browser"]);
});

test("search state cannot hold secrets and valid auth is skipped", async () => {
	const search = join(COMPONENTS, "search");
	const manifest = JSON.parse(await readFile(join(search, "manifest.json"), "utf8"));
	expect(manifest.auth_policy.existing_valid_auth).toBe("skip");

	const schema = JSON.parse(await readFile(join(search, "credentials.schema.json"), "utf8"));
	expect(schema.additionalProperties).toBe(false);
	expect(schema.properties.providers.additionalProperties).toBe(false);
	expect(schema.$defs.base.additionalProperties).toBe(false);
	expect(Object.keys(schema.$defs.base.properties).sort()).toEqual(["auth", "enabled"]);

	const secret = /(?:sk|key|token)-[a-z0-9_-]{16,}|https:\/\/api\.day\.app\/[a-z0-9]{8,}/i;
	for (const path of await files(COMPONENTS)) expect(await readFile(path, "utf8"), relative(ROOT, path)).not.toMatch(secret);
});
