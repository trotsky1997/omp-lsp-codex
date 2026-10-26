---
name: codex-lsp
description: Use the bundled local LSP CLI for code navigation, symbol lookup, diagnostics, and rename workflows; set up missing language servers when needed.
---

This skill is already loaded when invoked; do not search for another `SKILL.md` under a guessed Codex skills path. The plugin exposes LSP through a CLI, not a separate tool entry. In Codex or Claude Code, run `codex-lsp` through an available terminal or shell tool.

Pass the command and flags as separate arguments to a command runner: `["codex-lsp", "inspect", "--file", "/path with spaces/file.ts", "--line", "20"]`. For a shell command, quote individual paths. When a source path is missing, locate the real file with `rg --files` before retrying.

`--cwd <project-root>` selects project context for relative paths, setup and `--changed`. On macOS, Bun can stall before JavaScript starts while probing an unresponsive parent directory. Run from the installed plugin directory and pass the project with `--cwd`; the bundled form is `bun --cwd <installed-plugin-root> <installed-plugin-root>/src/cli.ts --cwd <project-root> <command>`. This also works across platforms. Runtime startup stalls produce no CLI JSON; increasing the LSP timeout leaves that startup issue unresolved. Hooks start from their plugin directory and forward the event's project directory explicitly.

The CLI and hooks run directly from TypeScript using Bun. Register with `bun add --global git+https://github.com/trotsky1997/omp-lsp-codex.git` if missing. Check `bun --version` first; use the official Bun installation instructions for the current platform if needed. If the command is not on `PATH`, use the directory from `bun pm bin --global`. The bundled fallback is `bun <absolute-plugin-path>/src/cli.ts <command>`; resolve the path from the installed plugin location. Update with `bun add --global --force git+https://github.com/trotsky1997/omp-lsp-codex.git`.

## Setup and use

1. Start with `codex-lsp status --file <source-file>` for fast server discovery. For related code questions, run `codex-lsp inspect --file <source-file> --line N --symbol NAME`: it returns hover, definition, references, matching file symbols and diagnostics through one server session. Use `doctor --file <source-file>` to troubleshoot initialization and project configuration. If no server is available, run `codex-lsp setup <language...>`. This registers an executable; it does not install the server. Use `--project` for project-local configuration, including temporary directories without a Git repository or manifest. Run setup from the project root: `--project` is a flag and accepts no path. Remove `.codex/lsp.json` afterward only when it was created solely for a temporary trial.
2. If setup reports a missing server, check the project's `AGENTS.md`, manifests, toolchain files, and `command -v <executable>` first. Follow the install command and official documentation printed by setup, choosing the option for the current OS and distribution. Check the package manager's configured install prefix before installing so an existing server is not duplicated. For npm installs, add `--fetch-timeout=15000 --fetch-retries=0`; if the registry is unavailable, inspect `npm cache ls <package>` and use a compatible cached version with `--offline` rather than waiting on a stalled install.
3. Rerun setup, then status and one operation relevant to the task. Use `capabilities --file <path>` when a command returns no result or the server's support is unclear.

For Python, install the project's declared dependencies into its project environment. Pyright and basedpyright automatically select `.venv`, then `venv`, under the matched project root, using `bin/python` on macOS/Linux or `Scripts/python.exe` on Windows. `doctor` shows the analysis interpreter as `pythonPath` in JSON. Explicit `settings.python.pythonPath` overrides discovery; use it for a custom environment. If an installed package is reported missing, verify its import with the interpreter shown by doctor.

If `typescript-language-server` starts but initialization says it cannot find a TypeScript installation, check for the project's `node_modules/typescript/lib/tsserver.js` first. If the project has no installed TypeScript, locate the existing global TypeScript package (for npm, start with `npm root --global`) and set `initOptions.tsserver.fallbackPath` to its `lib/tsserver.js` in the server override. Preserve any existing `initOptions`; do not install a second TypeScript copy just to work around server discovery. See the [official TypeScript language server configuration](https://github.com/typescript-language-server/typescript-language-server/blob/master/docs/configuration.md#tsserver-options).

