import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skill = join(root, "packages/skills/operations/workstation-setup");

test("workstation setup skill delegates the guarded lifecycle to the dynamic setup control plane", async () => {
	const main = await readFile(join(skill, "SKILL.md"), "utf8");
	const confirmations = await readFile(join(skill, "CONFIRMATIONS.md"), "utf8");
	const contract = `${main}\n${confirmations}`;

	expect(main.indexOf("MYAW_SETUP")).toBeLessThan(main.indexOf("installation_root"));
	expect(main).toContain('"$setup" doctor --json');
	for (const command of ["plan", "apply", "verify", "update", "repair", "uninstall"]) {
		expect(main).toContain(`\`${command}\``);
	}
	for (const gate of ["覆盖", "卸载", "SYSTEM", "权限", "OAuth", "密钥"]) {
		expect(contract).toContain(gate);
	}
	expect(main).toContain("CONFIRMATIONS.md");
	expect(main).toMatch(/没有 Pi[\s\S]*Shell 向导/);
	expect(contract).not.toMatch(/\/Users\/|\bbrew (?:install|upgrade|uninstall)\b|\bnpm install\b/);
});
