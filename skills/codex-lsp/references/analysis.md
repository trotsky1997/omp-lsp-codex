# Calls, completions, baselines and impact

## Follow calls

```sh
codex-lsp callers --file src/main.rs --line 20 --symbol parse --depth 2
codex-lsp callees --file src/main.rs --line 20 --symbol parse --depth 2 --json
```

Call hierarchy retains opaque items between prepare/incoming/outgoing requests in one session. Check `supported` before using an empty graph as evidence. Depth defaults to 1 and accepts 1–10. Nodes have response-local IDs and source positions; edges point from caller to callee, with one-based call-site `locations` (`line`, `column`) and `totalLocations`. Each site belongs to the caller node (`nodes.find(node => node.id === edge.from).file`), so paths appear once per node. `totalEdges`/`shownEdges` report graph edge coverage. Cycles reuse nodes. Repeated provider call-site positions are deduplicated with `duplicateLocations` counters. Function-expression bindings can precede the expression range; `selectionBeforeRange` identifies this shape while requests retain the original provider item. Default limits clip displayed nodes/sites without dangling edges. Hard limits are 200 nodes / 1000 edges, with `bounded` and `truncated` marking omissions. Branch errors retain other results and cause exit 1. Static call hierarchy depends on server indexing and dynamic-call inference.

## Discover API candidates

```sh
codex-lsp complete --file src/client.ts --line 25 --column 12 --query open --resolve --json
```

Place the cursor after `.` or within the intended member prefix. `--query` filters candidates for that cursor, ranking exact names first. `--resolve` retrieves detail/documentation using the provider's opaque data. Completion edits and commands remain suggestions; the CLI never applies or executes them. `incomplete` identifies a partial server list. `resolution` describes resolve support and its deadline / 200-item request ceiling. Default text shares a 6,000-character budget. `--limit 0` retains provider items and itemDefaults, including suggested edits as data.

Raw prepare/incoming/outgoing, completion and completionItem/resolve requests need no `--apply`. Position methods fill missing document/position from the CLI anchor. Incoming/outgoing raw calls require the prepared `item` payload; resolve requires the original completion-item payload.

## Compare diagnostics

```sh
codex-lsp diagnostics --file src/main.py --save-baseline ../lsp-before.json --json
# Make the requested edit, then compare the same scope.
codex-lsp diagnostics --baseline ../lsp-before.json --json
```

Choose a writable artifact directory for the platform; keep baselines outside the checkout so changed-file hooks do not analyze them. Capture saves all verified diagnostics regardless of preview limits, including existing errors. It can exit 1 for those errors while saving a valid snapshot; check `baselineSaved`. Writes are atomic and overwrite only a valid existing baseline JSON artifact. Analyzed source and unrelated JSON are protected.

Without `--file`/`--changed`, comparison uses the baseline's file list. Every explicitly selected file needs baseline coverage. Changed server configuration or unverified analysis makes `comparison.verified: false`; no resolved issues are claimed. Foreign workspaces and malformed snapshots fail explicitly. Server configuration is represented by hashes.

Matching uses a multiset of file, trimmed source-line anchor, severity, code, source and message, so blank-line insertion preserves existing issues. Identical errors on identical lines remain count-based. Comparison reports observed differences without attributing their cause. Root `counts`/`hasErrors` still describe all current diagnostics. A verified comparison exits 0 for no new errors; new errors or unverified comparison exit 1. `--fields comparison.counts,comparison.new` focuses output. Runtime behavior still needs project checks.

## Assess changed code

```sh
codex-lsp impact --changed --timeout 120 --json
```

Impact reads staged, unstaged and untracked changes against HEAD, selects declarations intersecting changed hunks and queries current references through shared sessions. A changed method body selects the method rather than its unchanged parent class. Source and Git index stay untouched.

`changedSymbols` contains positions and reference samples; `affectedFiles` records referencing files and response-local `symbolIds`, which map to `changedSymbols[].id`. `candidateTests` gives direct-reference, enclosing Rust/Python test, or weaker filename-convention evidence. Inline test discovery is limited to 20 AST extractions, reported by `inlineTestScan`. Default impact samples are 10 items per section. Repeated reference evidence for one test/symbol is grouped with an occurrence count, and `evidenceSampled` marks capped evidence. The CLI does not run candidate tests.

Deleted files and removed source have separate evidence. `removedContexts` reads HEAD/Git hunks with optional AST extraction. Current LSP cannot establish the full impact of removed APIs. Check `verified`, `bounded`, `errors`, `skipped` and `truncated` before using results as complete. Dynamic calls, excluded targets and generated code need additional review. Limits remain 200 changed files, 16 MiB per source and 200 changed symbols. `--limit 0` removes display limits; operation budgets remain explicit.

Protocol references: [Call hierarchy](https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/language/callHierarchy.md), [Completion](https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/language/completion.md).
