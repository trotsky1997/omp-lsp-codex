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

For syntax-aware symbol anchors, automatic signature cursors and declaration snippets, install [ast-grep](https://ast-grep.github.io/guide/quick-start.html): `npm install --global @ast-grep/cli`. This optional executable works on macOS, Linux and Windows. Rust, Python and JavaScript/TypeScript use its built-in grammars. Navigation retains textual matching when ast-grep is absent; automatic signature cursors and snippets report the installation command. Explicit `--column` stays exact.

## Commands

```sh
codex-lsp setup rust python typescript
codex-lsp doctor --file path/to/file.rs --timeout 120
codex-lsp status --json
codex-lsp inspect --file path/to/file.rs --line 20 --symbol parse --json
codex-lsp inspect --file path/to/file.rs --line 20 --symbol parse --context --json
codex-lsp batch --input queries.jsonl --json
codex-lsp diagnostics --file path/to/file.rs
codex-lsp diagnostics --changed
codex-lsp diagnostics --workspace --file path/to/file.ts
codex-lsp check --changed --budget 2000
codex-lsp inspect --file path/to/file.ts --symbol Parser.parse --context --budget 3000
codex-lsp callers --file path/to/file.rs --line 20 --symbol parse --depth 2
codex-lsp callees --file path/to/file.rs --line 20 --symbol parse --depth 2
codex-lsp complete --file path/to/file.ts --line 20 --column 12 --query open --resolve
codex-lsp diagnostics --file path/to/file.py --save-baseline ../lsp-before.json
codex-lsp diagnostics --baseline ../lsp-before.json
codex-lsp impact --changed --timeout 120 --json
codex-lsp definition --file path/to/file.rs --line 20 --symbol parse
codex-lsp references --file path/to/file.rs --line 20 --symbol parse
codex-lsp hover --file path/to/file.rs --line 20 --symbol parse
codex-lsp signature-help --file path/to/file.rs --line 30 --symbol parse
codex-lsp snippet --file path/to/file.rs --line 20 --symbol parse
codex-lsp symbols --file path/to/file.rs --query parse
codex-lsp symbols --workspace --file path/to/file.ts --query parser
codex-lsp rename --file path/to/file.rs --line 20 --symbol parse --new-name parse_value
codex-lsp rename-file --file path/to/file.ts --new-name renamed.ts
codex-lsp code-actions --file path/to/file.ts --line 20 --symbol value
codex-lsp capabilities --file path/to/file.rs
```

Positions are one-based; columns use UTF-16. Invalid anchors report valid line/column ranges; CRLF terminators are excluded from columns, and surrogate-pair errors suggest adjacent valid positions. Use `--symbol name#2` for a repeated token. File paths are resolved from the target project even when the CLI runs elsewhere. `symbols --query` filters document symbols; workspace queries use the matching language servers and return their errors alongside results.

With ast-grep installed, `--symbol` selects code identifiers and excludes same-name comments/string contents. Wrong-line hints list nearby code matches. `signature-help --symbol NAME` selects that call's argument list, including generics and nested calls; choose a call site rather than its declaration. Without `--symbol`, automatic signature selection requires one call on the line. Use `--column` inside a call's arguments to inspect a later active parameter.

`snippet` extracts the smallest enclosing declaration without starting a language server. Pass its declaration line and name, or a position inside its body. JSON includes the absolute `file`, one-based UTF-16 `range` (exclusive end), `provider: "ast-grep"` and `snippet`. Default previews show up to 50 lines and 6,000 characters with explicit truncation; `--limit 0` returns the full declaration. This is a syntax view of the source; type inference, references and rename use LSP.

Snippets retain Rust outer attributes and Python decorators. For discovery, `symbols --query NAME --limit 5` ranks exact case/name matches first and retains full counts. Signature errors suggest nearby call names with their receivers. An empty server signature response reports the selected `cursor` in JSON; automatic-cursor hints point to hover/definition for type information.

Run commands directly from the project directory. Relative paths, setup and changed-file checks use that directory. `--cwd PATH` explicitly selects another project when needed. The Node.js entrypoint and hooks keep the caller's working directory.

JavaScript module files (`.mjs`, `.cjs`) and TypeScript module files (`.mts`, `.cts`) are discovered and sent to language servers with their standard JavaScript/TypeScript language IDs.

Language-specific skills: [shared CLI](skills/codex-lsp/SKILL.md), [Rust](skills/codex-lsp-rust/SKILL.md), [Python](skills/codex-lsp-python/SKILL.md), and [TypeScript/JavaScript](skills/codex-lsp-typescript/SKILL.md). The main skill routes to the active language; output schemas and advanced setup/edit details load on demand.

Start with `status --file` for quick discovery. `inspect` shares one server session across hover, definition, references, matching file symbols and diagnostics, reducing repeated cold starts. It defaults to 10 results or hover lines per section; `--limit` changes all sections. JSON `results` retains individual errors and unsupported capabilities, with `failedSections` explaining a nonzero exit. Diagnostic errors cause exit 1 with navigation results preserved. Add `--new-name NAME` for a rename preview; inspect always runs read-only.

Add `inspect --context` when you need source bodies alongside navigation. It includes type-definition results and `results.context.snippets` with enclosing source, definitions, types and sampled references. Repeated enclosing declarations merge their `roles`. Default context follows up to three locations per section, returns up to `--limit` distinct snippets and shares a 6,000-character code budget. Each snippet has its file, one-based range, provider and character counts; `omittedLocations`, `truncated` and hints describe sampling/clipping. With ast-grep unavailable or a declaration unresolved, context returns nearby lines with `provider: "lines"` and a hint. Unreadable or concurrently changed files fail the context section while preserving the other results. `--limit 0 --json` retrieves complete snippets and follows all returned locations.

### Interactive exploration and bounded output

```sh
codex-lsp session --stdio
codex-lsp references --file src/client.ts --line 20 --symbol open --page-size 20 --json
codex-lsp next --cursor CURSOR_FROM_nextCursor --json
codex-lsp inspect --file src/client.ts --line 20 --context --budget 3000
codex-lsp code-actions --file src/client.ts --range 20:1-35:1 --kind refactor.extract
codex-lsp supertypes --file src/client.ts --line 20 --symbol Client --depth 2
codex-lsp subtypes --file src/client.ts --line 20 --symbol Client --depth 2
codex-lsp inlay-hints --file src/client.ts --range 20:1-60:1 --resolve
```

Session accepts one JSONL query and emits its result before waiting for the next, preserving compatible language servers. Choose each question from the previous reply. Opened files refresh from disk with versioned notifications; source changes during a query discard stale results. Responses retain query IDs, codes and measured elapsedMs. Send `{"command":"close"}` or close stdin to release servers. Source-writing actions use the ordinary CLI with an explicit apply.

References pages share a private ten-minute snapshot, including across CLI invocations. `nextCursor` survives field selection; source/reference changes invalidate continuation. `--budget` implies JSON and bounds the complete inspect response in UTF-16 characters, preserving verification/errors/counts and marking clipping. Batch and session support the matching row fields. Read [sessions, pages and budgets](skills/codex-lsp/references/sessions.md) for schema, limits and recovery.

Multiline code actions select an end-exclusive one-based UTF-16 range and filter action kinds while retaining original indexes. Preview a selected action before a requested apply. Optional TypeScript interactive rename UI is acknowledged without changing the generated name; `renameTarget` gives an optional follow-up anchor. Type hierarchy and inlay hint/resolve support follow server capabilities; unsupported results identify the executable and offer capability-filtered alternatives. Read [analysis](skills/codex-lsp/references/analysis.md) and [advanced edits](skills/codex-lsp/references/advanced.md).

### Continuous work and reviewed repairs

```sh
codex-lsp symbols --file src/client.ts --query Client --targets --fields targets
codex-lsp inspect --target TARGET_ID --context --budget 3000
codex-lsp diagnostics --file src/client.ts --watch --jsonl --budget 3000
codex-lsp fix --changed --plan /tmp/codex-lsp-fixes.json --budget 4000
codex-lsp fix --changed --format --plan /tmp/codex-lsp-combined.json --budget 3000
codex-lsp lint --changed --plan /tmp/codex-lsp-lint.json --budget 3000
codex-lsp format --changed --check --budget 2000
codex-lsp format --changed --plan /tmp/codex-lsp-format.json --budget 3000
codex-lsp fix --file src/client.ts --kind quickfix --query INDEX --plan /tmp/codex-lsp-reviewed-fix.json
codex-lsp apply --plan /tmp/codex-lsp-fixes.json --json
codex-lsp api-diff --base HEAD --file src/client.ts --budget 4000
codex-lsp dependencies --file src/client.ts --reverse --depth 2 --budget 3000
```

Location handles are opt-in, private and bound to the workspace and current source hash. Reuse them across CLI calls or session rows; changed or expired source requires a fresh query. `--fields targets` gives compact IDs. Watch emits `starting`, the initial `snapshot`, then `diagnostics` events with new/resolved/updated issues, and a final `closed` row on SIGINT/SIGTERM. Unverified analysis retains the last verified issues; unchanged output stays quiet.

`fix` saves a reviewable pure-text plan while leaving source unchanged. It defaults to `source.fixAll` and discovers project-declared CLI linters for file-wide fixes. Explicit LSP/position selection stays available; automatic quickfixes require one preferred action, while explicit `--file --query` selects a reviewed original index/title. Commands, ambiguous alternatives and resource operations remain individual code-action workflows. `apply --plan` checks the private receipt and source snapshots, applies the saved edit once, and reports a diagnostic baseline comparison. Project build/runtime verification remains pending. Output failures after editing preserve `applied` and application state; inspect files before another action.

`lint` and `format` select project-configured CLI tools or LSP providers. Ruff, ESLint, Biome, Oxlint and Clippy provide lint diagnostics/safe repairs; Ruff, Prettier, Biome, Oxfmt and rustfmt provide formatting. Choose `--tool NAME` or `--server NAME` to pin a backend. Formatting uses one provider per file and previews a diff; `--check` returns a concise non-writing check. Save changes with `--plan PATH.json`, review, then `apply --plan PATH.json`. Application validates source, configuration and provider state, then verifies formatter idempotence or compares lint diagnostics. Read [lint and formatting](skills/codex-lsp/references/tooling.md) for installation, ignore rules, safe fixes, range formatting and batch/session use.

`fix --format --plan PATH.json` composes safe lint repairs and formatting in memory, saves one diff and verifies both after application. `--tool`/`--server` selects the linter; `--formatter NAME` optionally selects a CLI formatter. `lint --save-baseline before.json` captures standalone lint results; `lint --baseline before.json` rechecks that saved file scope and reports new/resolved/existing issues. Baselines also bind tool configuration. Keep baseline capture/comparison separate from plan creation.

`rename --plan PATH.json` and `code-actions --query INDEX --plan PATH.json` persist reviewed pure-text edits for the existing `apply` command. Command actions and resource operations require their individual workflows. `check --changed` or `check --file PATH` summarizes diagnostics, lint and format checks, shares compatible servers and preserves each check's failure state. Run the named command for detailed issues.

Omit `--line` with a declaration `--symbol NAME` or a qualified name such as `Parser.parse` (`Parser::parse` also works for Rust). ast-grep resolves a unique declaration; ambiguous names return bounded candidates before starting LSP. Explicit line/column anchors retain their exact behavior. Signature help continues to use call-site positions. `diagnostics --workspace [--file PATH | --server NAME]` requests supported server workspace reports, including unopened files. Its `coverage` lists selected providers and their supported/verified state; unsupported providers keep the aggregate unverified and return native-check guidance. Workspace reports follow server configuration and are limited to 200 local files / 16 MiB. Workspace watch is unavailable.

API diff and dependency graphs use ast-grep/Git for Rust, Python and TypeScript/JavaScript. API output retains `evidence:syntax`, `compatibility:unverified`, and separate `surfaceComplete`/`callsComplete`. Dependencies follow relative imports and re-exports, distinguish external/unresolved modules and bound reverse analysis to relevant AST candidates. Graphs remain partial when file/node/time limits are reached; aliases, cfg and dynamic loading need project checks.

`--budget` now applies to all ordinary JSON commands, including graphs, completions, batch and streaming rows. It preserves status/counts and valid graph endpoints; inspect its clipping metadata. When required state cannot fit, select fewer fields or raise the budget. Read [continuous exploration and repairs](skills/codex-lsp/references/workflows.md) for schemas, cache lifetime and limits.

### Calls, completions, baselines and impact

Call graphs store each file on its node. Edge `locations` contain `line`/`column`; resolve their file through the caller node (`nodes.find(node => node.id === edge.from).file`). `totalEdges` and `shownEdges` expose edge sampling alongside node counts.

`callers` / `callees --depth 2` traverse the server call hierarchy in one session, keeping graph IDs, cycles and call-site evidence. `complete --query NAME --resolve` filters and resolves candidates at the specified cursor without inserting text or executing completion commands. Both expose capability/partial-result state and support batch rows.

`diagnostics --save-baseline PATH.json` atomically captures complete verified diagnostics. `diagnostics --baseline PATH.json` compares the same file scope, retaining moved-line issues and reporting new/resolved/existing counts. Existing errors remain visible; a verified comparison exits 1 only for new errors. Configuration/scope changes remain unverified. Keep baseline artifacts outside the checkout.

`impact --changed` reads staged/unstaged/untracked Git changes, selects changed declarations and follows references. Candidate tests carry direct-reference, enclosing-test or filename-convention evidence. Deleted APIs and incomplete queries remain explicit; no tests run automatically. See [analysis workflows](skills/codex-lsp/references/analysis.md) for schemas, safety and operation budgets.

### Batch queries

For several questions or files, put one read-only query per line in a JSONL file:

```jsonl
{"command":"hover","file":"src/main.ts","line":20,"symbol":"parse","fields":"hover"}
{"command":"definition","file":"src/main.ts","line":20,"symbol":"parse","fields":"locations"}
{"command":"inspect","file":"src/parser.ts","line":12,"symbol":"parse","context":true,"fields":"results.context.snippets,results.diagnostics.counts"}
```

Run `codex-lsp batch --input queries.jsonl --json`, or pipe JSONL to `codex-lsp batch --input - --json`. Input paths and query file paths use the caller's working directory or `--cwd`; each row can select another `cwd` relative to that directory. Every row requires `command` and `file`; optional fields are `cwd`, `line`, `column`, `symbol`, `query`, `limit`, `fields`, `workspace` (symbols only), `context` (inspect only), `depth` (callers/callees), `resolve` (complete) and `baseline` (diagnostics). Coordinates are one-based UTF-16. Supported commands are hover, definition, references, type-definition, implementation, signature-help, symbols, diagnostics, snippet and inspect. Batch is read-only and rejects edit commands, raw requests and unrecognized fields before starting any server.

Queries run in input order and share compatible servers and opened documents. Up to eight servers remain active; least recently used sessions close when more are needed. A batch containing inspect/diagnostics enables Rust compiler checks at startup. Healthy sessions survive a single request error or timeout; broken connections restart before the next query. Concurrent changes to an opened file fail that query and discard its session. All sessions close on completion or interruption; batch has no background daemon.

JSON emits one object containing `success`, `applied: false`, `total`, `succeeded`, `failed`, `failedQueries` and `results`. Every row preserves `index` (zero-based), `inputLine`, `command`, `file`, source `line`, optional `symbol`, `code` and command result fields. Exit 0 means every query succeeded; exit 1 retains all results when any query fails; exit 2 reports invalid input. Input is limited to 200 queries and 16 MiB. Blank lines are ignored. Batch defaults to 10 results per query; `--limit` changes the inherited limit, and a row's `limit` overrides it. Batch continues through all rows and never truncates the result list. `failedQueries` maps each failed result index to its input line, code and failing inspect sections, so partial results remain easy to use.

A batch row can set `fields` to comma-separated object paths, for example `"fields":"results.context.snippets,results.diagnostics.counts"`. Selection applies to that row and retains status, errors and failing sections; it reduces emitted output while diagnostics and exit codes still cover the complete analysis. Top-level `--fields` selects the outer batch object; select its `results` array as a whole.

Use a focused command for one question. `signature-help --file PATH --line N --column N` shows the active call signature and parameter, prioritizing one overload and omitting bulk documentation by default. Put the cursor just after `(` or an argument-separating comma; servers can return no help inside string literals. `--limit 0 --json` retains complete provider signatures and documentation; raw `request` responses stay unchanged. Hover, signature, code-action, symbol and error text have a 6,000-character preview budget when limits are enabled; truncation remains explicit and `--limit 0` retrieves full text. Human navigation/symbol output shares a `Root:` and groups repeated paths; JSON keeps canonical absolute locations. The main skill loads shared essentials and routes to separate Rust, Python and TypeScript/JavaScript skills. Only the active language and task-specific output/setup/edit references need loading.

`--json` emits one JSON object on success and failure. Check the exit code and `success`; navigation also includes `found`, and diagnostics includes `verified`. Missing, malformed, stale or incomplete diagnostic reports fail verification. A valid empty report is accepted for the configured analysis scope; runtime and build checks complete change verification. Existing type errors remain visible while navigation is available. Use `--fields total,shown` to emit selected fields directly (`--fields` implies `--json`), or `--json --fields results.definition.locations,results.diagnostics.counts` for nested inspect results. Object paths retain their structure; arrays are selected whole. Status, error, capability/provider and truncation metadata remain present at the root and selected ancestors. File moves also retain `source`, `destination` and `importUpdates` at the root. Missing paths appear in `missingFields` (with a bounded hint listing nearby valid paths) without changing the operation's exit code. Selection affects emitted JSON only: LSP queries, validation and applied edits remain complete. Hooks use their own protocol and reject `--fields`. Omit the flag for the ordinary JSON result. Preserve the original CLI exit code when processing JSON in a script or pipeline.

`diagnostics --changed` includes untracked files. Run it with `--cwd <project-root>` when starting from a neutral directory, and keep trial logs outside the checkout. Files without a matching available server remain unverified and include setup guidance; Git failures include the command, project directory and bounded stderr detail.

Changed active `.codex/lsp.json` files receive CLI configuration validation and appear separately in `configurationChecks`; they do not require a JSON language server. Malformed configuration still fails the command. Hook scope records project configuration as `ignored` while preserving user-global configuration validation. Other JSON and helper files keep normal diagnostic requirements; an explicit `--file .codex/lsp.json` also requests ordinary language-server diagnostics.

Navigation lists, symbols, code-actions, diagnostics and rename previews show at most 50 results by default; hover shows at most 50 lines. Use `--limit N` for a smaller preview, or `--limit 0 --json > result.json` for complete output. These JSON results include `total`, `shown`, and `truncated`; diagnostics also include full severity `counts`. Diagnostic previews prioritize errors across files, share a 6,000-character message budget and omit oversized provider metadata with `detailsOmitted`; small related locations remain available. Counts, verification and exit codes always cover every diagnostic. `--limit 0` preserves complete provider messages, metadata and order. Truncated rename previews omit the complete edit object and set `workspaceEditOmitted`. `--apply` always processes the full edit set. Raw `request` responses remain complete by default; `--fields` explicitly selects emitted JSON. Empty document-symbol searches suggest a scoped workspace search; wrong-line symbol errors suggest nearby matching lines before starting a server.

`rename`, `rename-file` and `code-actions` preview changes. Add `--apply` to write them. Code-action lists expose `disabledReason`; disabled actions cannot be applied. Use `--query INDEX` to resolve and preview the selected action's affected files, ranges and replacements before adding `--apply`. `--fields actions,editPreview` retains this scope; `executesCommand` flags server commands whose effects can extend beyond the preview. `--limit 0 --json` includes complete workspace edits. Ambiguous titles require the original numeric index. Rename previews include ranges and replacements with a shared 6,000-character text budget. Oversized replacement previews are explicit and omit the complete workspace edit; `--limit 0 --json` retrieves complete edits. Applied edits use the full validated content, subject to the 16 MiB per-file limit. Empty symbol renames fail. Edits stay within the Git checkout containing the language project, so cross-package renames work in monorepos. Outside Git, the matched project root is the edit boundary. Nested repositories and symlinks leaving that boundary remain excluded. Ranges, document versions and snapshots are validated before writing; write failures trigger rollback. Resource operations returned inside workspace edits are rejected.

Relative `rename-file --new-name` destinations resolve from the source file directory; absolute paths select another directory. The parent directory must exist. `importUpdates` is `provided`, `none`, or `unavailable`; no returned edits produce an explicit import-check hint. A file-only move can require manual import updates; run relevant project checks even when diagnostics are clean.

Raw requests propagate failed server edit callbacks even when the server returns command success. Synchronization failures identify completed writes.

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

Each invocation owns and closes its language-server processes. This extraction excludes OMP's UI, agent runtime and persistent mux. Workspace-symbol coverage depends on each server's indexing. Language servers, linter/formatter executables and project dependencies are installed separately.

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