File commands load the target project's configuration even when run from another directory. To select a project and matching language servers for workspace symbols, pass `symbols --workspace --file <path> --query <name>`. Use this in mixed-language repositories when working on one language. Root searches query every discovered server, so symbols can coexist with server failures in JSON `errors` and a nonzero exit code. Searches open a source file and wait for Pyright's initial analysis before querying. An empty successful result can still depend on the server's indexing behavior; try file symbols, navigation from a known use, or source search.

TypeScript Language Server defaults to `tsserver.useSyntaxServer: "never"` so cold cross-file queries use semantic results. If a server still points to an import, inspect the imported module for the declaration.

In `--json` mode, stdout contains a JSON object on both success and failure. Check the process exit code and `success`; navigation and hover also include `found` to show whether a result exists. Returned file paths are canonical absolute paths, so macOS `/tmp/...` paths may appear as `/private/tmp/...`.

Navigation lists, symbols, code-actions, diagnostics and rename previews show up to 50 results by default; hover shows up to 50 lines. These JSON results report `total`, `shown`, and `truncated`. Use `--limit N` to adjust the preview, or `--limit 0 --json > /path/to/result.json` to save complete output. Diagnostics include full severity `counts` and retain the correct exit code when hidden results contain errors. Truncated rename previews omit `workspaceEdit` / `workspaceEdits` and set `workspaceEditOmitted`; request unlimited output to obtain the complete edit object. Display limits leave `--apply` operations complete. Raw `request` results are returned unchanged.

`inspect` defaults to 10 results or hover lines per section; use `--limit` to adjust all sections. JSON `results` preserves each section's status, unsupported capabilities and errors; top-level `failedSections` identifies the cause of a nonzero exit. Existing diagnostic errors cause exit 1 while navigation results remain available. `--new-name NAME` adds a rename preview; `inspect` always runs read-only and rejects `--apply`. Use a separate `rename --apply` when the user requested the change.

For diagnostics, `verified: true` together with `hasErrors: true` means analysis completed and found project code errors. Inspect also explains this in its top-level `hint`. Read those code diagnostics and the other query results; `verified: false` requires checking analysis readiness, dependencies or source changes.

Pyright and Basedpyright file commands wait for initial file diagnostics so cross-file references and rename previews use an analyzed project. A timeout fails the command; increase `--timeout` for expensive files. Type errors reported during analysis do not block navigation. Symbol renames with no edits return a nonzero exit code.

For diagnostics JSON, check `verified` as well as `hasErrors`; every selected server must verify each file. Unverified checks return `success: false` and a nonzero exit code. `--changed` reports Git failures, more than 200 changed files, oversized files and symlinks leaving the workspace as errors; inspect the error and use `--file` for individual checks. Navigation retries and push diagnostics use the requested `--timeout` (5–300 seconds). Rust diagnostics run rust-analyzer's Cargo check for that invocation and wait for compiler diagnostics; raise `--timeout` for large workspaces. With `--symbol`, use a token that actually appears on the specified line; an absent token is rejected before the LSP request. For a different workspace, run `doctor` from that workspace's root.

`diagnostics --changed` includes untracked files. Changed active `.codex/lsp.json` files are validated by the CLI and listed separately in `configurationChecks`, without requiring a JSON language server; malformed configuration still fails. Hook scope marks ignored project configuration explicitly. Other JSON and helper scripts without an available matching server remain unverified and explain how to set one up. Keep trial logs and recorders outside the project. From a neutral runtime directory, include `--cwd <project-root>` for commands without `--file`; an absolute `--file` selects its own project for file queries. An explicit `--file .codex/lsp.json` requests ordinary JSON language-server diagnostics.

Rust semantic commands and doctor wait for the server to report a ready workspace. Large projects may need `doctor --timeout 120`. Workspace health warnings and errors fail with the server's explanation; inspect `cargo metadata --locked --format-version 1`, project dependencies, build scripts, and toolchain availability before retrying. If the project has no Cargo.lock, allow an initial metadata run without `--locked`. LSP processes disable rustup's implicit toolchain installation. Install the project's required toolchain explicitly, then retry; keep the existing user environment when checking servers.

If workspace analysis times out, retry the same command with the larger `--timeout` suggested by the error. For an edit command, inspect the files first when the error reports edits already applied. For project test acceptance, select the required features and check that the runner executed tests; a zero-test run leaves acceptance incomplete.

