# Output selection and signatures

Prefer human text for reading; JSON is useful for checking states and composing calls. `--fields` implies JSON, selects comma-separated object paths and preserves their structure. Arrays are selected whole. Missing paths remain in `missingFields`, with a bounded hint listing available fields at the closest object. Selection changes output, preserving the operation's exit code and complete edit set.

| Command | Useful fields |
| --- | --- |
| definition/references/type-definition/implementation | `locations` |
| hover | `hover` |
| signature-help | `signatures,activeParameterLabel` |
| symbols | `symbols` |
| inspect | `results.definition.locations,results.references.locations,results.diagnostics.counts` |
| diagnostics | `counts,checked` |
| rename preview | `edits,workspaceEdit` |
| rename-file preview | `edits,workspaceEdits` |
| selected code action | `actions,editPreview` |

Inspect wraps hover, definition, references, symbols and diagnostics in `results`; signature-help is separate. Rename's raw LSP edit can use `changes` or `documentChanges`. File moves return `{server, edit}` entries. Selected actions' `editPreview.files` and `editPreview.edits` contain path and summary strings; `--limit 0 --json` adds structured `editPreview.workspaceEdit`.

Status, provider, error, write and truncation metadata remain visible at the root and selected ancestors. File moves also retain source, destination and importUpdates. Preserve CLI exit codes in pipelines, inspect `applied` before retrying and keep `verified: false` distinct from a verified empty diagnostic report.

Defaults show 50 results/hover lines, 10 per inspect section and one signature. Text budgets are 6,000 characters for common previews. Check truncated/textTruncated/documentationOmitted/detailsOmitted/errorTruncated/workspaceEditOmitted and hints. Diagnostic previews prioritize errors; counts and verification cover all diagnostics. Limits affect display; applications process complete validated edits. Use `--limit 0 --json > result.json` for omitted details. Raw request results remain complete unless fields are selected.

Signature-help prioritizes the active overload and parameter, omitting bulk documentation. Put the cursor just after the intended call's `(` or an argument-separating comma. Some servers return no help inside string literals. If empty, hover on the callable. JSON signature indices are zero-based; CLI positions are one-based UTF-16 columns. Use complete output for all overloads/documentation. Server type aliases can remain abbreviated.

When hover uses an external DevDocs reference, `provider` identifies it. Check that attribution before treating external documentation as a project signature.
