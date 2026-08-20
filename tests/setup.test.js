import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const setup = resolve(import.meta.dir, "../setup");
const roots = [];
setDefaultTimeout(30000);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(state = {}) {
  const root = mkdtempSync(join(tmpdir(), "myaw-"));
  roots.push(root);
  const bin = join(root, "bin");
  const home = join(root, "home");
  const managed = join(root, "managed");
  const fakeState = join(root, "fake-state");
  const log = join(root, "commands.log");
  const brewPrefix = join(root, "brew");
  mkdirSync(bin); mkdirSync(home); mkdirSync(fakeState); mkdirSync(brewPrefix);
  for (const [key, value] of Object.entries(state)) writeFileSync(join(fakeState, key), String(value));

  const dispatcher = join(bin, "fake-command");
  writeFileSync(dispatcher, `#!/bin/bash
set -u
name=\$(basename "$0")
state=\${FAKE_STATE:?}
has() { test -f "$state/$1"; }
value() { test -f "$state/$1" && /bin/cat "$state/$1"; }
log() { printf '%s\\n' "$name $*" >> "\${FAKE_LOG:?}"; }
case "$name" in
  uname) if test "\${1:-}" = -s; then value os || printf 'Darwin\\n'; else value arch || printf 'arm64\\n'; fi ;;
  sw_vers) value macos || printf '14.0\\n' ;;
  zsh) exit 0 ;;
  node)
    has toolchain_missing && exit 127
    if test "\${1:-}" = --version; then printf 'v22.0.0\\n'; else exec "\${REAL_NODE:?}" "$@"; fi
    ;;
  npm)
    has toolchain_missing && exit 127
    case "$*" in
      "--version") printf '10.0.0\\n' ;;
      "list -g --depth=0 @earendil-works/pi-coding-agent") has pi_npm || exit 1; printf '└── @earendil-works/pi-coding-agent@%s\\n' "\$(value pi_version)" ;;
      "install --global --ignore-scripts @earendil-works/pi-coding-agent@latest") log "$@"; touch "$state/pi_npm"; value pi_latest > "$state/pi_version" ;;
      "install --global cloakbrowser") log "$@"; touch "$state/cloakbrowser" ;;
      install\\ --prefix*|run\\ --prefix*) log "$@" ;;
      pack\\ --pack-destination\\ *\\ --ignore-scripts)
        log "$@"; destination=\${3}; mkdir -p "$destination"; touch "$destination/better-computer-use-0.1.0.tgz"
        ;;
      "root --global") printf '%s\\n' "$state/npm-root" ;;
      install\\ --global\\ --ignore-scripts\\ *.tgz) log "$@"; touch "$state/bcu" ;;
      "uninstall --global better-computer-use") log "$@"; rm -f "$state/bcu" ;;
      *) exit 1 ;;
    esac
    ;;
  pi)
    case "$*" in
      "--version") has pi_version || exit 1; value pi_version ;;
      "list") has antigravity && printf 'npm:pi-antigravity\\n'; exit 0 ;;
      "install npm:pi-antigravity") log "$@"; touch "$state/antigravity" ;;
      "update npm:pi-antigravity") log "$@" ;;
      install\\ *) log "$@"; touch "$state/workstation_package" ;;
      remove\\ *) log "$@"; rm -f "$state/workstation_package" ;;
      "auth check --provider "*" --json --no-refresh")
        provider=\${4}
        if test -f "$state/auth-$provider"; then printf '{"status":"ready","provider":"%s"}\\n' "$provider"; else printf '{"status":"not_ready","provider":"%s"}\\n' "$provider"; exit 1; fi
        ;;
      "--list-models"|"--no-extensions --list-models")
        printf 'provider model context max-out thinking images\\n'
        if has auth-openai-codex; then printf 'openai-codex gpt-5.6-sol 1M 128K yes yes\\n'; fi
        ;;
      *) exit 1 ;;
    esac
    ;;
  brew)
    case "$*" in
      "--version") has brew || exit 1; printf 'Homebrew 4\\n' ;;
      "--prefix") printf '%s\\n' "\${BREW_PREFIX:?}" ;;
      "list --versions node") has toolchain_homebrew || exit 1; printf 'node 22.0.0\\n' ;;
      "list --versions pi-coding-agent") has pi_brew || exit 1; printf 'pi-coding-agent %s\\n' "\$(value pi_version)" ;;
      "list --versions herdr") has herdr || exit 1; printf 'herdr %s\\n' "\$(value herdr_version)" ;;
      "list --versions starship"|"list --versions fastfetch"|"list --versions zsh-autosuggestions"|"list --versions zsh-syntax-highlighting") has terminal || exit 1; printf 'installed 1.0.0\\n' ;;
      "list --cask ghostty"|"list --cask font-maple-mono-nf") has terminal ;;
      "list --cask helium-browser") has helium ;; 
      "install node") log "$@"; rm -f "$state/toolchain_missing"; touch "$state/toolchain_homebrew" ;;
      "uninstall pi-coding-agent") log "$@"; rm -f "$state/pi_brew" "$state/pi_version" ;;
      "services stop herdr") log "$@"; rm -f "$state/service" ;;
      "uninstall herdr") log "$@"; rm -f "$state/herdr" "$state/herdr_version" "$state/herdr_brew" ;;
      "install agent-browser") log "$@"; touch "$state/agent-browser" ;;
      "install starship fastfetch zsh-autosuggestions zsh-syntax-highlighting") log "$@"; touch "$state/terminal" ;;
      "install --cask ghostty font-maple-mono-nf") log "$@"; touch "$state/terminal" ;;
      "install --cask helium-browser") log "$@"; touch "$state/helium" ;;
      *) exit 1 ;;
    esac
    ;;
  herdr)
    case "$*" in
      "--version") has herdr || exit 1; value herdr_version ;;
      "integration status") if has integration; then printf 'Pi: current (v2)\\n'; else printf 'Pi: not installed\\n'; fi ;;
      "channel set stable") log "$@" ;;
      "integration install pi") log "$@"; touch "$state/integration" ;;
      "integration uninstall pi") log "$@"; rm -f "$state/integration" ;;
      *) exit 1 ;;
    esac
    ;;
  bcu)
    has bcu || exit 127
    case "$*" in
      "--help") exit 0 ;;
      "status --json") printf '{"ok":true,"result":{"running":true}}\\n' ;;
      "doctor --json")
        if has bcu_permissions_missing; then
          printf '{"ok":true,"result":{"broker":{"pid":42},"helper":{"protocolVersion":1},"permissions":{"accessibility":false,"screenRecording":false}}}\\n'
        else
          printf '{"ok":true,"result":{"broker":{"pid":42},"helper":{"protocolVersion":1},"permissions":{"accessibility":true,"screenRecording":true}}}\\n'
        fi
        ;;
      setup) rm -f "$state/bcu_permissions_missing" ;;
      *) exit 1 ;;
    esac
    ;;
  agent-browser)
    case "$*" in --version) has agent-browser ;; install) log "$@"; touch "$state/agent-browser" ;; *) exit 1 ;; esac
    ;;
  cloakbrowser)
    case "$*" in
      info) has cloakbrowser ;;
      "info --quick --json") has cloakbrowser && printf '{"binary":{"path":"%s"}}\\n' "$HOME/.cloakbrowser/Chromium" ;;
      install) log "$@"; touch "$state/cloakbrowser" ;;
      *) exit 1 ;;
    esac
    ;;
  launchctl)
    case "$*" in
      print*) has service ;;
      bootstrap*) log "$@"; touch "$state/service" ;;
      bootout*) log "$@"; rm -f "$state/service" ;;
      *) exit 1 ;;
    esac
    ;;
  security)
    case "$*" in find-generic-password*) exit 44 ;; add-generic-password*) exit 0 ;; *) exit 1 ;; esac
    ;;
  curl)
    case "$*" in
      *registry.npmjs.org*) has registry_offline && exit 1; printf '{"version":"%s"}\\n' "\$(value pi_latest || value pi_version)" ;;
      *herdr.dev/latest.json*) printf '{"version":"%s"}\\n' "\$(value herdr_latest || printf '1.0.0')" ;;
      *herdr.dev/install.sh*)
        log "$@"
        output=\${@: -1}
        printf '%s\\n' 'touch "$FAKE_STATE/herdr"' 'value=$(cat "$FAKE_STATE/herdr_latest" 2>/dev/null || printf "1.0.0")' 'printf "%s" "$value" > "$FAKE_STATE/herdr_version"' 'mkdir -p "$HOME/.local/bin"' 'ln -sf "$FAKE_COMMAND" "$HOME/.local/bin/herdr"' > "$output"
        ;;
      *Homebrew/install*) log "$@"; printf 'touch "$FAKE_STATE/brew"\\n' ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 127 ;;
esac
`);
  chmodSync(dispatcher, 0o755);
  for (const name of ["uname", "sw_vers", "zsh", "node", "npm", "brew", "pi", "herdr", "bcu", "agent-browser", "cloakbrowser", "launchctl", "security", "curl"])
    symlinkSync("fake-command", join(bin, name));
  const npmRoot = join(fakeState, "npm-root", "better-computer-use", "scripts");
  mkdirSync(npmRoot, { recursive: true });
  writeFileSync(join(npmRoot, "setup-helper.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(process.env.FAKE_STATE + "/bcu-helper", "");\n`);
  const localBin = join(home, ".local", "bin");
  if ("herdr" in state) {
    mkdirSync(localBin, { recursive: true });
    symlinkSync(dispatcher, join(localBin, "herdr"));
  }

  const env = {
    ...process.env,
    PATH: `${localBin}:${bin}:/usr/bin:/bin`, HOME: home, MYAW_HOME: managed,
    FAKE_STATE: fakeState, FAKE_LOG: log, FAKE_COMMAND: dispatcher, REAL_NODE: process.execPath,
    BREW_PREFIX: brewPrefix, SHELL: join(bin, "zsh"), XDG_CONFIG_HOME: join(home, ".config"),
  };
  const run = (args, input) => spawnSync(setup, args, { env, input, encoding: "utf8", timeout: 30000 });
  return { root, home, managed, fakeState, log, env, run };
}

function json(result) {
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

function ready(overrides = {}) {
  return { brew: "", pi_npm: "", pi_version: "1.0.0", pi_latest: "1.0.0", herdr: "", herdr_version: "1.0.0", service: "", integration: "", ...overrides };
}

function apply(f, mode = "core", extra = ["--keep-system"]) {
  return f.run(["apply", "--mode", mode, "--yes", "--json", ...extra]);
}

describe("setup public CLI", () => {
  test.each([
    [{ os: "Linux" }, "macOS"], [{ arch: "x86_64" }, "Apple Silicon"], [{ macos: "13.6" }, "macOS 14"],
  ])("doctor rejects unsupported systems", (state, reason) => {
    const result = fixture(state).run(["doctor", "--json"]);
    expect(result.status).toBe(2);
    expect(json(result).reason).toContain(reason);
  });

  test("doctor is read-only and reports core plus managed gaps", () => {
    const f = fixture();
    const report = json(f.run(["doctor", "--json"]));
    expect(report.components.pi.status).toBe("missing");
    expect(report.workstation.package.status).toBe("missing");
    expect(existsSync(f.managed)).toBe(false);
    expect(existsSync(join(f.home, ".pi"))).toBe(false);
  });

  test("core plan is complete and read-only", () => {
    const f = fixture();
    const result = f.run(["plan", "--mode", "core", "--json", "--keep-system"]);
    expect(result.status).toBe(0);
    expect(json(result).actions).toEqual([
      "install_homebrew", "install_pi", "install_herdr", "start_herdr_service", "install_pi_integration",
      "install_workstation_package", "configure_pi", "sync_runtime",
    ]);
    expect(existsSync(f.managed)).toBe(false);
  });

  test("non-interactive apply requires an explicit SYSTEM choice", () => {
    const result = fixture(ready()).run(["apply", "--yes", "--json"]);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("--replace-system");
  });

  test("fresh core install bootstraps tools, installs the Pi package, and is idempotent", () => {
    const f = fixture({ toolchain_missing: "", pi_latest: "2.0.0" });
    const first = apply(f);
    expect(first.status).toBe(0, first.stderr);
    expect(json(first).valid).toBe(true);
    expect(existsSync(join(f.managed, "pi-package", "package.json"))).toBe(true);
    expect(existsSync(join(f.managed, "runtime", "setup"))).toBe(true);
    const plist = join(f.home, "Library", "LaunchAgents", "dev.myagentworkstation.herdr.plist");
    expect(spawnSync("/usr/bin/plutil", ["-lint", plist]).status).toBe(0);
    const state = JSON.parse(readFileSync(join(f.managed, "state.json"), "utf8"));
    expect(state.mode).toBe("core");
    expect(state.installation_root).toBe(join(f.managed, "runtime"));
    const before = readFileSync(f.log, "utf8");
    const second = apply(f);
    expect(second.status).toBe(0, second.stderr);
    const after = readFileSync(f.log, "utf8");
    expect(after.split("pi install ").length).toBe(before.split("pi install ").length);
  });

  test("managed Pi files are backed up, restored, and start a fresh backup cycle", () => {
    const f = fixture(ready());
    const agent = join(f.home, ".pi", "agent");
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "SYSTEM.md"), "original system\n");
    writeFileSync(join(agent, "settings.json"), '{"custom":"settings"}\n');
    writeFileSync(join(agent, "keybindings.json"), '{"custom":"keys"}\n');
    writeFileSync(join(agent, "bark-key"), "original bark\n");
    expect(apply(f, "core", ["--replace-system"]).status).toBe(0);
    expect(f.run(["configure-search"], "\n\nhttps://api.day.app/new/\n").status).toBe(0);
    expect(f.run(["uninstall", "--yes", "--json"]).status).toBe(0);
    expect(readFileSync(join(agent, "SYSTEM.md"), "utf8")).toBe("original system\n");
    expect(readFileSync(join(agent, "settings.json"), "utf8")).toBe('{"custom":"settings"}\n');
    expect(readFileSync(join(agent, "keybindings.json"), "utf8")).toBe('{"custom":"keys"}\n');
    expect(readFileSync(join(agent, "bark-key"), "utf8")).toBe("original bark\n");
    writeFileSync(join(agent, "SYSTEM.md"), "second system\n");
    expect(apply(f, "core", ["--replace-system"]).status).toBe(0);
    expect(f.run(["uninstall", "--yes", "--json"]).status).toBe(0);
    expect(readFileSync(join(agent, "SYSTEM.md"), "utf8")).toBe("second system\n");
    expect(existsSync(join(f.managed, "backups", "history"))).toBe(true);
  });

  test("full mode installs an independent BCU package and terminal fragments without duplicating markers", () => {
    const f = fixture(ready());
    const first = apply(f, "full");
    expect(first.status).toBe(0, first.stderr);
    const ghostty = join(f.home, ".config", "ghostty", "config");
    const zshrc = join(f.home, ".zshrc");
    expect(readFileSync(ghostty, "utf8")).toContain("my-agent-workstation");
    expect(readFileSync(zshrc, "utf8")).toContain("my-agent-workstation");
    expect(existsSync(join(f.fakeState, "bcu"))).toBe(true);
    expect(existsSync(join(f.fakeState, "bcu-helper"))).toBe(true);
    const commands = readFileSync(f.log, "utf8");
    expect(commands).toContain("npm pack --pack-destination");
    expect(commands).toMatch(/npm install --global --ignore-scripts .*better-computer-use-0\.1\.0\.tgz/);
    expect(existsSync(join(f.fakeState, "agent-browser"))).toBe(true);
    expect(existsSync(join(f.fakeState, "cloakbrowser"))).toBe(true);
    expect(apply(f, "full").status).toBe(0);
    expect(readFileSync(ghostty, "utf8").match(/>>> my-agent-workstation/g)).toHaveLength(1);
    expect(readFileSync(zshrc, "utf8").match(/>>> my-agent-workstation/g)).toHaveLength(1);
  });

  test("npm tarball installs remain usable after their source directory is removed", () => {
    const root = mkdtempSync(join(tmpdir(), "myaw-npm-pack-"));
    roots.push(root);
    const source = join(root, "source");
    const archive = join(root, "archive");
    const prefix = join(root, "prefix");
    mkdirSync(source); mkdirSync(archive); mkdirSync(join(source, "bin"));
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "myaw-pack-probe", version: "1.0.0", bin: { "myaw-pack-probe": "bin/probe.mjs" } }));
    writeFileSync(join(source, "bin", "probe.mjs"), "#!/usr/bin/env node\nconsole.log('durable')\n");
    chmodSync(join(source, "bin", "probe.mjs"), 0o755);
    expect(spawnSync("npm", ["pack", "--pack-destination", archive, "--ignore-scripts"], { cwd: source }).status).toBe(0);
    const tarball = join(archive, "myaw-pack-probe-1.0.0.tgz");
    expect(spawnSync("npm", ["install", "--global", "--prefix", prefix, "--ignore-scripts", tarball]).status).toBe(0);
    rmSync(source, { recursive: true });
    const probe = spawnSync(join(prefix, "bin", "myaw-pack-probe"), { encoding: "utf8" });
    expect(probe.status).toBe(0);
    expect(probe.stdout).toBe("durable\n");
  });

  test("authenticated providers generate only available model configuration", () => {
    const f = fixture(ready({ "auth-openai-codex": "" }));
    const result = apply(f);
    expect(result.status).toBe(0, result.stderr);
    const settingsPath = join(f.home, ".pi", "agent", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.enabledModels).toEqual(["openai-codex/gpt-5.6-sol"]);
    const firecode = JSON.parse(readFileSync(join(f.managed, "pi-package", "firecode", "config.jsonc"), "utf8"));
    expect(firecode.features.master).toBe(true);
    expect(firecode.features.review).toBe(false);
    expect(JSON.stringify(firecode)).not.toContain("anthropic/");
  });

  test("custom mode installs only the selected optional capability", () => {
    const f = fixture(ready());
    const result = f.run(["apply", "--mode", "custom", "--with-browser", "--keep-system", "--yes", "--json"]);
    expect(result.status).toBe(0, result.stderr);
    expect(existsSync(join(f.fakeState, "agent-browser"))).toBe(true);
    expect(existsSync(join(f.fakeState, "cloakbrowser"))).toBe(true);
    expect(existsSync(join(f.fakeState, "bcu"))).toBe(false);
    expect(existsSync(join(f.home, ".config", "ghostty", "config"))).toBe(false);
    expect(readFileSync(join(f.home, ".zshrc"), "utf8")).toContain("my-agent-workstation");
    expect(readFileSync(join(f.managed, "config", "shell.d", "browser.zsh"), "utf8")).toContain("AGENT_BROWSER_EXECUTABLE_PATH");
  });

  test("repair restores missing and locally corrupted managed assets", () => {
    const f = fixture(ready());
    expect(apply(f, "full").status).toBe(0);
    const skill = join(f.managed, "pi-package", "skills", "operations", "workstation-setup", "SKILL.md");
    const terminal = join(f.managed, "config", "ghostty.conf");
    const orphan = join(f.managed, "pi-package", "orphan.txt");
    const zshrc = join(f.home, ".zshrc");
    writeFileSync(skill, "corrupt\n");
    writeFileSync(terminal, "corrupt\n");
    writeFileSync(orphan, "orphan\n");
    writeFileSync(zshrc, readFileSync(zshrc, "utf8").replace(/source .*init\.zsh/, "corrupt managed body"));
    const repaired = f.run(["repair", "--yes", "--json"]);
    expect(repaired.status).toBe(0, repaired.stderr);
    expect(readFileSync(skill, "utf8")).not.toBe("corrupt\n");
    expect(readFileSync(terminal, "utf8")).not.toBe("corrupt\n");
    expect(existsSync(orphan)).toBe(false);
    expect(readFileSync(zshrc, "utf8")).toContain("source ");
  });

  test("update refreshes stable dependencies", () => {
    const f = fixture(ready());
    expect(apply(f).status).toBe(0);
    writeFileSync(join(f.fakeState, "herdr_latest"), "2.0.0");
    const updated = f.run(["update", "--yes", "--json"]);
    expect(updated.status).toBe(0, updated.stderr);
    const log = readFileSync(f.log, "utf8");
    expect(log).toContain("npm install --global --ignore-scripts @earendil-works/pi-coding-agent@latest");
    expect(log).toContain("curl -fsSL https://herdr.dev/install.sh -o");
  });

  test("pre-existing BCU and Herdr integration remain external on uninstall", () => {
    const f = fixture(ready({ bcu: "" }));
    expect(apply(f, "full").status).toBe(0);
    expect(f.run(["uninstall", "--yes", "--json"]).status).toBe(0);
    expect(existsSync(join(f.fakeState, "bcu"))).toBe(true);
    expect(existsSync(join(f.fakeState, "integration"))).toBe(true);
    const commands = readFileSync(f.log, "utf8");
    expect(commands).not.toContain("integration uninstall pi");
    expect(commands).not.toContain("uninstall --global better-computer-use");
  });

  test("an existing lookalike managed block is never claimed or removed", () => {
    const f = fixture(ready());
    const zshrc = join(f.home, ".zshrc");
    const existing = "user config\n# >>> my-agent-workstation >>>\nexternal body\n# <<< my-agent-workstation <<<\n";
    writeFileSync(zshrc, existing);
    expect(apply(f).status).toBe(0);
    expect(f.run(["uninstall", "--yes", "--json"]).status).toBe(0);
    expect(readFileSync(zshrc, "utf8")).toBe(existing);
  });

  test("full mode refuses ready state until BCU permissions are usable", () => {
    const f = fixture(ready({ bcu_permissions_missing: "" }));
    const result = apply(f, "full");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).valid).toBe(false);
    expect(result.stderr).toContain("configure-search");
    expect(existsSync(join(f.managed, "state.json"))).toBe(false);
  });

  test("search setup keeps secrets out of output, logs, and shell config", () => {
    const f = fixture();
    const result = f.run(["configure-search"], "brave-secret-value\nexa-secret-value\n");
    expect(result.status).toBe(0, result.stderr);
    expect(result.stdout).not.toContain("secret-value");
    expect(existsSync(f.log)).toBe(false);
    expect(existsSync(join(f.home, ".zshrc"))).toBe(false);
  });

  test("a concurrent setup owns the mutation lock", () => {
    const f = fixture(ready());
    const lock = join(f.managed, ".lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), `${process.pid}\n`);
    const result = apply(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("setup 正在运行");
    expect(existsSync(f.log)).toBe(false);
  });

  test("Homebrew Herdr migration requires explicit pane-stopping consent", () => {
    const f = fixture(ready());
    rmSync(join(f.home, ".local", "bin", "herdr"));
    const refused = apply(f);
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain("--migrate-herdr");
    const migrated = f.run(["apply", "--mode", "core", "--keep-system", "--migrate-herdr", "--yes", "--json"]);
    expect(migrated.status).toBe(0, migrated.stderr);
    const log = readFileSync(f.log, "utf8");
    expect(log).toContain("brew services stop herdr");
    expect(log).toContain("brew uninstall herdr");
    expect(log).toContain("curl -fsSL https://herdr.dev/install.sh -o");
  });

  test("dry-run writes nothing and source Pi is never overwritten", () => {
    const dry = fixture(ready());
    const planned = dry.run(["apply", "--yes", "--json", "--keep-system", "--dry-run"]);
    expect(planned.status).toBe(0);
    expect(json(planned).dry_run).toBe(true);
    expect(existsSync(dry.managed)).toBe(false);

    const source = fixture({ brew: "", pi_version: "dev" });
    const refused = apply(source);
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain("源码 Pi");
    expect(existsSync(source.log)).toBe(false);
  });
});
