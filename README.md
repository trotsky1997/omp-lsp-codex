# codex-lsp

A standalone TypeScript/Bun LSP CLI, skill and lifecycle hooks for Codex and Claude Code. The CLI and hooks run directly from TypeScript, with no runtime npm dependencies.

The protocol framing, protocol types, client capabilities, symbol matching and text-edit algorithms are extracted from [oh-my-pi](https://github.com/can1357/oh-my-pi). See [NOTICE.md](NOTICE.md) for the source commit and adaptation boundary.

## Install

Install [Bun](https://bun.com/docs/installation), then register the CLI:

```sh
bun add --global git+https://github.com/trotsky1997/omp-lsp-codex.git
codex-lsp --version
codex-lsp doctor --file path/to/source.ts
```

Add the directory printed by `bun pm bin --global` to your `PATH` if the command is unavailable. Bun supports macOS, Linux and Windows. Each language server and project toolchain must also support your platform.

For a local checkout, run `bun install --frozen-lockfile`, then `bun link`. The bundled fallback is `bun /absolute/plugin/path/src/cli.ts <command>`.

Update the CLI with `bun add --global --force git+https://github.com/trotsky1997/omp-lsp-codex.git`.

## Commands

```sh
codex-lsp setup rust python typescript
codex-lsp doctor --file path/to/file.rs --timeout 120
codex-lsp status --json
codex-lsp inspect --file path/to/file.rs --line 20 --symbol parse --json
codex-lsp diagnostics --file path/to/file.rs
codex-lsp diagnostics --changed
codex-lsp definition --file path/to/file.rs --line 20 --symbol parse
codex-lsp references --file path/to/file.rs --line 20 --symbol parse
codex-lsp hover --file path/to/file.rs --line 20 --symbol parse
codex-lsp symbols --file path/to/file.rs --query parse
codex-lsp symbols --workspace --file path/to/file.ts --query parser
codex-lsp rename --file path/to/file.rs --line 20 --symbol parse --new-name parse_value
codex-lsp rename-file --file path/to/file.ts --new-name renamed.ts
codex-lsp code-actions --file path/to/file.ts --line 20 --symbol value
codex-lsp capabilities --file path/to/file.rs
```

Positions are one-based; columns use UTF-16. Use `--symbol name#2` for a repeated token. File paths are resolved from the target project even when the CLI runs elsewhere. `symbols --query` filters document symbols; workspace queries use the matching language servers and return their errors alongside results.

Start with `status --file` for quick discovery. `inspect` shares one server session across hover, definition, references, matching file symbols and diagnostics, reducing repeated cold starts. It defaults to 10 results or hover lines per section; `--limit` changes all sections. JSON `results` retains individual errors and unsupported capabilities, with `failedSections` explaining a nonzero exit. Diagnostic errors cause exit 1 with navigation results preserved. Add `--new-name NAME` for a rename preview; inspect always runs read-only.

`--json` emits one JSON object on success and failure. Check the exit code and `success`; navigation also includes `found`, and diagnostics includes `verified`. Empty or incomplete diagnostics fail verification. Existing type errors remain visible while navigation is available.

Navigation lists, symbols, code-actions, diagnostics and rename previews show at most 50 results by default; hover shows at most 50 lines. Use `--limit N` for a smaller preview, or `--limit 0 --json > result.json` for complete output. These JSON results include `total`, `shown`, and `truncated`; diagnostics also include full severity `counts`. Truncated rename previews omit the complete edit object and set `workspaceEditOmitted`. `--apply` always processes the full edit set. Raw `request` responses remain complete. Empty document-symbol searches suggest a scoped workspace search; wrong-line symbol errors suggest nearby matching lines before starting a server.

`rename`, `rename-file` and `code-actions` preview changes. Add `--apply` to write them. Rename previews include ranges, replacements and the raw workspace edit. Empty symbol renames fail. Edits stay within the server's workspace, validate ranges and overlaps before writing, and roll back written files if an application fails. Resource operations returned inside workspace edits are rejected.

Raw requests require `--apply` unless the method is read-only. `textDocument/codeAction` is read-only and returns suggestions; use `--payload` to supply its range and diagnostics context. Applying a selected code action can execute its server command.

`code-actions --file PATH --line N` selects the whole line and includes initial diagnostics; `--symbol` or `--column` selects a point. `textDocument/signatureHelp` is read-only. Raw document requests fill missing `textDocument.uri` from `--file`, so partial payloads such as `{"position":{"line":0,"character":5}}` work. Payload positions use zero-based LSP coordinates.

## Setup and configuration

`setup LANGUAGE...` resolves and registers installed server executables. Missing servers produce platform-specific install commands and official documentation for the agent to follow. Install the project's declared dependencies and required toolchain, then rerun setup and doctor.

Configuration merges the bundled definitions with `~/.codex/lsp.json` and `<git-root>/.codex/lsp.json`. Outside Git, the nearest parent `.codex/lsp.json` supplies project settings. Run `setup LANGUAGE --project` from the project root; `--project` accepts no path. It enables the selected servers and adds the project config as a root marker, so standalone source directories work too. Settings accept `command`, `args`, `fileTypes`, `rootMarkers`, `languageId`, `initOptions` and `settings`.

```json
{
  "servers": {
    "pyright": {
      "command": "pyright-langserver",
      "settings": {"python": {"pythonPath": "/absolute/project/.venv/bin/python"}}
    }
  }
}
```

Pyright/Basedpyright automatically select the matched project's `.venv`, then `venv`, using `bin/python` on macOS/Linux and `Scripts/python.exe` on Windows. Explicit `settings.python.pythonPath` wins. Doctor reports the analysis interpreter separately from Bun. Python navigation and edit previews wait for the opened file's first analysis to prevent partial references and empty renames.

Rust semantic queries wait for rust-analyzer's ready workspace status. Diagnostics enable Cargo check for that invocation and wait for compiler diagnostics. Large workspaces may need `--timeout 120` (range 5–300 seconds). Processes set `RUSTUP_AUTO_INSTALL=0`; install missing toolchains explicitly. For dependency failures, inspect `cargo metadata --locked --format-version 1`; projects with no lockfile need an initial metadata run without `--locked`.

TypeScript Language Server defaults to `tsserver.useSyntaxServer: "never"` for semantic queries. If it cannot locate TypeScript, check the project's installation or configure `initOptions.tsserver.fallbackPath` to an existing `typescript/lib/tsserver.js`.

Hover uses DevDocs as an external reference when the LSP returns no content. Matching uses exact symbol names and qualified suffixes; responses identify `provider: "devdocs"` and link the matching documentation page. Cached documentation remains usable offline.

## Codex plugin

```sh
codex plugin marketplace add https://github.com/trotsky1997/omp-lsp-codex.git
codex plugin add codex-lsp@codex-lsp-local
```

Review the lifecycle hooks in Codex's `/hooks`. Tcodex uses the same commands with `tcodex` in place of `codex`. To update:

```sh
codex plugin marketplace upgrade codex-lsp-local
codex plugin remove codex-lsp@codex-lsp-local
codex plugin add codex-lsp@codex-lsp-local
```

For a local checkout, use `codex plugin marketplace add /absolute/path/to/omp-lsp-codex`. For CLI-only manual setup, copy `skills/codex-lsp` into your skills directory and merge `hooks/codex-hooks.json` into your hooks configuration, replacing `${PLUGIN_ROOT}` with the checkout path.

## Claude Code plugin

```sh
claude plugin install codex-lsp --marketplace trotsky1997/omp-lsp-codex --scope user
```

The skill is `/codex-lsp:codex-lsp`. Restart Claude Code or run `/reload-plugins` after updating.

## Hooks and scope

SessionStart reports available servers. Stop checks changed files using built-in definitions and globally resolved executables, without running project-local server commands or applying edits. Verified errors ask the agent to continue; unavailable diagnostics are reported without blocking the turn. Both hooks invoke the same TypeScript CLI through Bun.

Each invocation owns and closes its language-server processes. This extraction excludes OMP's UI, agent runtime, persistent mux and custom linter adapters. Workspace-symbol coverage depends on each server's indexing. Language servers and project dependencies are installed separately.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun run test
```

`bun run test` runs the unit and fault-injection tests in `tests/`, followed by the CLI checks in `scripts/check.ts`. Tests use Bun's built-in runner and local fixtures, without network requests or installed language servers. Run `bun test --coverage` for coverage, or `bun test --randomize --seed 42` to check order independence.

The tests cover CLI parsing and exit codes, configuration and setup, all navigation and edit commands, diagnostics, Codex/Claude hooks and DevDocs. The instrumented LSP fixture records JSON-RPC traffic in temporary files and injects fragmented and reordered responses, late replies, ContentModified, broken streams, crashes, incompatible position encodings and unresponsive shutdowns. Filesystem spies inject write failures and concurrent edits to verify rollback and temporary-file cleanup. Hook tests inject child-process failures and validate completion decisions. DevDocs tests inject offline, corrupt-cache and invalid-catalog responses. Fixtures use temporary workspaces and leave installed server settings unchanged. Real-project acceptance logs are maintained outside the repository.

Diagnostics are verified only when every selected server verifies the file. Changed-file checks fail explicitly on Git errors, more than 200 files, files exceeding 16 MiB, or symlinks outside the workspace. Use `--file` to inspect individual files. Servers must use UTF-16 positions; incompatible negotiated encodings fail before navigation or edits.

Opened documents retain their analyzed content and version. Edits reject conflicting snapshots and stale versions before writing, then synchronize changed documents with the server. Stale diagnostic versions are ignored; malformed version metadata invalidates cached reports. Diagnostics also check the current file against the analyzed content. Failures after completed edits or moves explicitly report that state, and rollback conflicts preserve both files and identify their paths. Inspect the reported file state before retrying a partially completed operation.
