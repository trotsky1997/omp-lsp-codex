# Advanced edits and requests

Read this for selected code actions, file moves, raw methods or custom configuration. [Output shapes](outputs.md) lists JSON field paths and display limits. Ordinary rename uses the shared preview/apply workflow; empty rename edits fail.

## Code actions and file moves

`code-actions --file PATH --line N` selects the whole line and includes initial diagnostics. `--symbol` or `--column` narrows it to a point. List choices, then use `--query INDEX` to resolve and preview one without executing it. A unique title works; ambiguous titles require an original index. Filtering preserves indexes, including when titles are clipped.

Inspect the selected `editPreview` and `executesCommand`. Server commands can affect files beyond the shown edit scope. Add `--apply` for the requested action. `disabledReason` explains unavailable choices; disabled or malformed actions fail before editing. Empty results suggest checking diagnostics, selection and capabilities.

`rename-file --file PATH --new-name PATH` previews the move and server-provided import changes. Relative destinations start at the source file directory; their parent must exist. Existing destinations are protected. The dedicated command manages moving and rollback; resource operations inside workspace edits are rejected.

Read `importUpdates`: `provided`, `none`, or `unavailable`. The latter two require checking and updating affected imports manually. File-only moves remain possible. Applied output marks project verification pending; use relevant build/tests, diagnostics and import actions to finish the change.

Snapshots and document versions must match. If analysis becomes stale, inspect current files before another query. Errors containing `after applying edits`, `Edits applied`, or `File renamed and edits applied` identify completed writes followed by failure. Rollback conflicts identify both paths and preserve both files.

## Raw protocol

`request --method METHOD` requires `--apply` except for listed read-only methods. Raw `textDocument/codeAction` returns suggestions without executing them. Responses remain complete unless `--fields` selects output.

Payload positions use zero-based UTF-16 coordinates. For document requests, `--file` fills a missing `textDocument.uri`; explicit fields win. Partial payloads such as `{"position":{"line":0,"character":5}}` preserve the supplied position. Provide range/diagnostics context for raw code actions.

Raw requests propagate rejected edit callbacks even if the server returns command success. Synchronization errors identify completed writes; inspect before retrying.

## Configuration

The CLI merges built-ins, `~/.codex/lsp.json`, then `<git-root>/.codex/lsp.json`. Outside Git it uses the nearest parent configuration; project setup adds it as a root marker. Server fields include `command`, `args`, `fileTypes`, `rootMarkers`, optional `languageId`, `initOptions` and `settings`.

Hooks load global configuration and executables, ignoring project overrides. Reproduce that scope with `--cwd PROJECT diagnostics --changed --global-config-only --global-bins-only`. Changed active configuration appears in `configurationChecks`; explicit `diagnostics --file .codex/lsp.json` requests JSON-server diagnostics.