`codex-lsp hover` automatically checks DevDocs when the language server returns no hover content. Use the returned DevDocs link as a reference for the symbol; the CLI searches the downloaded index locally and returns a matching page URL.

## Common commands

- `codex-lsp setup rust python`
- `codex-lsp doctor`
- `codex-lsp inspect --file path/to/file.rs --line 20 --symbol parse --json`
- `codex-lsp diagnostics --file path/to/file.rs`
- `codex-lsp --cwd <project-root> diagnostics --changed`
- `codex-lsp definition --file path/to/file.rs --line 20 --symbol parse`
- `codex-lsp references --file path/to/file.rs --line 20 --symbol parse`
- `codex-lsp hover --file path/to/file.rs --line 20 --symbol parse`
- `codex-lsp symbols --file path/to/file.rs --query parse`
- `codex-lsp symbols --workspace --query parser`
- `codex-lsp rename --file path/to/file.rs --line 20 --symbol parse --new-name parse_value`
- `codex-lsp code-actions --file path/to/file.rs --line 20`
- `codex-lsp capabilities --file path/to/file.rs`

Use `symbols --query` to narrow large document-symbol output by name. Workspace-symbol searches require a query and use the language server's matching behavior.

Document symbols describe declarations in that file. If a file query is empty, use `symbols --workspace --file <path> --query <name>` to search the project. Wrong-line symbol errors suggest nearby matching lines and fail before starting a server. Each invocation starts and closes its server; cold Rust queries can spend several seconds initializing the workspace. Use `inspect` to share that startup across related queries.

Rename and code-action commands preview by default. Rename previews list file ranges and replacement text; JSON also includes `workspaceEdit` (`workspaceEdits` for `rename-file`). Add `--apply` only when the user requested the change. `rename-file` also previews unless `--apply` is present. Raw requests require `--apply` unless their method is on the CLI's read-only allowlist. Raw `textDocument/codeAction` queries are read-only and return suggestions without executing them; use `--payload` for the LSP range and diagnostics context.

Applied edits report `verification: "pending"` and a next-step hint. Run the project's relevant build or focused tests before declaring the change complete. A language server can omit imports or re-exports during rename; use diagnostics and `code-actions` at the failing use, apply the appropriate import fix, then rerun project checks. Match Rust analysis to the test feature set with project-local `settings.rust-analyzer.cargo.features` when needed; see the [official feature configuration](https://rust-analyzer.github.io/book/configuration.html#cargo.features).

`code-actions --file PATH --line N` selects the whole line and includes initial diagnostics. Add `--symbol` or `--column` for a specific point. Select a returned title with `--query TITLE --apply` to apply it. Empty results include a hint to check diagnostics, selection and server capabilities.

`request --method textDocument/signatureHelp --file PATH --line N --column N` is read-only. A partial JSON `--payload` such as `{"position":{"line":0,"character":5}}` uses LSP zero-based positions; the CLI fills the target file's `textDocument.uri`. Explicit payload fields override these defaults.

Edits check opened-file snapshots and document versions. In a Git repository, edits can span sibling packages within that checkout or worktree; outside Git, they stay within the matched language project. Nested repositories keep their own boundary, and symlinks leaving the boundary are rejected. If a file changed since analysis or an edit version is stale, inspect the current file and query again. Errors containing `after applying edits`, `Edits applied`, or `File renamed and edits applied` describe completed changes followed by a failure; inspect the files before retrying. A rename rollback conflict reports both paths and preserves both files. Diagnostics discard stale versions and verify that the opened file still matches the analyzed content.

The CLI reads JSON overrides from `~/.codex/lsp.json` and `<git-root>/.codex/lsp.json`. Outside Git it finds the nearest parent `.codex/lsp.json`; project setup also uses that configuration as a root marker for the selected servers. Server settings use `command`, `args`, `fileTypes`, `rootMarkers`, and optional `languageId`, `initOptions`, and `settings`; built-in definitions are merged with these overrides. Hooks use built-ins plus the user's global configuration and globally resolved executables. They ignore project configuration and never apply edits. To reproduce hook diagnostics, use `codex-lsp --cwd <project-root> diagnostics --changed --global-config-only --global-bins-only`; project overrides can make regular CLI results differ, so compare the selected server command and settings before resolving a discrepancy.
