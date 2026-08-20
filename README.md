# My Agent Workstation

English | [简体中文](README.zh-CN.md)

Reproduce the same coding-agent workstation across Apple Silicon Macs. One command opens a Chinese setup wizard; existing components are updated or repaired instead of duplicated.

Supports **Apple Silicon, macOS 14+, and Zsh only**.

## Install

The bootstrap downloads the latest stable GitHub Release, never an unreleased `main` snapshot:

```bash
curl -fsSL https://raw.githubusercontent.com/Suge8/my-agent-workstation/main/install.sh | bash
```

Maintainers can run `./setup` from a checkout. The wizard offers:

- **Full matching setup (recommended):** core runtime, desktop/browser automation, Ghostty, and terminal polish.
- **Core:** Pi, Herdr, FireCode, active Skills, SYSTEM, and model configuration.
- **Custom:** select BCU, browser automation, terminal tools, Helium, and search independently.

“One command” does not bypass macOS permissions, provider OAuth, API-key entry, or confirmation before replacing SYSTEM.

## Included

- **Pi:** agent sessions, models, and package host.
- **Herdr:** required workspace, tab, pane, and agent-state manager. The verified official installer tracks the latest stable release, while a managed LaunchAgent starts it at login.
- **FireCode:** presets, status UI, adversarial review, and multi-agent control.
- **Skills:** task-specific operating guidance, excluding archives, `search-skills`, evals, caches, and vendors.
- **BCU:** standalone CLI, Broker, and native Helper for macOS app control. Attribution is documented in its [package README](packages/better-computer-use/README.md).
- **agent-browser + CloakBrowser:** isolated web automation. Helium is only an optional daily browser.
- **Ghostty + Starship + Fastfetch:** optional terminal, prompt, and startup system summary. Zsh suggestions and highlighting load directly without Oh My Zsh.

## Operate

```bash
./setup doctor --json          # read-only diagnosis
./setup plan --mode full       # preview changes
./setup verify                 # verify selected capabilities
./setup update --yes           # update stable managed components
./setup repair --yes           # repair diagnosed gaps
./setup uninstall              # remove managed content, retain backups and external tools
./setup configure-search       # store Brave/Exa keys in macOS Keychain
```

The installed `workstation-setup` Skill delegates to the same control plane. Brave and Exa read environment variables first, then macOS Keychain; Context7 keeps its own OAuth. Secrets never enter shell configuration, state files, or the repository.

Provider readiness is checked with `pi auth check --no-refresh`. Only authenticated, available models are written to Pi and FireCode; unavailable roles are disabled rather than left broken. Follow the [model selection format](resources/models/README.md) and pass `--selections <json>` to replace recommended models; the choice is retained across updates alongside unrelated Pi settings and custom presets.

Every managed replacement is backed up. Ghostty and Zsh receive removable marked fragments. SYSTEM is a full replacement and non-interactive runs must explicitly choose `--replace-system` or `--keep-system`. Migrating an existing Homebrew Herdr stops its panes, so it separately requires `--migrate-herdr`.

## Develop

```bash
bun run test
bun run check:shell
npm run test:bcu
```

See [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) and [.github/SECURITY.md](.github/SECURITY.md). This repository uses the [MIT License](LICENSE); bundled third-party code retains its own notices.
