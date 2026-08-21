# My Agent Workstation

[简体中文](README.md) | English

Install an Apple Silicon Mac coding workstation that an Agent can finish and maintain: Pi, Herdr, FireCode, Skills, desktop and browser automation, and a matching terminal experience.

Supports **Apple Silicon, macOS 14+, and Zsh only**.

## Start

Before the first Release, test from a checkout:

```bash
git clone https://github.com/Suge8/my-agent-workstation.git
cd my-agent-workstation
./setup
```

After release, the stable bootstrap will download only the latest Release:

```bash
curl -fsSL https://raw.githubusercontent.com/Suge8/my-agent-workstation/main/install.sh | bash
```

Setup completes in two stages:

1. The Shell wizard installs Pi, Herdr, and the Workstation Skill without requiring model credentials first.
2. Run `pi`; if no model is authenticated yet, run `/login`.
3. Tell the Agent: **“Continue configuring the workstation.”**
4. Complete the requested authorization steps and restart Pi once.

The Agent diagnoses the machine, shows the exact plan, and completes the remaining configuration. Only model OAuth, API keys, macOS permissions, and SYSTEM replacement require your confirmation. Unauthenticated model capabilities stay explicitly disabled; models are never silently substituted.

## What you get

The recommended setup includes:

- Pi, Herdr, FireCode, active Skills, and Architecture Wiki;
- BCU desktop control and isolated browser automation;
- Ghostty, Starship, Fastfetch, Zsh suggestions, and syntax highlighting;
- model cycling, presets, Review, and Master configuration derived from authenticated providers.

After installation, ask the Agent to check, update, or repair the workstation. Every operation delegates to the same `setup` control plane.

## Safety and ownership

The installer backs up before taking ownership and only updates or removes content it owns. User settings, custom FireCode presets, and external tools survive updates. Credentials stay in provider OAuth or macOS Keychain, never in the repository, Shell configuration, or state files.

Existing standalone FireCode or Homebrew Herdr installations require explicit migration and are never overwritten silently. Uninstall keeps package-manager tools such as Ghostty and browsers.

## Maintainers

From a checkout, use `./setup` to plan, apply, and verify explicit modes. See [model selection](resources/models/README.md), the [contribution guide](.github/CONTRIBUTING.md), and the [security policy](.github/SECURITY.md).

This repository uses the [MIT License](LICENSE); bundled third-party code retains its own notices.
