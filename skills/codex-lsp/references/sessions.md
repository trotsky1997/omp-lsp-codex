# Interactive exploration and bounded output

## Keep a server warm

Run `codex-lsp session --stdio` from the project directory; use `--timeout 120` for large cold Rust workspaces. Write one JSON object and a newline to stdin, read one JSON reply, then choose the next question from that result. Replies arrive while stdin stays open. With terminal tools, resume the same process to send the next row; with a subprocess driver, flush writes and read stdout line by line.

```jsonl
{"id":"api","command":"hover","file":"src/client.ts","line":20,"symbol":"open"}
{"id":"body","command":"snippet","file":"src/client.ts","line":20,"symbol":"open"}
{"id":"context","command":"inspect","file":"src/client.ts","line":20,"context":true,"budget":3000}
{"command":"close"}
```

Rows use the batch schema, with optional string/integer `id`. Each reply includes `id`, physical `inputLine`, query `code`, measured `elapsedMs` and the command's own fields. Timing covers query preparation, refresh and analysis; tool wait windows can include idle time. A PTY can echo input; response records carry `code` and `inputLine`. Pipe stdout to a project-external log with `tee` to preserve replies. Inspect keeps nested `results`; hover and snippet use their own top-level fields. Malformed or failed queries return errors while later rows remain available. The process exits 1 if any query failed, 0 otherwise. Close stdin or send `{"command":"close"}` to release all servers. Source-writing rows, raw requests and nested sessions/batches are excluded; run an explicitly requested apply through the ordinary CLI.

Compatible server configurations share processes. Inspect/diagnostics enable Rust compiler checks; a changed configuration can use another server from the bounded pool. Between requests the session rereads opened files, sends versioned changes for external edits, and reports `refreshedDocuments`. Changes during a query discard its stale result; retry with a current anchor. Batch retains its fixed-input snapshot behavior. Dependency indexing beyond opened files follows the server's filesystem support.

A session accepts 200 queries, keeps up to eight servers and bounds retained document text to about 32 MiB of UTF-16. Old clients can be evicted. Input lines are limited to 16 MiB; invalid UTF-8 or oversized lines produce a row error. Keep logs and inputs outside the checkout.

## Continue references without repeating the query

```sh
codex-lsp references --file src/client.ts --line 20 --symbol open --page-size 20 --json
codex-lsp next --cursor CURSOR_FROM_nextCursor --json
```

`pageSize` is the JSONL field for `--page-size`. A session or batch can follow with `{"command":"next","cursor":"..."}`; next requires no file. `nextCursor` survives field selection such as `--fields locations`. Choose `--page-size` or `--limit`. Pages use one immutable query snapshot and preserve order; `offset`, `shown` and `total` describe coverage. Missing `nextCursor` marks the last page. `truncated` records that this page contains part of the full result.

Snapshots live for ten minutes in the user's private `~/.cache/codex-lsp/pages` directory. Source content, reference-file metadata and workspace are checked on continuation. Changed, expired or unavailable snapshots require a new references query. Newly added references require a fresh query. Virtual reference targets use ordinary references without `--page-size`. Up to 16 valid snapshots / 32 MiB are retained, with a 16 MiB per-snapshot ceiling; unrelated or damaged files are left to their owner.

## Bound the whole inspect response

`inspect --context --budget 3000` implies JSON and shares one character budget across the complete response, including status and budget metadata. The JSONL field is `budget`. Selection with `fields` happens first; batch/session row metadata is included in that row's budget. Characters use JavaScript UTF-16 length, excluding the terminal newline. The minimum accepted budget is 512; rich verification state can require more, and errors explain that minimum.

The output preserves errors, verification, failure sections, counts and atomic paths/positions. Text and samples can be clipped; original totals stay visible, and shown counts follow the emitted arrays. `budget` reports actual characters and omissions. Raise the budget, remove it, or select fewer fields to recover detail. Full workspace edits are omitted as a unit when clipping a preview; applying a requested edit still uses the normal CLI and complete validated edit set.
