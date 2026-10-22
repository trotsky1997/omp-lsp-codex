---
name: codex-lsp
description: Use the bundled local LSP CLI for code navigation, symbol lookup, diagnostics, and rename workflows when a matching language server is installed.
---

This plugin exposes LSP operations as a CLI, not as a separate tool entry. Do not stop because the tool list has no LSP item. When a terminal or shell execution tool is available, call the CLI through it. If no terminal or shell execution tool is available, say that shell execution is unavailable.

Use `codex-lsp` when language-server information can resolve a code question or validate edited files. Run it through the terminal or shell execution tool. If the command is not on `PATH`, use the bundled executable at `bin/codex-lsp` relative to the plugin root; from this skill directory that is `../../bin/codex-lsp`. For standalone use without the plugin, invoke it with `uvx --from 'git+https://github.com/trotsky1997/omp-lsp-codex.git' codex-lsp`; the GitHub account used by `uvx` must have access to the private repository.

Start with `codex-lsp status`. Use the command output as evidence and open the affected source before editing. If no server matches or diagnostics are unverified, continue with the project's normal compiler, linter, or tests when appropriate.

Common commands:

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
