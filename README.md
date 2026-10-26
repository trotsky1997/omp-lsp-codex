# codex-lsp

A standalone TypeScript LSP CLI, skill and lifecycle hooks for Codex and Claude Code. The CLI and hooks run on Node.js, with no runtime npm dependencies. Compiled JavaScript is included in the npm package and plugin.

The protocol framing, protocol types, client capabilities, symbol matching and text-edit algorithms are extracted from [oh-my-pi](https://github.com/can1357/oh-my-pi). See [NOTICE.md](NOTICE.md) for the source commit and adaptation boundary.

## Install

Install [Node.js](https://nodejs.org/en/download) 22.20 or later, then register the precompiled CLI:

```sh
npm install --global https://github.com/trotsky1997/omp-lsp-codex/releases/latest/download/codex-lsp.tgz
codex-lsp --version
codex-lsp doctor --file path/to/source.ts
```

`npm prefix --global` shows the installation prefix. Add its `bin` directory to `PATH` on macOS/Linux, or the prefix itself on Windows, if the command is unavailable. Each language server and project toolchain must also support your platform.

For a local checkout, run `npm ci`, `npm run build`, then `npm link`. The bundled fallback is `node /absolute/plugin/path/dist/cli.js <command>`.

The release package includes compiled JavaScript and needs no install-time compiler or Git checkout. Update with the same command plus `--force`.

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

Run commands directly from the project directory. Relative paths, setup and changed-file checks use that directory. `--cwd PATH` explicitly selects another project when needed. The Node.js entrypoint and hooks keep the caller's working directory.

Start with `status --file` for quick discovery. `inspect` shares one server session across hover, definition, references, matching file symbols and diagnostics, reducing repeated cold starts. It defaults to 10 results or hover lines per section; `--limit` changes all sections. JSON `results` retains individual errors and unsupported capabilities, with `failedSections` explaining a nonzero exit. Diagnostic errors cause exit 1 with navigation results preserved. Add `--new-name NAME` for a rename preview; inspect always runs read-only.

Use a focused command for one question. `signature-help --file PATH --line N --column N` shows the active call signature and parameter, prioritizing one overload and omitting bulk documentation by default. Put the cursor just after `(` or an argument-separating comma; servers can return no help inside string literals. `--limit 0 --json` retains complete provider signatures and documentation; raw `request` responses stay unchanged. Hover, signature, code-action, symbol and error text have a 6,000-character preview budget when limits are enabled; truncation remains explicit and `--limit 0` retrieves full text. Human navigation/symbol output shares a `Root:` and groups repeated paths; JSON keeps canonical absolute locations. The skill loads common instructions first and links conditional setup/edit details separately.

`--json` emits one JSON object on success and failure. Check the exit code and `success`; navigation also includes `found`, and diagnostics includes `verified`. Empty or incomplete diagnostics fail verification. Existing type errors remain visible while navigation is available. JSON is useful for local field extraction and automated decisions; compact text is usually shorter for direct reading. Preserve the original CLI exit code when processing JSON in a script or pipeline.

`diagnostics --changed` includes untracked files. Run it with `--cwd <project-root>` when starting from a neutral directory, and keep trial logs outside the checkout. Files without a matching available server remain unverified and include setup guidance; Git failures include the command, project directory and bounded stderr detail.

Changed active `.codex/lsp.json` files receive CLI configuration validation and appear separately in `configurationChecks`; they do not require a JSON language server. Malformed configuration still fails the command. Hook scope records project configuration as `ignored` while preserving user-global configuration validation. Other JSON and helper files keep normal diagnostic requirements; an explicit `--file .codex/lsp.json` also requests ordinary language-server diagnostics.

Navigation lists, symbols, code-actions, diagnostics and rename previews show at most 50 results by default; hover shows at most 50 lines. Use `--limit N` for a smaller preview, or `--limit 0 --json > result.json` for complete output. These JSON results include `total`, `shown`, and `truncated`; diagnostics also include full severity `counts`. Diagnostic previews prioritize errors across files, share a 6,000-character message budget and omit oversized provider metadata with `detailsOmitted`; small related locations remain available. Counts, verification and exit codes always cover every diagnostic. `--limit 0` preserves complete provider messages, metadata and order. Truncated rename previews omit the complete edit object and set `workspaceEditOmitted`. `--apply` always processes the full edit set. Raw `request` responses remain complete. Empty document-symbol searches suggest a scoped workspace search; wrong-line symbol errors suggest nearby matching lines before starting a server.

`rename`, `rename-file` and `code-actions` preview changes. Add `--apply` to write them. Code-action previews expose `disabledReason`; disabled actions cannot be applied. When titles are clipped, use the original numeric index with `--query INDEX --apply`. Rename previews include ranges, replacements and the raw workspace edit. Empty symbol renames fail. Edits stay within the Git checkout containing the language project, so cross-package renames work in monorepos. Outside Git, the matched project root is the edit boundary. Nested repositories and symlinks leaving that boundary remain excluded. Ranges, document versions and snapshots are validated before writing; write failures trigger rollback. Resource operations returned inside workspace edits are rejected.

Applied edits report `verification: "pending"` with a hint to run project checks. Language servers can omit imports or re-exports; use diagnostics and code-actions to finish the change, then rerun the relevant build/tests.

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

Pyright/Basedpyright automatically select the matched project's `.venv`, then `venv`, using `bin/python` on macOS/Linux and `Scripts/python.exe` on Windows. Explicit `settings.python.pythonPath` wins. Doctor reports the analysis interpreter separately from the Node.js runtime. Python navigation and edit previews wait for the opened file's first analysis to prevent partial references and empty renames.

Rust semantic queries wait for rust-analyzer's ready workspace status. Diagnostics enable Cargo check for that invocation and wait for compiler diagnostics. Large workspaces may need `--timeout 120` (range 5–300 seconds). Timeouts include the latest server status and a Cargo metadata check. Targeting a file selects its nearest matching manifest; doctor reports that analysis `root`. For standalone or excluded examples, prepare dependencies using that root and use `cargo test --manifest-path path/to/Cargo.toml`; the root workspace may exclude the example. Processes set `RUSTUP_AUTO_INSTALL=0`; install missing toolchains explicitly. For dependency failures, inspect `cargo metadata --locked --format-version 1`; projects with no lockfile need an initial metadata run without `--locked`.

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

SessionStart reports available servers. Stop checks changed files using built-in definitions plus the user's global `~/.codex/lsp.json`, keeping the user's chosen language server and settings. Hooks ignore project configuration, exclude executables resolved inside the project, and never apply edits. `--global-config-only --global-bins-only` selects this scope for a manual check. Stop requests a compact preview of 12 diagnostics, uses the complete error count for its decision and bounds its message text to 6,000 characters. Truncated results include a command for full details. Verified errors ask the agent to continue; unavailable diagnostics include bounded recovery reasons without blocking the turn. Both hooks invoke the same compiled CLI through Node.js.

To test an initial Stop event manually, pipe `{"cwd":"/absolute/project/path"}` into `codex-lsp hook stop`. Omit `stop_hook_active` or set it to `false`. A value of `true` activates the recursion guard and skips the check, allowing an agent to finish after responding to a previous hook block.

Each invocation owns and closes its language-server processes. This extraction excludes OMP's UI, agent runtime, persistent mux and custom linter adapters. Workspace-symbol coverage depends on each server's indexing. Language servers and project dependencies are installed separately.

## Development

```sh
npm ci
npm run check
npm test
```

`npm test` compiles and runs the unit and fault-injection tests with Node's built-in test runner, followed by the CLI checks in `scripts/check.ts`. Tests use local fixtures, without network requests or installed language servers. Node test runner coverage is available with `node --test --experimental-test-coverage ".test-build/tests/*.test.js"` after compiling the tests.

The tests cover CLI parsing and exit codes, configuration and setup, all navigation and edit commands, diagnostics, Codex/Claude hooks and DevDocs. The instrumented LSP fixture records JSON-RPC traffic in temporary files and injects fragmented and reordered responses, late replies, ContentModified, broken streams, crashes, incompatible position encodings and unresponsive shutdowns. Filesystem spies inject write failures and concurrent edits to verify rollback and temporary-file cleanup. Hook tests inject child-process failures and validate completion decisions. DevDocs tests inject offline, corrupt-cache and invalid-catalog responses. Fixtures use temporary workspaces and leave installed server settings unchanged. Real-project acceptance logs are maintained outside the repository.

Diagnostics are verified only when every selected server verifies the file. Changed-file checks fail explicitly on Git errors, more than 200 files, files exceeding 16 MiB, or symlinks outside the workspace. Use `--file` to inspect individual files. Servers must use UTF-16 positions; incompatible negotiated encodings fail before navigation or edits.

Opened documents retain their analyzed content and version. Edits reject conflicting snapshots and stale versions before writing, then synchronize changed documents with the server. Stale diagnostic versions are ignored; malformed version metadata invalidates cached reports. Diagnostics also check the current file against the analyzed content. Failures after completed edits or moves explicitly report that state, and rollback conflicts preserve both files and identify their paths. Inspect the reported file state before retrying a partially completed operation.
