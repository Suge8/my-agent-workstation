import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const setup = resolve(import.meta.dir, "../setup");
const installer = resolve(import.meta.dir, "../install.sh");
const roots = [];
setDefaultTimeout(90000);

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
      "list") has antigravity && printf 'npm:pi-antigravity\\n'; has independent_firecode && printf '/tmp/pi-firecode\\n'; exit 0 ;;
      "install npm:pi-antigravity") log "$@"; touch "$state/antigravity" ;;
      "update npm:pi-antigravity") log "$@" ;;
      install\\ *) log "$@"; touch "$state/workstation_package" ;;
      "remove /tmp/pi-firecode") log "$@"; rm -f "$state/independent_firecode" ;;
      remove\\ *) log "$@"; rm -f "$state/workstation_package" ;;
      "auth check --provider "*" --json --no-refresh")
        provider=\${4}
        if test -f "$state/auth-$provider"; then printf '{"status":"ready","provider":"%s"}\\n' "$provider"; else printf '{"status":"not_ready","provider":"%s"}\\n' "$provider"; exit 1; fi
        ;;
      "--list-models"|"--no-extensions --list-models")
        printf 'provider model context max-out thinking images\\n'
        if has auth-openai-codex; then printf 'openai-codex gpt-5.6-sol 1M 128K yes yes\\nopenai-codex gpt-5.6-terra 1M 128K yes yes\\nopenai-codex gpt-5.6-luna 1M 128K yes yes\\nopenai-codex gpt-5.4-mini 1M 128K yes yes\\nopenai-codex gpt-5.3-codex-spark 1M 128K yes yes\\n'; fi
        if has auth-anthropic; then printf 'anthropic claude-fable-5 1M 128K yes yes\\nanthropic claude-sonnet-5 1M 128K yes yes\\nanthropic claude-opus-5 1M 128K yes yes\\nanthropic claude-opus-4-6 1M 128K yes yes\\n'; fi
        if has auth-xai; then printf 'xai grok-4.6 1M 128K yes yes\\n'; fi
        if has auth-deepseek; then printf 'deepseek deepseek-v4-flash 1M 128K yes yes\\ndeepseek deepseek-v4-pro 1M 128K yes yes\\n'; fi
        if has auth-kimi-coding; then printf 'kimi-coding k3 1M 128K yes yes\\nkimi-coding k3-256k 1M 128K yes yes\\n'; fi
        if has auth-antigravity; then printf 'antigravity gemini-3.7-flash 1M 128K yes yes\\n'; fi
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
      "integration install pi") log "$@"; has integration_install_noop || touch "$state/integration" ;;
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
      *api.github.com/repos/*/releases/latest*) has release || exit 1; printf '{"tag_name":"v9.9.9"}\\n' ;;
      *github.com/*/archive/refs/tags/*.tar.gz*) has release || exit 1; output=\${@: -1}; cp "$state/release.tar.gz" "$output" ;;
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
  if ("release" in state) {
    const release = join(root, "release", "my-agent-workstation-9.9.9");
    mkdirSync(release, { recursive: true });
    const releaseSetup = join(release, "setup");
    writeFileSync(releaseSetup, '#!/bin/bash\nprintf "updated %s\\n" "$*" >> "$FAKE_LOG"\n');
    chmodSync(releaseSetup, 0o755);
    expect(spawnSync("/usr/bin/tar", ["-czf", join(fakeState, "release.tar.gz"), "-C", join(root, "release"), "my-agent-workstation-9.9.9"]).status).toBe(0);
  }
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
  const runFrom = (program, args, input, options = {}) => spawnSync(program, args, { env, input, encoding: "utf8", timeout: 30000, ...options });
  const run = (args, input) => runFrom(setup, args, input);
  return { root, home, managed, fakeState, log, env, run, runFrom };
}

function json(result) {
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

function ready(overrides = {}) {
  return { brew: "", pi_npm: "", pi_version: "1.0.0", pi_latest: "1.0.0", herdr: "", herdr_version: "1.0.0", service: "", integration: "", ...overrides };
}

function completeAuth(overrides = {}) {
  return ready({
    "auth-openai-codex": "", "auth-anthropic": "", "auth-xai": "", "auth-deepseek": "",
    "auth-kimi-coding": "", "auth-antigravity": "", ...overrides,
  });
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

  test("public wizard bootstraps the Agent before optional workstation configuration", () => {
    const f = fixture(ready());
    const result = f.run([], "\nn\ny\n");
    expect(result.status).toBe(0, result.stderr);
    expect(result.stdout).toContain("先安装 Pi、Herdr 和 Workstation Skill");
    expect(result.stdout).toContain("继续配置工作站");
    expect(result.stdout).not.toContain("模型选择 JSON");
    const state = JSON.parse(readFileSync(join(f.managed, "state.json"), "utf8"));
    expect(state.mode).toBe("core");
    expect(state.installation_root).toBe(join(f.managed, "runtime"));
  });

  test("core postcondition failures return an error and do not publish resumable state", () => {
    const f = fixture(ready({ integration_install_noop: "" }));
    rmSync(join(f.fakeState, "integration"));
    const result = apply(f);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ valid: false, components: { pi_integration: "missing" } });
    expect(existsSync(join(f.managed, "state.json"))).toBe(false);
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

  test("managed Pi fields are restored without deleting later unrelated changes", () => {
    const f = fixture(ready({ "auth-openai-codex": "" }));
    const agent = join(f.home, ".pi", "agent");
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "SYSTEM.md"), "original system\n");
    writeFileSync(join(agent, "settings.json"), '{"custom":"settings"}\n');
    writeFileSync(join(agent, "keybindings.json"), '{"custom":"keys"}\n');
    writeFileSync(join(agent, "bark-key"), "original bark\n");
    expect(apply(f, "core", ["--replace-system"]).status).toBe(0);
    expect(f.run(["configure-search"], "\n\nhttps://api.day.app/new/\n").status).toBe(0);
    const settingsPath = join(agent, "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    settings.custom = "changed after install";
    settings.addedAfterInstall = true;
    settings.defaultProvider = "user-provider";
    settings.defaultModel = "user-model";
    settings.warnings.keepAfterInstall = true;
    writeFileSync(settingsPath, `${JSON.stringify(settings)}\n`);
    const keybindingsPath = join(agent, "keybindings.json");
    const keybindings = JSON.parse(readFileSync(keybindingsPath, "utf8"));
    keybindings.custom = "changed after install";
    keybindings.addedAfterInstall = ["ctrl+x"];
    keybindings["app.model.cycleForward"] = ["ctrl+m"];
    writeFileSync(keybindingsPath, `${JSON.stringify(keybindings)}\n`);
    const firecodePath = join(agent, "extensions", "firecode", "config.jsonc");
    const firecode = JSON.parse(readFileSync(firecodePath, "utf8"));
    firecode.features.header = false;
    firecode.custom = { retained: true };
    writeFileSync(firecodePath, `${JSON.stringify(firecode)}\n`);
    expect(f.run(["update", "--yes", "--json"]).status).toBe(0);
    expect(f.run(["update", "--yes", "--json"]).status).toBe(0);
    expect(JSON.parse(readFileSync(firecodePath, "utf8")).features.header).toBe(false);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({ defaultProvider: "user-provider", defaultModel: "user-model" });
    expect(JSON.parse(readFileSync(keybindingsPath, "utf8"))["app.model.cycleForward"]).toEqual(["ctrl+m"]);
    expect(f.run(["uninstall", "--yes", "--json"]).status).toBe(0);
    expect(readFileSync(join(agent, "SYSTEM.md"), "utf8")).toBe("original system\n");
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      custom: "changed after install",
      addedAfterInstall: true,
      defaultProvider: "user-provider",
      defaultModel: "user-model",
      warnings: { keepAfterInstall: true },
    });
    expect(JSON.parse(readFileSync(keybindingsPath, "utf8"))).toEqual({
      custom: "changed after install",
      addedAfterInstall: ["ctrl+x"],
      "app.model.cycleForward": ["ctrl+m"],
    });
    expect(readFileSync(join(agent, "bark-key"), "utf8")).toBe("original bark\n");
    expect(JSON.parse(readFileSync(firecodePath, "utf8"))).toEqual({ features: { header: false }, custom: { retained: true } });
    writeFileSync(join(agent, "SYSTEM.md"), "second system\n");
    expect(apply(f, "core", ["--replace-system"]).status).toBe(0);
    expect(f.run(["uninstall", "--yes", "--json"]).status).toBe(0);
    expect(readFileSync(join(agent, "SYSTEM.md"), "utf8")).toBe("second system\n");
    expect(existsSync(join(f.managed, "backups", "history"))).toBe(true);
  });

  test("missing Pi ownership metadata blocks uninstall without discarding recovery data", () => {
    const f = fixture(ready({ "auth-openai-codex": "" }));
    expect(apply(f).status).toBe(0);
    rmSync(join(f.managed, "pi-managed.json"));
    const result = f.run(["uninstall", "--yes", "--json"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("接管清单");
    expect(existsSync(join(f.managed, "backups", "pi-settings.json.absent"))).toBe(true);
    expect(existsSync(join(f.managed, "ownership", "pi-settings"))).toBe(true);
    expect(existsSync(join(f.managed, "pi-package", "package.json"))).toBe(true);
    expect(existsSync(join(f.fakeState, "workstation_package"))).toBe(true);
  });

  test("damaged configuration ownership fails closed", () => {
    const f = fixture(ready({ "auth-openai-codex": "" }));
    expect(apply(f).status).toBe(0);
    const ownership = join(f.managed, "pi-managed.json");
    writeFileSync(ownership, "{damaged\n");
    const result = f.run(["uninstall", "--yes", "--json"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("接管清单");
    expect(existsSync(join(f.managed, "backups", "firecode-config.jsonc.absent"))).toBe(true);
    expect(existsSync(join(f.managed, "ownership", "firecode-config"))).toBe(true);
    expect(existsSync(join(f.managed, "pi-package", "package.json"))).toBe(true);
    expect(existsSync(join(f.fakeState, "workstation_package"))).toBe(true);
  });

  test("managed SYSTEM updates only while untouched and detaches when kept", () => {
    const f = fixture(ready());
    expect(apply(f, "core", ["--replace-system"]).status).toBe(0);
    const system = join(f.home, ".pi", "agent", "SYSTEM.md");
    const installed = join(f.managed, "system-installed.md");
    writeFileSync(system, "old managed system\n");
    writeFileSync(installed, "old managed system\n");
    expect(f.run(["update", "--yes", "--json"]).status).toBe(0);
    expect(readFileSync(system, "utf8")).toBe(readFileSync(resolve(import.meta.dir, "../packages/pi-config/SYSTEM.md"), "utf8"));
    writeFileSync(system, "user system\n");
    const conflict = f.run(["update", "--yes", "--json"]);
    expect(conflict.status).toBe(3);
    expect(conflict.stderr).toContain("--keep-system");
    expect(f.run(["update", "--yes", "--json", "--keep-system"]).status).toBe(0);
    expect(existsSync(join(f.managed, "ownership", "system"))).toBe(false);
    expect(f.run(["uninstall", "--yes", "--json"]).status).toBe(0);
    expect(readFileSync(system, "utf8")).toBe("user system\n");
  });

  test("full mode installs an independent BCU package and terminal fragments without duplicating markers", () => {
    const f = fixture(completeAuth());
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

  test("authenticated providers generate the runtime FireCode configuration", () => {
    const f = fixture(ready({ "auth-openai-codex": "" }));
    const result = apply(f);
    expect(result.status).toBe(0, result.stderr);
    const agent = join(f.home, ".pi", "agent");
    const settings = JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"));
    expect(settings.enabledModels).toEqual([
      "openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-terra", "openai-codex/gpt-5.6-luna",
      "openai-codex/gpt-5.4-mini", "openai-codex/gpt-5.3-codex-spark",
    ]);
    const firecode = JSON.parse(readFileSync(join(agent, "extensions", "firecode", "config.jsonc"), "utf8"));
    expect(firecode.features.master).toBe(true);
    expect(firecode.features.review).toBe(false);
    expect(firecode.openai).toEqual({
      nativeCompaction: true,
      providers: {
        "openai-codex": { textVerbosity: "low", priority: true },
        xai: { priority: true },
      },
    });
    expect(JSON.stringify(firecode)).not.toContain("anthropic/");
    expect(existsSync(join(f.managed, "pi-package", "firecode", "config.jsonc"))).toBe(false);
    expect(existsSync(join(f.managed, "pi-package", "firecode", "config.example.jsonc"))).toBe(true);
  });

  test("full mode generates the complete current FireCode recommendation when providers are ready", () => {
    const f = fixture(completeAuth());
    expect(apply(f, "full").status).toBe(0);
    const config = JSON.parse(readFileSync(join(f.home, ".pi", "agent", "extensions", "firecode", "config.jsonc"), "utf8"));
    expect(Object.keys(config.presets)).toEqual(["fable", "opus5", "sol", "gemini", "ds", "k3-256", "xai"]);
    expect(config.master.models).toHaveLength(6);
    expect(config.review.reviewers).toHaveLength(3);
    expect(config.features).toMatchObject({ presets: true, master: true, review: true });
  });

  test("Architecture Wiki defaults to Chinese, persists, and switches atomically to English", () => {
    const f = fixture(ready());
    expect(apply(f).status).toBe(0);
    const skill = join(f.managed, "pi-package", "skills", "development", "architecture-wiki", "SKILL.md");
    expect(readFileSync(skill, "utf8")).toContain("代码是事实源");
    expect(JSON.parse(readFileSync(join(f.managed, "state.json"), "utf8")).architecture_language).toBe("zh");

    const switched = f.run(["repair", "--yes", "--json", "--architecture-language", "en"]);
    expect(switched.status).toBe(0, switched.stderr);
    expect(readFileSync(skill, "utf8")).toContain("Code is the source of truth");
    expect(JSON.parse(readFileSync(join(f.managed, "state.json"), "utf8")).architecture_language).toBe("en");
    expect(f.run(["update", "--yes", "--json"]).status).toBe(0);
    expect(readFileSync(skill, "utf8")).toContain("Code is the source of truth");
    const doctor = json(f.run(["doctor", "--json"]));
    expect(doctor.workstation.architecture_wiki).toEqual({ status: "normal", language: "en" });
    expect(apply(f).status).toBe(0);
    expect(readFileSync(skill, "utf8")).toContain("Code is the source of truth");
  });

  test("installed Release runtime completes lifecycle without its source checkout", () => {
    const f = fixture(ready());
    const release = join(f.root, "release-checkout");
    mkdirSync(release);
    copyFileSync(setup, join(release, "setup"));
    chmodSync(join(release, "setup"), 0o755);
    for (const directory of ["lib", "scripts", "resources", "packages"])
      cpSync(resolve(import.meta.dir, "..", directory), join(release, directory), { recursive: true });

    expect(f.runFrom(join(release, "setup"), ["apply", "--mode", "core", "--keep-system", "--yes", "--json"]).status).toBe(0);
    const runtimeSetup = join(f.managed, "runtime", "setup");
    rmSync(release, { recursive: true });
    expect(f.runFrom(runtimeSetup, ["update", "--yes", "--json"]).status).toBe(0);
    expect(f.runFrom(runtimeSetup, ["repair", "--yes", "--json", "--architecture-language", "en"]).status).toBe(0);
    const skill = join(f.managed, "pi-package", "skills", "development", "architecture-wiki", "SKILL.md");
    expect(readFileSync(skill, "utf8")).toContain("Code is the source of truth");
    expect(f.runFrom(runtimeSetup, ["uninstall", "--yes", "--json"]).status).toBe(0);
  });

  test("independent FireCode requires explicit migration", () => {
    const f = fixture(ready({ independent_firecode: "" }));
    const standalone = join(f.home, ".pi", "agent", "extensions", "firecode");
    mkdirSync(standalone, { recursive: true });
    writeFileSync(join(standalone, "index.ts"), "export { default } from './source/index.ts';\n");
    mkdirSync(join(standalone, "source"));
    writeFileSync(join(standalone, "source", "index.ts"), "export default function firecode() {}\n");
    writeFileSync(join(standalone, "config.jsonc"), '{"custom":{"retained":true}}\n');
    const refused = apply(f);
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain("--migrate-firecode");
    const migrated = f.run(["apply", "--mode", "core", "--keep-system", "--migrate-firecode", "--yes", "--json"]);
    expect(migrated.status).toBe(0, migrated.stderr);
    expect(readFileSync(f.log, "utf8")).toContain("pi remove /tmp/pi-firecode");
    expect(existsSync(join(standalone, "index.ts"))).toBe(false);
    expect(existsSync(join(standalone, "source"))).toBe(false);
    expect(JSON.parse(readFileSync(join(standalone, "config.jsonc"), "utf8")).custom).toEqual({ retained: true });
    expect(existsSync(join(f.managed, "backups", "independent-firecode", "index.ts"))).toBe(true);
  });

  test("full mode installs available capabilities and leaves model setup resumable", () => {
    const f = fixture(ready());
    const result = apply(f, "full");
    expect(result.status).toBe(0, result.stderr);
    expect(JSON.parse(result.stdout).valid).toBe(false);
    expect(existsSync(join(f.managed, "state.json"))).toBe(true);
    expect(existsSync(join(f.managed, "runtime", "setup"))).toBe(true);
    const config = JSON.parse(readFileSync(join(f.home, ".pi", "agent", "extensions", "firecode", "config.jsonc"), "utf8"));
    expect(config.features).toMatchObject({ presets: false, master: false, review: false });
  });

  test("runtime FireCode configuration write failures fail apply", () => {
    const f = fixture(ready({ "auth-openai-codex": "" }));
    const agent = join(f.home, ".pi", "agent");
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "extensions"), "blocks the runtime configuration directory\n");

    const result = apply(f);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ENOTDIR");
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
    const f = fixture(completeAuth());
    expect(apply(f, "full").status).toBe(0);
    const skill = join(f.managed, "pi-package", "skills", "operations", "workstation-setup", "SKILL.md");
    const terminal = join(f.managed, "config", "ghostty.conf");
    const orphan = join(f.managed, "pi-package", "orphan.txt");
    const init = join(f.managed, "config", "init.zsh");
    const zshrc = join(f.home, ".zshrc");
    writeFileSync(skill, "corrupt\n");
    writeFileSync(terminal, "corrupt\n");
    writeFileSync(orphan, "orphan\n");
    writeFileSync(init, "corrupt init\n");
    writeFileSync(zshrc, readFileSync(zshrc, "utf8").replace(/source .*init\.zsh/, "corrupt managed body"));
    const repaired = f.run(["repair", "--yes", "--json"]);
    expect(repaired.status).toBe(0, repaired.stderr);
    expect(readFileSync(skill, "utf8")).not.toBe("corrupt\n");
    expect(readFileSync(terminal, "utf8")).not.toBe("corrupt\n");
    expect(existsSync(orphan)).toBe(false);
    expect(readFileSync(init, "utf8")).not.toBe("corrupt init\n");
    expect(readFileSync(init, "utf8")).toContain("STARSHIP_CONFIG");
    expect(readFileSync(zshrc, "utf8")).toContain("source ");
    writeFileSync(init, "corrupt init only\n");
    expect(f.run(["verify", "--json"]).status).toBe(1);
    expect(f.run(["repair", "--yes", "--json"]).status).toBe(0);
    expect(readFileSync(init, "utf8")).toContain("STARSHIP_CONFIG");
  });

  test("release bootstrap requires a terminal only for its interactive path", () => {
    const f = fixture({ release: "" });
    const interactive = f.runFrom(installer, [], "", { detached: true });
    expect(interactive.status).toBe(1);
    expect(interactive.stderr).toContain("交互安装需要终端");
    const explicit = f.runFrom(installer, ["apply", "--yes"], "");
    expect(explicit.status).toBe(0, explicit.stderr);
    expect(readFileSync(f.log, "utf8")).toContain("updated apply --yes");
  });

  test("release update forwards the user's explicit conflict choices", () => {
    const f = fixture(ready({ release: "" }));
    const updated = f.run(["update", "--yes", "--json", "--replace-system", "--migrate-herdr"]);
    expect(updated.status).toBe(0, updated.stderr);
    expect(readFileSync(f.log, "utf8")).toContain("updated update --yes --json --replace-system --migrate-herdr");
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
    const f = fixture(completeAuth({ bcu: "" }));
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

  test("pending permissions keep a successful full install resumable", () => {
    const f = fixture(completeAuth({ bcu_permissions_missing: "" }));
    const result = apply(f, "full");
    expect(result.status).toBe(0, result.stderr);
    expect(JSON.parse(result.stdout)).toMatchObject({ valid: false, capabilities: { bcu_permissions: "pending" } });
    const state = JSON.parse(readFileSync(join(f.managed, "state.json"), "utf8"));
    expect(state.selected).toMatchObject({ bcu: true, search: true });
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
