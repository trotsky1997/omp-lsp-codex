---
name: codex-lsp
description: Use the local LSP CLI for code navigation, types, diagnostics and scoped edits; route to the matching language skill for project setup and verification.
---

Run `codex-lsp` through a terminal tool. The plugin provides a CLI. Use this skill's installed location to find bundled files.

Read the matching language subskill for project-specific decisions: [Rust](../codex-lsp-rust/SKILL.md), [Python](../codex-lsp-python/SKILL.md), or [TypeScript/JavaScript](../codex-lsp-typescript/SKILL.md). Load just the language in use.

## Focus the question

```sh
codex-lsp symbols --file PATH --query NAME --limit 5
codex-lsp definition --file PATH --line N --symbol NAME
codex-lsp hover --file PATH --line N --symbol NAME
codex-lsp references --file PATH --line N --symbol NAME
codex-lsp signature-help --file PATH --line N --symbol NAME
codex-lsp snippet --file PATH --line N --symbol NAME
codex-lsp inspect --file PATH --line N --symbol NAME
codex-lsp inspect --file PATH --line N --symbol NAME --context
codex-lsp batch --input queries.jsonl --json
codex-lsp callers --file PATH --line N --symbol NAME --depth 2
codex-lsp callees --file PATH --line N --symbol NAME --depth 2
codex-lsp complete --file PATH --line N --column N --query NAME --resolve
codex-lsp diagnostics --file PATH --save-baseline BASELINE.json
codex-lsp diagnostics --baseline BASELINE.json
codex-lsp impact --changed --json
```

Use symbols or source search to find a current anchor. File errors suggest discovery; wrong-line errors suggest nearby matches. Positions are one-based UTF-16 columns; `NAME#2` selects a repeated token. Quote paths and pass arguments separately. Run from the project directory, or choose another with `--cwd PROJECT`.

Symbols rank exact spelling first, then case-insensitive exact names, then partial matches; limits retain complete counts. Signature errors show calls on the selected line and nearby call-name matches; check the receiver when names repeat across types. If an automatic signature cursor gets an empty server response, inspect hover/definition or the declaration instead of guessing another column. Empty responses include the actual one-based `cursor` in JSON.

Install `npm install --global @ast-grep/cli` for syntax anchors, automatic signature cursors and snippets. With it, `--symbol` excludes comments/string contents. For signature-help, select the callable on a call-site line; the CLI finds its argument cursor, including nested/generic calls. An explicit `--column` inside arguments selects a later parameter. `snippet` returns the smallest enclosing declaration without LSP; use it to read a body before fetching semantic details. Missing ast-grep keeps textual navigation and gives installation guidance for automatic signatures/snippets.

Use one focused command for one question. `inspect` shares a server session across hover, definition, references, matching symbols and diagnostics when all are useful. Add `--context` for deduplicated enclosing source, definitions, types and sampled reference bodies. Context shares a 6,000-character snippet budget; `provider: lines` identifies nearby-line fallback when AST declarations are unavailable. Use `symbols --workspace --file PATH --query NAME` for cross-file discovery in the selected language.

Use `batch` for several known queries/files to reuse servers. Its JSONL rows require `command` and `file`, e.g. `{"command":"hover","file":"src/main.ts","line":10,"symbol":"parse"}` or `{"command":"inspect","file":"src/main.ts","line":10,"context":true}`. Run from the project directory; optional row `cwd` is relative to the batch directory. File/position flags belong in rows. A row's `fields` uses that command's output: hover uses `"fields":"hover"`, snippet uses `"fields":"snippet,range"`. Only inspect wraps sections in `results`, e.g. `"fields":"results.context.snippets,results.diagnostics.counts"`; diagnostic failure state stays visible. `--input -` reads stdin. Check `failedQueries` and each result's `code`/state: one failure preserves later results and makes batch exit 1. `inputLine` identifies the input row; `line` is its source anchor. JSON is emitted when all queries finish; resume a running terminal session after a short tool wait, especially for large Rust projects. Read [batch/context output](references/outputs.md) for limits, supported row fields or automation.

Prefer human text for reading. For automation, `--fields locations` implies JSON; symbols use `--fields symbols`, and inspect wraps sections in `results`. Check `success`, navigation `found`, and diagnostic `verified`/`hasErrors` along with the exit code. Existing diagnostic errors cause exit 1 while navigation can succeed; inspect explains this in `failedSections`.

Default limits are 50 results/hover lines, 10 per inspect section and one signature. Text budgets and truncation flags describe omissions. Use `--limit 0 --json > result.json` when complete details are required. Read [output shapes](references/outputs.md) for field selection, signature cursors or large results.

Use call hierarchy to follow callers/callees, completion to discover members at a cursor, a diagnostic baseline to separate new issues from existing ones, and impact for changed declarations and candidate tests with evidence. These commands are read-only with respect to source. Read [analysis workflows](references/analysis.md) for capture/compare, traversal and resolution budgets, incomplete results or removed code.

## Setup and edits

`status --file PATH` discovers servers; `doctor --file PATH` checks readiness. `setup LANGUAGE...` registers available servers and emits missing-server installation commands with official documentation. Read [setup](references/setup.md) for installation or configuration failures.

Rename, file moves and code actions preview by default. Add `--apply` for a requested change after checking the target files and replacements. Applied output reports `verification: pending`: run relevant project checks and confirm they execute. Existing diagnostics alone cannot verify runtime behavior. If an error says edits were applied, inspect files before retrying.

Edits validate ranges, versions and snapshots within one Git checkout, excluding nested repositories and escaping symlinks. Outside Git they use the language project. Resource operations in workspace edits are rejected. Read [advanced edits](references/advanced.md) for code actions, file moves, raw methods or custom server settings.

`diagnostics --changed` includes untracked files. Keep logs outside the checkout. Hooks use global configuration/executables, ignore project overrides and never apply edits; reproduce with `--cwd PROJECT diagnostics --changed --global-config-only --global-bins-only`.
