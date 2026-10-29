# Continuous exploration and reviewed repairs

## Reuse locations

```sh
codex-lsp symbols --file src/client.ts --query Client --targets --fields targets
codex-lsp inspect --target TARGET_ID --context --budget 3000
codex-lsp references --target TARGET_ID --page-size 20 --budget 2000
```

`--targets` opts into private cached handles and implies JSON. Each readable location gets `target`; the compact top-level `targets` list has `id`, its result `path`, line/column, and known name/kind/container. It includes `file` for locations outside the requested source, or when no source file was requested. Select `--fields targets` for compact candidates. Handles bind the current workspace, source hash and UTF-16 position. Use the same working directory or `--cwd`. A changed source, missing snapshot or ten-minute expiry requires a fresh query with `--targets`; the CLI never guesses a replacement position. The cache retains up to sixteen snapshots, with 200 files/2,000 locations per snapshot. Virtual or unreadable locations remain explicit anchors and carry omission guidance.

`hover --targets` and `signature-help --targets` include a source `cursor` handle at the actual request position, including automatic argument cursors. Follow it with `inspect --target ID` or another position query; `--fields hover,targets` keeps the answer and handle compact.

Session accepts `targets:true` to produce handles and `target:"ID"` to consume one without `file`, `line`, `column`, `symbol` or `range`. Global `session --stdio --targets --budget 2000` supplies defaults for each row. A row can override those defaults. Keep one request outstanding, read the answer, then choose the next query.

## Watch edits

```sh
codex-lsp diagnostics --file src/client.ts --watch --jsonl --budget 3000
codex-lsp diagnostics --changed --watch --jsonl
```

Watch immediately emits `event:"starting"` while the server initializes, then `event:"snapshot"` for the first diagnostic result. Later `event:"diagnostics"` rows have a `changes` object containing `new`, `resolved`, and `updated` entries with stable IDs. `counts` covers all retained issues; each collection reports its full and shown counts. It stays quiet when nothing changes. File hashes and document versions identify the checked source. Unverified results retain the last verified issues and set `retained`; inspect errors, then correct the source/configuration and allow the next poll to recover. `removedFiles.reason` distinguishes deletion from a file leaving the changed scope. Watch observes disk edits with a 500ms poll and reuses compatible servers. Save files before expecting an update. SIGINT/SIGTERM closes servers and flushes a final `closed` row. Watch accepts file or changed scope and excludes baseline-writing flags.

## Plan repairs

```sh
codex-lsp fix --changed --plan /tmp/codex-lsp-fixes.json --budget 4000
codex-lsp fix --file src/client.ts --kind quickfix --plan /tmp/codex-lsp-fixes.json
codex-lsp fix --file src/client.ts --kind quickfix --query INDEX --plan /tmp/codex-lsp-reviewed-fix.json
codex-lsp apply --plan /tmp/codex-lsp-fixes.json --json
codex-lsp rename --file src/client.ts --symbol Client.open --new-name connect --plan /tmp/rename.json
codex-lsp code-actions --file src/client.ts --range 20:1-25:1 --query INDEX --plan /tmp/action.json
```

`fix` reads diagnostics and collects pure-text code actions. Default kind is `source.fixAll`; automatic quickfix selection requires an unambiguous preferred action. An explicit `--file PATH --query INDEX|TITLE` selects one reviewed pure-text action, including an unpreferred one. Use its returned whole-file range when previewing through `code-actions`; indexes belong to that request. Review the merged diff, actual providers, `skipped`, `complete`, `saved` and `plan`. Commands, disabled actions, ambiguous alternatives and annotated/resource operations require individual `code-actions` review; skipped actions retain their original indexes and selected range. No selected edits means no plan is written. Source files remain untouched while planning.

Plans contain source snapshots and must stay private. They bind the machine, workspace, path and exact bytes through a private receipt; edited, moved, stale and already consumed plans are rejected. Use a fresh output path. `apply --plan` is the explicit write command: it applies that reviewed plan, then compares diagnostics against the planning baseline. `applied`/`applicationState` describes edits; `diagnosticVerification` and `comparison` describe diagnostics. `verification:pending` requires the relevant build/runtime tests. Diagnostic failures preserve applied edits for review. If output rendering fails after an edit, the error still retains `applied`/`applicationState`; inspect files and rerun diagnostics before taking another action. Do not retry an applied plan. The saved plan remains complete when stdout is clipped by a budget.

Rename and selected code actions use the same plan receipts and application path. `code-actions --query INDEX|TITLE --plan PATH.json` requires exactly one reviewed action; a lazy action resolves before saving. Commands, disabled actions, resource operations, stale versions and out-of-workspace edits are rejected. Pure-text edits across matching language-server files are supported. Planning captures verified diagnostics for every edited source. Application uses the saved edits and diagnostic baseline without asking the server to recreate the rename/action.

Verified applications return diagnostic severity counts and checked-file totals alongside one baseline comparison; unverified results retain per-file error details. Run `check` or `format --check` after refactors: a server action can use its own import formatting, which the project's formatter can normalize in a separate reviewed plan.

## Workspace diagnostics

`diagnostics --workspace --file PATH` selects language providers using an anchor; `--server NAME` pins one provider, and plain `--workspace` considers available configured providers. Supported servers answer `workspace/diagnostic` for their configured workspace, including unopened files. `coverage.providers` exposes actual server roots, support, verification and returned file counts. Unsupported providers or malformed/partial/stale results keep aggregate `verified:false`; they cannot replace a baseline or claim resolved issues. Use the returned project-check guidance when a provider lacks this capability. Reports are bounded to 200 local files / 16 MiB; select a narrower provider when needed. Workspace watch is unavailable.

## Compare public syntax and module dependencies

```sh
codex-lsp api-diff --base HEAD --file src/client.ts --budget 4000
codex-lsp api-diff --base main --json
codex-lsp dependencies --file src/client.ts --depth 2 --budget 3000
codex-lsp dependencies --file src/client.ts --reverse --depth 2 --json
```

These commands use ast-grep and Git without starting a language server. API comparison reports added/removed/modified public declarations, signatures, generics and visible members. Body-only edits are ignored. Preserve `evidence:syntax` and `compatibility:unverified`; syntax changes and same-name candidate calls need compiler/project verification. Dependencies parse import/use/mod/re-export evidence, deduplicate cycles and distinguish resolved internal modules, external modules and unresolved paths. Custom aliases, conditional compilation and dynamic loading need project-specific validation. Both commands bound files and traversal, preserve counts and report incomplete coverage.

## Bound any JSON output

`--budget N` applies to every ordinary CLI JSON command and each streaming row, from 512 to 16,777,216 UTF-16 JSON characters, excluding the newline. Field selection runs first. Clipping retains errors, verification, totals, cursor/plan handles and atomic paths/positions; graphs retain valid node/edge endpoints. Complete batch output retains every query's status. If required state cannot fit, select fewer fields or raise the budget. Actual tokenizer savings depend on the model. Hooks keep their own protocol and reject this flag.
