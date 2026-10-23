---
name: codex-lsp
description: Use the bundled local LSP CLI for code navigation, symbol lookup, diagnostics, and rename workflows; set up missing language servers when needed.
---

This skill is already loaded when invoked; do not search for another `SKILL.md` under a guessed Codex skills path. The plugin exposes LSP through a CLI, not a separate tool entry. In Codex or Claude Code, run `codex-lsp` through an available terminal or shell tool.

Register the CLI with `uv tool install --from 'git+https://github.com/trotsky1997/omp-lsp-codex.git' codex-lsp` if it is missing. If the command is not on `PATH`, use the directory from `uv tool dir --bin`. Use the plugin-bundled CLI only when uv is unavailable; resolve its absolute path from the installed plugin location.

## Setup and use

1. Run `codex-lsp doctor`. It validates configuration and initializes available servers. If no server is available for the current project, run `codex-lsp setup <language...>`. This registers an executable; it does not install the server. Use `--project` when the user wants workspace-local configuration or user-level configuration is not writable. Remove `.codex/lsp.json` afterward only when it was created solely for a temporary trial.
2. If setup reports a missing server, check the project's `AGENTS.md`, manifests, toolchain files, and `command -v <executable>` first. Follow the install command and official documentation printed by setup, choosing the option for the current OS and distribution. Check the package manager's configured install prefix before installing so an existing server is not duplicated. For npm installs, add `--fetch-timeout=15000 --fetch-retries=0`; if the registry is unavailable, inspect `npm cache ls <package>` and use a compatible cached version with `--offline` rather than waiting on a stalled install.
3. Rerun setup, then status and one operation relevant to the task. Use `capabilities --file <path>` when a command returns no result or the server's support is unclear.

If `typescript-language-server` starts but initialization says it cannot find a TypeScript installation, check for the project's `node_modules/typescript/lib/tsserver.js` first. If the project has no installed TypeScript, locate the existing global TypeScript package (for npm, start with `npm root --global`) and set `initOptions.tsserver.fallbackPath` to its `lib/tsserver.js` in the server override. Preserve any existing `initOptions`; do not install a second TypeScript copy just to work around server discovery. See the [official TypeScript language server configuration](https://github.com/typescript-language-server/typescript-language-server/blob/master/docs/configuration.md#tsserver-options).

Workspace symbol results depend on each server's indexing behavior. An empty `symbols --workspace` result does not establish that the symbol is absent; try `symbols --file <path>`, definition/references from a known use, or source search. If a definition points to an import statement, inspect the imported module for the actual declaration.

When parsing `--json` navigation or hover output, use `success` for request completion and `found` to check whether a result exists.
For diagnostics JSON, check `verified` as well as `hasErrors`; a successful command may have no matching server or diagnostics response. With `--symbol`, use a token that actually appears on the specified line; an absent token is rejected before the LSP request. For a different workspace, run `doctor` from that workspace's root.

`codex-lsp hover` automatically checks DevDocs when the language server returns no hover content. Use the returned DevDocs link as a reference for the symbol; the CLI searches the downloaded index locally and returns a matching page URL.

## Common commands

- `codex-lsp setup rust python`
- `codex-lsp doctor`
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
