# Output selection and signatures

Prefer human text for reading; JSON is useful for checking states and composing calls. `--fields` implies JSON, selects comma-separated object paths and preserves their structure. Arrays are selected whole. Missing paths remain in `missingFields`, with a bounded hint listing available fields at the closest object. Selection changes output, preserving the operation's exit code and complete edit set.

| Command | Useful fields |
| --- | --- |
| definition/references/type-definition/implementation | `locations` |
| hover | `hover` |
| callers/callees | `nodes,edges,roots` |
| complete | `items,resolution` |
| diagnostics --baseline | `comparison.counts,comparison.new` |
| impact | `counts,changedSymbols,candidateTests` |
| snippet | `snippet,range` |
| signature-help | `signatures,activeParameterLabel` |
| symbols | `symbols` |
| inspect | `results.definition.locations,results.references.locations,results.diagnostics.counts` |
| inspect --context | `results.context.snippets` |
| batch | `results` (select the complete array) |
| diagnostics | `counts,checked` |
| rename preview | `edits,workspaceEdit` |
| rename-file preview | `edits,workspaceEdits` |
| selected code action | `actions,editPreview` |

Inspect wraps hover, definition, references, symbols and diagnostics in `results`; signature-help is separate. Rename's raw LSP edit can use `changes` or `documentChanges`. File moves return `{server, edit}` entries. Selected actions' `editPreview.files` and `editPreview.edits` contain path and summary strings; `--limit 0 --json` adds structured `editPreview.workspaceEdit`.

Status, provider, error, write and truncation metadata remain visible at the root and selected ancestors. File moves also retain source, destination and importUpdates. Preserve CLI exit codes in pipelines, inspect `applied` before retrying and keep `verified: false` distinct from a verified empty diagnostic report.

Defaults show 50 results/hover lines, 10 per inspect section and one signature. Text budgets are 6,000 characters for common previews. Check truncated/textTruncated/documentationOmitted/detailsOmitted/errorTruncated/workspaceEditOmitted and hints. Diagnostic previews prioritize errors; counts and verification cover all diagnostics. Limits affect display; applications process complete validated edits. Use `--limit 0 --json > result.json` for omitted details. Raw request results remain complete unless fields are selected.

Signature-help prioritizes the active overload and parameter, omitting bulk documentation. Prefer `--symbol NAME` at the call site: ast-grep positions the cursor just after that call's `(`. Use an explicit `--column` after a later argument-separating comma to select that parameter. Some servers return no help inside string literals. If empty, hover on the callable. JSON signature indices are zero-based; CLI positions are one-based UTF-16 columns. Use complete output for all overloads/documentation. Server type aliases can remain abbreviated.

Empty signature results include `cursor: {line, column, automatic}`. With an automatic cursor the hint confirms the position and the server's empty response; inspect the callable's type or declaration next. Symbol discovery ranks exact case/name matches before partial matches, keeping complete totals and explicit truncation.

Snippet output includes `provider: "ast-grep"`, absolute `file`, one-based UTF-16 `range` with exclusive end, `snippet`, line totals and character counts. Truncation describes only the returned preview; `--limit 0` retrieves the complete enclosing source declaration. It does not start LSP or expand macros.

When hover uses an external DevDocs reference, `provider` identifies it. Check that attribution before treating external documentation as a project signature.

## Batch and source context

`batch --input PATH|-` reads JSONL and emits one result object. Each row requires `command` and `file`; optional fields are `cwd`, `line`, `column`, `symbol`, `query`, `limit`, `fields`, `workspace`, `context`, `depth`, `resolve` and `baseline`. `workspace` applies to symbols; `context` applies to inspect. Commands also include callers, callees and complete; depth, resolve and diagnostic baseline are available as row fields. Baseline capture and workspace-wide impact run outside batch. Coordinates are one-based UTF-16. `cwd` is relative to the batch invocation directory, and query files are relative to their selected cwd. The input schema is validated before servers start; edits, raw requests, unknown fields and nested batches are rejected.

Batch `results` is an ordered array. Rows retain zero-based `index`, physical `inputLine`, `command`, `file`, source `line`, optional `symbol`, `code` and the command's own fields. Check each row's `success`, `found` or diagnostic `verified`; top-level `failed` counts nonzero row codes, with `failedQueries` mapping each zero-based result `index` to its one-based `inputLine`, `code` and optional `failedSections`. A failure hint confirms that successful rows remain available. Exit 1 preserves successes beside failures; exit 2 reports invalid input. A batch accepts at most 200 queries / 16 MiB. Default limit is 10 per query; a row limit overrides the CLI limit, and limit 0 requests full output. Servers are shared by configuration/root and close when the batch ends; up to eight remain active. Mixed Rust inspection/diagnostics enables compiler checks from startup. File changes invalidate a shared document and fail that query; retry with a current anchor.

`inspect --context` adds type-definition and `results.context`. Its `snippets` include `file`, one-based UTF-16 `range` (exclusive end), `roles`, `provider`, `snippet` and `characters: {total, shown}`. Roles merge when source/definition/type/reference point inside the same extracted declaration. Default context samples up to three locations per navigation section and at most `--limit` distinct snippets, sharing 6,000 code characters. `omittedLocations` counts locations skipped by sampling/limits; `truncated` and `textTruncated` flag omissions. `--limit 0 --json` follows all returned locations and returns full bodies. AST failures or unsupported syntax fall back to nearby lines with a hint; unreadable files or concurrent changes remain explicit errors and make the context section fail.

A batch row selects its command's own output: hover uses `"fields":"hover"`, snippet uses `"fields":"snippet,range"`, and inspect with context uses `"fields":"results.context.snippets,results.diagnostics.counts"`. Selection applies to that row and retains status, errors and failing sections; it reduces emitted output while diagnostics and exit codes still cover the complete analysis. Top-level `--fields` selects the outer batch object; select its `results` array as a whole.
