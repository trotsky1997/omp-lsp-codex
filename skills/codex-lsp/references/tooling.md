# Lint and formatting

```sh
codex-lsp lint --changed --budget 3000
codex-lsp lint --file src/example.py --tool ruff --plan /tmp/lint.json
codex-lsp format --changed --check --budget 2000
codex-lsp format --file src/example.ts --tool prettier --plan /tmp/format.json
codex-lsp apply --plan /tmp/format.json --budget 3000
```

Run from the project directory or pass `--cwd PROJECT`. Choose one of `--file` and `--changed`. Changed scope includes untracked files and reports files without a matching tool as skipped. Save plans outside the checkout so logs and plans stay out of changed scope. The parent directory must exist; plans require a new `.json` path.

## Choose a provider

Automatic discovery follows the project's Ruff, ESLint, Biome, Prettier or Cargo configuration and dependencies. Local executables in the project or its ancestors take precedence over PATH. Explicit `--tool NAME` selects a CLI backend; explicit `--server NAME` selects a configured available LSP. The flags are mutually exclusive. Formatting selects one provider per file; conflicting project formatter declarations require an explicit choice. Available LSP formatting/code-action capabilities are checked before a request.

| Language | Lint CLI | Format CLI | Installation and official reference |
| --- | --- | --- | --- |
| Python | Ruff | Ruff | `uv tool install ruff` — [Ruff installation](https://docs.astral.sh/ruff/installation/) |
| JavaScript/TypeScript | ESLint, Biome | Prettier, Biome | `npm install --save-dev eslint prettier @biomejs/biome` — [ESLint](https://eslint.org/docs/latest/use/getting-started), [Prettier](https://prettier.io/docs/install), [Biome](https://biomejs.dev/guides/getting-started/) |
| Rust | Clippy | rustfmt | `rustup component add clippy rustfmt` — [Clippy](https://doc.rust-lang.org/clippy/installation.html), [rustfmt](https://rust-lang.github.io/rustfmt/) |

Install the tools declared by the project, using its package manager, version and lockfile. Missing binaries return installation guidance. CLI commands invoke existing executables and leave installation to the agent. LSP examples are `lint --server ruff` and `format --server biome`; use `setup python` or `setup typescript` for LSP configuration guidance. A semantic server can support formatting without implementing linter fixes.

## Read results and plan changes

`lint` reports normalized diagnostics with one-based UTF-16 locations, exact totals, provider names and `verified`/`hasErrors`. A tool/configuration/transport failure leaves `verified:false` with errors. Existing lint errors produce exit 1; successful repair-plan creation can exit 0 while retaining `hasErrors:true` from its baseline. `ignoredFiles` and the human summary expose skipped-by-tool source; each affected provider has `ignored:true`.

`format` returns a diff without source writes. `--check` returns a compact check and exits 1 when `needsFormatting:true`. Tool failures also exit nonzero; inspect `verified` and `errors`. CLI previews use stdin/stdout or dry-run APIs; LSP formatting returns text edits. `--range START:COL-END:COL` requires an LSP advertising range formatting. CLI backends reject range formatting explicitly.

Biome's LSP waits for configuration readiness before analysis. With the same CLI executable and project configuration, excluded files return quickly with `ignored:true` and `ignoredBy` metadata. Extension settings or a different executable can leave `ignoreStatus:unknown`; check that provider's hint and use the matching CLI for a scope comparison. Valid empty formatting responses still verify formatter idempotence.

`lint --plan` collects safe CLI fixes or pure-text LSP `source.fixAll` actions. Commands, edits to other files and ambiguous fixes remain individual `code-actions` workflows; `fix --server NAME` can review supported multi-file LSP actions. Use `fix --tool NAME --plan PATH.json` as the CLI lint-plan equivalent. Unsafe suggestions stay unapplied. Multiple linters proposing different replacements require selecting a provider.

`saved:false` means no plan was written. Check `skipped` and diagnostics before another action. Saved plans bind source snapshots, configuration hashes and provider identity to a private, machine-local receipt. `apply --plan` validates them before editing and consumes the plan once. Changed source/configuration/providers require a fresh plan; a moved or edited artifact is rejected.

After application, formatter verification reruns the selected formatter and checks idempotence. Lint verification compares new diagnostics with the saved lint baseline. Read `applied`, `applicationState` and `toolVerification`, including after an error or clipped output. `verification:pending` leaves project builds/runtime tests to the agent. A failed verification preserves the actual writes; inspect the files before another edit.

## Keep exploration compact

Use human output for a single question. `--fields checked` keeps verification/failure state while selecting per-file provider summaries; `--budget 2000` bounds complete JSON, including diffs and errors. Request a complete diff with `--limit 0 --json` when reviewing a large saved plan. Counts and clipping flags describe omissions.

For a large changed scope, `--fields diagnosticCount,changedFiles,ignoredFiles,skippedCount --budget 2000` returns compact totals while preserving failure and verification state.

Batch/session rows accept read-only `lint`/`format` queries, `tool` or `server`, and format `check`/`range`. Source file scope goes in each row, for example `{"command":"format","file":"src/example.ts","tool":"prettier","check":true}`. LSP providers share the session's existing lifecycle. Plan creation and applying edits use the ordinary CLI.

Cargo tools use the installed toolchain, project edition and locked/offline dependency state. Clippy can build artifacts during checking. Prepare missing dependencies explicitly and rerun; a Cargo failure remains unverified. CLI tool previews preserve source and Git index; compiler caches and tool-owned caches can be created.
