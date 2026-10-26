# Advanced edits and requests

Read this for code actions, file moves, raw requests or custom configuration.

## Editing

Rename previews include replacement spans and workspace edits. Bounded previews omit the complete edit object when truncated and set `workspaceEditOmitted`; `--limit 0 --json` retrieves all details. `--apply` always processes the complete edit set. Empty symbol renames fail.

`code-actions --file PATH --line N` selects the whole line and includes initial diagnostics. Narrow it with `--symbol` or `--column`. Choose a returned title with `--query TITLE --apply`; resolving/applying an action may execute its server command. Preview indexes retain their original meaning after filtering. Empty results suggest checking diagnostics, selection and server capabilities.

`rename-file --file PATH --new-name PATH` previews a move and import updates. Add `--apply` for an authorized move. Existing destinations are protected. Workspace-edit resource operations are rejected; the dedicated file-move command manages its own move and rollback.

Opened-file snapshots and document versions must match. If a version is stale or a file changed during analysis, inspect current content and query again. Error text such as `after applying edits`, `Edits applied`, or `File renamed and edits applied` identifies completed changes followed by a failure; inspect before retrying. Rollback conflicts identify both paths and preserve both files.

Language servers can omit import or re-export edits. Applied output says `verification: pending`; use relevant project checks, diagnostics and code-actions to finish the change.

## Raw protocol

Use the focused CLI command for ordinary questions, including `signature-help` for call signatures. Raw `request` preserves full server payloads, including potentially large documentation. It requires `--apply` unless its method is read-only. Raw `textDocument/codeAction` is read-only and never executes suggestions.

```sh
codex-lsp request --method textDocument/signatureHelp --file PATH --line N --column N --json
```

With `--payload`, LSP positions are zero-based UTF-16 offsets. Explicit fields override inferred defaults; the CLI fills a missing target `textDocument.uri`. A partial payload like `{"position":{"line":0,"character":5}}` preserves that position. Supply the desired range/diagnostics context for raw code-action requests.

Native signature-help reports the original active signature/parameter indices and puts the active overload first in bounded previews. Per-signature active parameters take precedence; label ranges use UTF-16 offsets, following [LSP signature help](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#signatureHelp). `--limit 0 --json` preserves complete provider signature information. Hover uses DevDocs references when the server has no hover; check `provider` to distinguish them.

## Configuration

The CLI merges built-ins, `~/.codex/lsp.json`, then `<git-root>/.codex/lsp.json`. Outside Git it uses the nearest parent configuration; project setup adds that configuration as a root marker. Server fields include `command`, `args`, `fileTypes`, `rootMarkers`, optional `languageId`, `initOptions` and `settings`.

Hooks load user-global configuration plus built-ins, resolve globally installed executables and ignore project configuration. They never apply edits. Reproduce their scope with `--cwd PROJECT diagnostics --changed --global-config-only --global-bins-only`. Active configuration changes appear separately in `configurationChecks`; an explicit `diagnostics --file .codex/lsp.json` requests ordinary JSON-server diagnostics.
