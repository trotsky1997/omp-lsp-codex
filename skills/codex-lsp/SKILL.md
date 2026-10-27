---
name: codex-lsp
description: Use the local LSP CLI for code navigation, types, diagnostics and scoped edits; route to the matching language skill for project setup and verification.
---

Run `codex-lsp` through a terminal tool. The plugin provides a CLI. Use this skill's installed location to find bundled files.

Read the matching language subskill for project-specific decisions: [Rust](../codex-lsp-rust/SKILL.md), [Python](../codex-lsp-python/SKILL.md), or [TypeScript/JavaScript](../codex-lsp-typescript/SKILL.md). Load just the language in use.

## Focus the question

```sh
codex-lsp symbols --file PATH --query NAME
codex-lsp definition --file PATH --line N --symbol NAME
codex-lsp hover --file PATH --line N --symbol NAME
codex-lsp references --file PATH --line N --symbol NAME
codex-lsp signature-help --file PATH --line N --column N
codex-lsp inspect --file PATH --line N --symbol NAME
```

Use symbols or source search to find a current anchor. File errors suggest discovery; wrong-line errors suggest nearby matches. Positions are one-based UTF-16 columns; `NAME#2` selects a repeated token. Quote paths and pass arguments separately. Run from the project directory, or choose another with `--cwd PROJECT`.

Use one focused command for one question. `inspect` shares a server session across hover, definition, references, matching symbols and diagnostics when all are useful. Use `symbols --workspace --file PATH --query NAME` for cross-file discovery in the selected language.

Prefer human text for reading. For automation, `--fields locations` implies JSON; field paths follow the command. Check `success`, navigation `found`, and diagnostic `verified`/`hasErrors` along with the exit code. Existing diagnostic errors cause exit 1 while navigation can succeed; inspect explains this in `failedSections`.

Default limits are 50 results/hover lines, 10 per inspect section and one signature. Text budgets and truncation flags describe omissions. Use `--limit 0 --json > result.json` when complete details are required. Read [output shapes](references/outputs.md) for field selection, signature cursors or large results.

## Setup and edits

`status --file PATH` discovers servers; `doctor --file PATH` checks readiness. `setup LANGUAGE...` registers available servers and emits missing-server installation commands with official documentation. Read [setup](references/setup.md) for installation or configuration failures.

Rename, file moves and code actions preview by default. Add `--apply` for a requested change after checking the target files and replacements. Applied output reports `verification: pending`: run relevant project checks and confirm they execute. Existing diagnostics alone cannot verify runtime behavior. If an error says edits were applied, inspect files before retrying.

Edits validate ranges, versions and snapshots within one Git checkout, excluding nested repositories and escaping symlinks. Outside Git they use the language project. Resource operations in workspace edits are rejected. Read [advanced edits](references/advanced.md) for code actions, file moves, raw methods or custom server settings.

`diagnostics --changed` includes untracked files. Keep logs outside the checkout. Hooks use global configuration/executables, ignore project overrides and never apply edits; reproduce with `--cwd PROJECT diagnostics --changed --global-config-only --global-bins-only`.
