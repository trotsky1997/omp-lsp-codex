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

File commands load the target project's configuration even when run from another directory. To select a project for workspace symbols, pass `symbols --workspace --file <path> --query <name>`. Workspace searches open a source file before querying and report server failures in JSON `errors` with a nonzero exit code. An empty successful result can still depend on the server's indexing behavior; try file symbols, navigation from a known use, or source search.

TypeScript Language Server defaults to `tsserver.useSyntaxServer: "never"` so cold cross-file queries use semantic results. If a server still points to an import, inspect the imported module for the declaration.

In `--json` mode, stdout contains a JSON object on both success and failure. Check the process exit code and `success`; navigation and hover also include `found` to show whether a result exists. Returned file paths are canonical absolute paths, so macOS `/tmp/...` paths may appear as `/private/tmp/...`.
For diagnostics JSON, check `verified` as well as `hasErrors`; an empty diagnostic list is useful only when `verified` is true. Rust diagnostics run rust-analyzer's Cargo check for that invocation and wait for compiler diagnostics; raise `--timeout` for large workspaces. With `--symbol`, use a token that actually appears on the specified line; an absent token is rejected before the LSP request. For a different workspace, run `doctor` from that workspace's root.

`codex-lsp hover` automatically checks DevDocs when the language server returns no hover content. Use the returned DevDocs link as a reference for the symbol; the CLI searches the downloaded index locally and returns a matching page URL.

## Common commands

- `codex-lsp setup rust python`
- `codex-lsp doctor`
- `codex-lsp diagnostics --file path/to/file.rs`
- `codex-lsp diagnostics --changed`
- `codex-lsp definition --file path/to/file.rs --line 20 --symbol parse`
- `codex-lsp references --file path/to/file.rs --line 20 --symbol parse`
- `codex-lsp hover --file path/to/file.rs --line 20 --symbol parse`
- `codex-lsp symbols --file path/to/file.rs --query parse`
- `codex-lsp symbols --workspace --query parser`
- `codex-lsp rename --file path/to/file.rs --line 20 --symbol parse --new-name parse_value`
- `codex-lsp code-actions --file path/to/file.rs --line 20`
- `codex-lsp capabilities --file path/to/file.rs`

Use `symbols --query` to narrow large document-symbol output by name. Workspace-symbol searches require a query and use the language server's matching behavior.

Rename and code-action commands preview by default. Rename previews list file ranges and replacement text; JSON also includes `workspaceEdit` (`workspaceEdits` for `rename-file`). Add `--apply` only when the user requested the change. `rename-file` also previews unless `--apply` is present. Raw requests require `--apply` unless their method is on the CLI's read-only allowlist.

The CLI reads JSON overrides from `~/.codex/lsp.json` and `<git-root>/.codex/lsp.json`. Server settings use `command`, `args`, `fileTypes`, `rootMarkers`, and optional `languageId`, `initOptions`, and `settings`; built-in definitions are merged with these overrides. Hooks use built-in definitions and globally resolved executables only. They never apply edits.
