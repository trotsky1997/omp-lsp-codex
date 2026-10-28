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

Automatic discovery follows the project's Ruff, ESLint, Biome, Prettier, Oxlint, Oxfmt or Cargo configuration and dependencies, including Oxc TypeScript configs. Local executables in the project or its ancestors take precedence over PATH. Explicit `--tool NAME` selects a CLI backend; explicit `--server NAME` selects a configured available LSP. The flags are mutually exclusive. Formatting selects one provider per file; conflicting project formatter declarations require an explicit choice. Available LSP formatting/code-action capabilities are checked before a request.

| Language | Lint CLI | Format CLI | Installation and official reference |
| --- | --- | --- | --- |
| Python | Ruff | Ruff | `uv tool install ruff` — [Ruff installation](https://docs.astral.sh/ruff/installation/) |
| JavaScript/TypeScript | ESLint, Biome, Oxlint | Prettier, Biome, Oxfmt | Install the project's selected tools — [ESLint](https://eslint.org/docs/latest/use/getting-started), [Prettier](https://prettier.io/docs/install), [Biome](https://biomejs.dev/guides/getting-started/) |
| Oxc projects | `--tool oxlint` | `--tool oxfmt` | `npm install --save-dev --save-exact oxlint oxfmt` — [Oxlint](https://oxc.rs/docs/guide/usage/linter/quickstart), [Oxfmt](https://oxc.rs/docs/guide/usage/formatter/quickstart) |
| Rust | Clippy | rustfmt | `rustup component add clippy rustfmt` — [Clippy](https://doc.rust-lang.org/clippy/installation.html), [rustfmt](https://rust-lang.github.io/rustfmt/) |

Install the tools declared by the project, using its package manager, version and lockfile. Missing binaries return installation guidance. CLI commands invoke existing executables and leave installation to the agent. LSP examples are `lint --server ruff` and `format --server biome`; use `setup python` or `setup typescript` for LSP configuration guidance. A semantic server can support formatting without implementing linter fixes.

## Read results and plan changes

`lint` reports normalized diagnostics with one-based UTF-16 locations, exact totals, provider names and `verified`/`hasErrors`. A tool/configuration/transport failure leaves `verified:false` with errors. Existing lint errors produce exit 1; successful repair-plan creation can exit 0 while retaining `hasErrors:true` from its baseline. `ignoredFiles` and the human summary expose skipped-by-tool source; each affected provider has `ignored:true`.

`checkedFiles` counts analyzed files, including tool-ignored files. `changedFiles` counts proposed source replacements; plain lint has no replacements until `--plan` requests fixes. Git-ignored files stay outside `--changed`. A tool's lint and format exclusions can differ, such as Ruff's `lint.exclude` versus `format.exclude`.

`format` returns a diff without source writes. `--check` returns a compact check and exits 1 when `needsFormatting:true`. Tool failures also exit nonzero; inspect `verified` and `errors`. CLI previews use stdin/stdout or dry-run APIs; LSP formatting returns text edits. `--range START:COL-END:COL` requires an LSP advertising range formatting. CLI backends reject range formatting explicitly.

Biome's LSP waits for configuration readiness before analysis. With the same CLI executable and project configuration, excluded files return quickly with `ignored:true` and `ignoredBy` metadata. Extension settings or a different executable can leave `ignoreStatus:unknown`; check that provider's hint and use the matching CLI for a scope comparison. Valid empty formatting responses still verify formatter idempotence.

`lint --plan` collects safe CLI fixes or pure-text LSP `source.fixAll` actions. File-wide `fix --plan` also discovers project-declared CLI linters; `fix --tool NAME --plan PATH.json` pins that selection. Explicit `--server`, positions and `--kind quickfix --query INDEX` use LSP action selection, including supported multi-file actions. Commands, edits to other files and ambiguous CLI fixes remain individual `code-actions` workflows. Unsafe suggestions stay unapplied. Multiple linters proposing different replacements require selecting a provider.

Ruff analysis disables configured `fix` and `fix-only`, keeping lint and plan creation read-only even when the project enables automatic fixes. Only reviewed plan application writes source. Check that an injected or existing issue belongs to an enabled, fixable project rule; disabled rules and non-fixable diagnostics can legitimately produce `saved:false`.

Oxlint diagnostics come from its JSON CLI. Fix previews use the same executable's read-only code actions with `fixKind:safe_fix`; no additional server installation or project registration is needed. CLI and fix-provider diagnostics must agree before planning. Suggestions, dangerous actions and server commands stay outside these plans. Prepare the project's JS plugins and `oxlint-tsgolint` when its config enables type-aware rules. Oxc commands run from the Git root to retain config/override paths; native ignore counts distinguish ignored files from clean ones. Oxfmt checks real-file scope and formats stdin, preserving source until application. Oxc config files and dependency lockfiles are bound to each saved plan.

`saved:false` means no plan was written. Check `skipped` and diagnostics before another action. Saved plans bind source snapshots, configuration hashes and provider identity to a private, machine-local receipt. `apply --plan` validates them before editing and consumes the plan once. Finish reviewing and applying one plan before formatting or otherwise changing the same source. Changed source/configuration/providers require a fresh plan and a new artifact path; a moved or edited artifact is rejected.

After application, formatter verification reruns the selected formatter and checks idempotence. Lint verification compares new diagnostics with the saved lint baseline; `comparison` appears once at the top level. Read `applied`, `applicationState` and `toolVerification`, including after an error or clipped output. `verification:pending` leaves project builds/runtime tests to the agent. A failed verification preserves the actual writes; inspect the files before another edit.

## Keep exploration compact

Use human output for a single question. `--fields checked` keeps verification/failure state while selecting per-file provider summaries; `--budget 2000` bounds complete JSON, including diffs and errors. Provider details yield space to plan state and diff previews; `checkedTotal`/`checkedShown` describe budget omissions. Request a complete diff with `--limit 0 --json` when reviewing a large saved plan. Counts and clipping flags describe omissions.

For a large changed scope, `--fields checkedFiles,diagnosticCount,changedFiles,ignoredFiles,skippedCount --budget 1000` returns compact totals while preserving failure and verification state.

Batch/session rows accept read-only `lint`/`format` queries, `tool` or `server`, and format `check`/`range`. Source file scope goes in each row, for example `{"command":"format","file":"src/example.ts","tool":"prettier","check":true}`. LSP providers share the session's existing lifecycle. Plan creation and applying edits use the ordinary CLI.

Cargo tools use the installed toolchain, project edition and locked/offline dependency state. Clippy selects the source's Cargo target, sharing invocations for the same manifest, target and features. `checked[].providers[].cargo` shows target, feature selection and `sourceInput` evidence. Non-entry source files need a compiler diagnostic or a matching Cargo dependency input; unlinked files return unverified. Dependency inputs can include cfg-gated modules, so configure the project's required features before checking those branches. Clippy uses the existing `rust-analyzer` settings `cargo.features` (an array or `"all"`) and `cargo.noDefaultFeatures` from `.codex/lsp.json`, including flattened setting keys. Out-of-tree `#[path]` modules require an LSP query or an explicit owning-target Cargo command. Clippy can build artifacts during checking. Prepare missing dependencies explicitly and rerun; a Cargo failure remains unverified. CLI tool previews preserve source and Git index; compiler caches and tool-owned caches can be created.
