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

`signature-help` shows the active overload and parameter without bulk documentation. Put the cursor inside a call's arguments. It defaults to one signature, prioritizing the active overload; JSON indices are zero-based. Use `--limit 0 --json` for complete signatures, parameters and documentation. Server-side type abbreviations can remain in a complete response. Raw `request` responses remain complete and can be much larger.

Default display limits: 50 results/hover lines, 10 per `inspect` section. Hover and signature text also have character budgets. Check `truncated`, `textTruncated`, `documentationOmitted` and hints; a short hover can omit a return type. Increase the line/result limit when useful, or save complete output with `--limit 0 --json > /tmp/lsp-result.json` and read only the needed part. Limits affect display; applied edits use the complete validated edit set.

## Project context and results

Pass command arguments separately; quote shell paths. Positions are one-based UTF-16 columns. `--symbol NAME#2` selects a repeated token. Missing-file errors suggest `rg --files`; wrong-line errors suggest nearby matching lines.

File queries select configuration from the target file. For commands without `--file`, pass `--cwd PROJECT`, especially `codex-lsp --cwd PROJECT diagnostics --changed`. Run from a neutral directory or the installed plugin directory. If Bun stalls before any CLI output on macOS, use `bun --cwd PLUGIN_ROOT PLUGIN_ROOT/src/cli.ts --cwd PROJECT COMMAND`; increasing the LSP timeout leaves that startup problem unresolved.

Use `--json` when checking structured outcomes: `success`, navigation `found`, diagnostics `verified` and `hasErrors`. Verified project errors cause exit 1 while navigation remains available. Unverified diagnostics require investigation; see [setup and readiness](references/setup.md). `inspect` identifies failing sections in `failedSections`. Unsupported capabilities stay explicit.

`diagnostics --changed` includes untracked files. Keep logs/helpers outside the project. Active `.codex/lsp.json` changes receive CLI validation in `configurationChecks`; malformed configuration fails. Other files still require matching servers. Hooks use user-global configuration and global executables, ignore project overrides, and never apply edits. Reproduce their scope with `diagnostics --changed --global-config-only --global-bins-only` and an explicit `--cwd`.

## Setup and authorized edits

When discovery is needed, use `status --file PATH`; use `doctor --file PATH` for setup/readiness failures. `setup LANGUAGE...` registers available servers; `--project` writes project scope and takes no path. Missing-server errors provide platform install commands and official documentation. Follow the project's environment/toolchain requirements. Read [setup details](references/setup.md) only for missing servers, dependencies or readiness problems.

`rename`, `rename-file` and `code-actions` preview by default. Add `--apply` when the user requested the change. Applied edits report project verification pending: run relevant build/tests and confirm tests actually execute. A server can omit imports/re-exports; use diagnostics and code-actions, then rerun checks. If an error says edits were already applied, inspect files before retrying.

Edits validate snapshots/versions and stay within one Git checkout; outside Git they use the language project. Nested repositories and escaping symlinks retain their boundary. Resource operations inside workspace edits are rejected. See [advanced edits and requests](references/advanced.md) when using code-actions, file moves, raw methods or custom server settings.

If the CLI is missing, check Bun, then register with `bun add --global git+https://github.com/trotsky1997/omp-lsp-codex.git`. `bun pm bin --global` locates its PATH directory. Update with the same install command plus `--force`. The bundled entry is `PLUGIN_ROOT/src/cli.ts`, runnable with Bun as shown above.
