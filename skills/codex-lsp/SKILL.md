---
name: codex-lsp
description: Use the bundled local LSP CLI for code navigation, symbol lookup, diagnostics, and rename workflows; set up missing language servers when needed.
---

Use `codex-lsp` through a terminal tool. This plugin provides a CLI, without a separate LSP tool entry. This skill is already loaded; use its installed location for bundled files instead of guessing another skills path.

## Choose a focused query

Use a single command for one question. Use `inspect` when hover, definition, references, symbols and diagnostics are all useful; it shares one server session across those sections.

```sh
codex-lsp definition --file PATH --line N --symbol NAME
codex-lsp hover --file PATH --line N --symbol NAME
codex-lsp signature-help --file PATH --line N --column N
codex-lsp references --file PATH --line N --symbol NAME
codex-lsp symbols --file PATH --query NAME
codex-lsp symbols --workspace --file PATH --query NAME
codex-lsp inspect --file PATH --line N --symbol NAME
```

Prefer the compact human output for reading. Start with default limits; request complete output when omitted details are needed. Locations share a `Root:` and group repeated file paths; external files retain absolute paths. JSON retains canonical absolute locations for automation. The `server` field identifies the configured entry; `status --file PATH` shows its executable, which may be `tsgo` under the `typescript-language-server` entry.

`signature-help` shows the active overload and parameter without bulk documentation. Put the cursor just after the call's opening `(` or a separating comma; some servers return no help inside string literals. If still empty, use hover on the callable. It defaults to one signature, prioritizing the active overload; JSON indices are zero-based. Use `--limit 0 --json` for complete signatures, parameters and documentation. Server-side type abbreviations can remain in a complete response. Raw `request` responses remain complete by default and can be much larger; `--fields` explicitly selects emitted JSON.

Default display limits: 50 results/hover lines, 10 per `inspect` section. Hover, signatures, diagnostics, symbols, code actions and errors also have character budgets. Check `truncated`, `textTruncated`, `documentationOmitted`, `detailsOmitted`, `errorTruncated` and hints; a short hover can omit a return type. Diagnostic previews prioritize errors across files; counts and verification cover every diagnostic. Increase the line/result limit when useful, or save complete output with `--limit 0 --json > /tmp/lsp-result.json` and read only the needed part. Limits affect display; applied edits use the complete validated edit set.

## Project context and results

Pass command arguments separately; quote shell paths. Positions are one-based UTF-16 columns. `--symbol NAME#2` selects a repeated token. Missing-file errors suggest `rg --files`; wrong-line errors suggest nearby matching lines.

Run from the project directory; relative paths and `diagnostics --changed` use that context. File queries select configuration from the target file. Use `--cwd PROJECT` when selecting a different project. The CLI and hooks run on Node.js and preserve the caller's working directory.

Use `--json` when checking structured outcomes: `success`, navigation `found`, diagnostics `verified` and `hasErrors`. Verified project errors cause exit 1 while navigation remains available. Unverified diagnostics require investigation; see [setup and readiness](references/setup.md). `inspect` identifies failing sections in `failedSections`. Unsupported capabilities stay explicit. For automation, use `--fields total,shown` (implies `--json`) or nested paths such as `results.definition.locations,results.diagnostics.counts`. Status/error/provider/truncation metadata remains present at the root and selected ancestors. Arrays are selected whole; missing paths appear in `missingFields`. File moves retain `source`, `destination` and `importUpdates` automatically. Field selection only changes output: keep the exit code, inspect `applied` before retrying, and use a focused command to reduce LSP work. Omit `--fields` for ordinary JSON; hooks reject it. Compact text is usually shorter for direct reading.

Field paths follow the command: focused navigation uses `locations`, hover uses `hover`, and signature-help uses `signatures`. `inspect` wraps its five sections in `results.hover`, `results.definition`, `results.references`, `results.symbols` and `results.diagnostics`; call signature-help separately. Missing paths give a bounded hint listing available fields at the closest object. Rename previews use `edits` and `workspaceEdit` (LSP `changes` or `documentChanges`); file moves use `workspaceEdits` entries with `server` and `edit`. The `editPreview` field belongs to selected code actions.

`diagnostics --changed` includes untracked files. Keep logs/helpers outside the project. Active `.codex/lsp.json` changes receive CLI validation in `configurationChecks`; malformed configuration fails. Other files still require matching servers. Hooks use user-global configuration and global executables, ignore project overrides, and never apply edits. Reproduce their scope with `diagnostics --changed --global-config-only --global-bins-only` and an explicit `--cwd`.

## Setup and authorized edits

When discovery is needed, use `status --file PATH`; use `doctor --file PATH` for setup/readiness failures. `setup LANGUAGE...` registers available servers; `--project` writes project scope and takes no path. Missing-server errors provide platform install commands and official documentation. Follow the project's environment/toolchain requirements. Read [setup details](references/setup.md) only for missing servers, dependencies or readiness problems.

`rename`, `rename-file` and `code-actions` preview by default. Add `--apply` when the user requested the change. For code actions, list choices, then use `--query INDEX` to preview affected files, ranges and replacements. `--fields actions,editPreview` keeps that scope plus status and server-command hints. `editPreview.files` contains path strings; `editPreview.edits` contains formatted summary strings. Use `--limit 0 --json` for structured LSP edits in `editPreview.workspaceEdit`. `executesCommand: true` means execution can affect files beyond the preview. Add `--apply` only after checking the selected action. Applied edits report project verification pending: run relevant build/tests and confirm tests actually execute. A server can omit imports/re-exports; use diagnostics and code-actions, then rerun checks. For `rename-file`, read `importUpdates`: `none` or `unavailable` means imports need manual checking; a clean diagnostic result can still miss a broken runtime import. Relative destinations start at the source file directory. If an error says edits were already applied, inspect files before retrying.

Edits validate snapshots/versions and stay within one Git checkout; outside Git they use the language project. Nested repositories and escaping symlinks retain their boundary. Resource operations inside workspace edits are rejected. See [advanced edits and requests](references/advanced.md) when using code-actions, file moves, raw methods or custom server settings.

If the CLI is missing, check Node.js 22.20+, then register with `npm install --global https://github.com/trotsky1997/omp-lsp-codex/releases/latest/download/codex-lsp.tgz`. `npm prefix --global` locates the prefix: add its `bin` to PATH on macOS/Linux, the prefix itself on Windows. Repeat the install command to update. The bundled fallback is `node PLUGIN_ROOT/dist/cli.js COMMAND`; compiled JavaScript is included.
