# Python type queries with TSP

Install the optional Pyrefly backend using `uv tool install pyrefly`, then run `codex-lsp setup pyrefly-tsp`. The builtin starts `pyrefly tsp` over stdio. `status --file PATH` reports its `protocol: tsp`; `doctor --file PATH` negotiates its protocol version. The Node CLI keeps its existing runtime and dependencies.

```sh
codex-lsp types --file app.py --line 20 --symbol value --fields summary
codex-lsp types --file app.py --line 20 --symbol value --view declared --fields summary
codex-lsp types --file app.py --range 25:12-25:25 --view expected --json
```

`computed` is the inferred or flow-narrowed type; `declared` requests the annotation; `expected` is the type required by the context, such as a function argument. The backend determines each answer; on Pyrefly 1.4.0, declared queries on narrowed references can return a narrowed type. Query the annotation's declaration when you need the original declared union. For expected types, select the argument/RHS expression; a function declaration can have no contextual type. A position sends a zero-width source node, while `--range` sends the whole expression. Positions and ranges use one-based UTF-16 columns with exclusive ends. Omitting `--line` with `--symbol` resolves a unique declaration through ast-grep.

`types` selects a `protocol: tsp` provider matching the file. `--server NAME` explicitly selects any configured matching backend and checks its TSP handshake. Custom `.codex/lsp.json` entries use the existing `command`, `args`, `fileTypes`, `rootMarkers` and `settings` fields plus `protocol: "tsp"`. Normal LSP navigation, diagnostics and hooks select LSP providers. `pyrefly lsp` does not accept TSP requests; retain `args: ["tsp"]` for this provider. Pyrefly discovers its Python environment and project configuration; prepare project dependencies and inspect its checker configuration when imports are unresolved.

Use batch or a stdio session for several views without restarting the backend:

```jsonl
{"command":"types","file":"app.py","line":20,"symbol":"value","view":"computed","fields":"summary"}
{"command":"types","file":"app.py","line":20,"symbol":"value","view":"expected","fields":"summary"}
```

JSON includes `provider: "tsp"`, `server`, `view`, `protocolVersion`, `snapshot`, `cursor`, `summary` and `type`. `found: false` means that this backend returned no type at the selected node; the command succeeds and includes a hint. Unsupported TSP reports `supported: false` and exits 1. Protocol failures exit 2. Hover/DevDocs text is never substituted for a TSP result. `--fields summary` retains the protocol/view/snapshot and success state; request `--fields type` or omit fields for the structured graph.

Pyrefly can mark an enum subtype as a literal while omitting its member value. The summary then says `literal value unavailable` and groups repeated display names with their variant count. Read the raw graph or source for further evidence; the response supplies no exact member identity in that case. Generated Callables can have an empty declaration URI, and repeated identical type definitions share an ID within their response.

This client negotiates stable TSP 0.4.x. Every query obtains a current snapshot; stale-snapshot cancellation or a concurrent snapshot notification retries with a fresh snapshot up to three times within the query timeout. Disk changes are synchronized between session rows. Type IDs belong to one response and its session snapshot: keep each graph independent and issue a new query after changes. A small `--budget` omits the entire graph with `typeOmitted: true`, preserving a bounded summary and state. Increase the budget or select only `type` to retrieve it; graph fragments are never silently pruned by the budget.

The initial integration uses one connection and the three type views. TSP has no automatic diagnostic substitution or Rust/TypeScript backend bundled here. The read-only raw whitelist covers TSP queries; raw snapshot IDs remain scoped to their originating process. Use `types` for snapshot management across batch/session questions.

Official references: [TSP specification](https://github.com/microsoft/pylance-release/blob/main/docs/tsp/type-server-protocol.md), [wire types](https://github.com/microsoft/pylance-release/blob/main/docs/tsp/typeServerProtocol.ts), [Pyrefly integration](https://pyrefly.org/blog/pyrefly-pylance/).
