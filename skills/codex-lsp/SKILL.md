---
name: codex-lsp
description: Use the bundled local LSP CLI for code navigation, symbol lookup, diagnostics, and rename workflows; set up missing language servers when needed.
---

This plugin exposes LSP operations through a CLI, not as a separate tool entry. Do not stop because the tool list has no LSP item. In Codex or Claude Code, call the CLI through an available terminal or shell tool. If none is available, say that shell execution is unavailable.

Use `codex-lsp` when language-server information can resolve a code question or validate edited files. Run it through the terminal or shell execution tool. Register the CLI with `uv tool install --from 'git+https://github.com/trotsky1997/omp-lsp-codex.git' codex-lsp` when it is not installed. If it is installed but not on `PATH`, get the executable directory from `uv tool dir --bin` and invoke `codex-lsp` from that directory. The private repository requires GitHub access. Use the plugin-bundled `bin/codex-lsp` only when uv installation is unavailable; resolve its absolute path from the installed skill/plugin location and do not run a workspace-relative `../../bin/codex-lsp` path.

Start with `codex-lsp status`. Use the command output as evidence and open the affected source before editing. If no server matches or diagnostics are unverified, continue with the project's normal compiler, linter, or tests when appropriate.

Run `codex-lsp setup <language...>` to register servers in `~/.codex/lsp.json`; use `--project` to write to the current Git root's `.codex/lsp.json`. It accepts language names such as `rust`, `python`, and `typescript`, or a bundled server ID. When setup reports a missing executable, inspect the project's `AGENTS.md`, manifests, toolchain files, and existing package-manager conventions; install the named language server with the matching toolchain or package manager, then rerun setup. Do not stop after reporting the missing command. After setup succeeds, rerun `codex-lsp status` and verify the requested operation on a project file. If no bundled server matches, explain that and use a documented custom server entry only when the project provides a clear server choice.

Common commands:

- `codex-lsp setup rust python`
- `codex-lsp diagnostics --file path/to/file.rs`
- `codex-lsp diagnostics --changed`
- `codex-lsp definition --file path/to/file.rs --line 20 --symbol parse`
- `codex-lsp references --file path/to/file.rs --line 20 --symbol parse`
- `codex-lsp hover --file path/to/file.rs --line 20 --symbol parse`
- `codex-lsp symbols --file path/to/file.rs`
- `codex-lsp symbols --workspace --query parser`
- `codex-lsp rename --file path/to/file.rs --line 20 --symbol parse --new-name parse_value`
- `codex-lsp code-actions --file path/to/file.rs --line 20`
- `codex-lsp capabilities --file path/to/file.rs`

Rename and code-action commands preview by default. Add `--apply` only when the user requested the change. `rename-file` also previews unless `--apply` is present. Raw requests require `--apply` unless their method is on the CLI's read-only allowlist.

The CLI reads JSON overrides from `~/.codex/lsp.json` and `<git-root>/.codex/lsp.json`. Server settings use `command`, `args`, `fileTypes`, `rootMarkers`, and optional `languageId`, `initOptions`, and `settings`; built-in definitions are merged with these overrides. Hooks use built-in definitions and globally resolved executables only. They never apply edits.
