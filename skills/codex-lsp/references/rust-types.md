# Rust semantic type queries

```sh
codex-lsp setup rust-types
codex-lsp types --file src/lib.rs --line 20 --symbol value --fields summary
codex-lsp types --file src/lib.rs --line 20 --symbol value --view declared --fields summary
codex-lsp types --file src/lib.rs --range 25:12-25:25 --view expected --json
```

`setup rust-types` checks `codex-lsp-rust-types` on PATH and in Cargo's registered bin directory (`CARGO_HOME/bin`, default `~/.cargo/bin`). When missing, it prints the installation command using this plugin's bundled `native/rust-types` directory: `cargo install --locked --path PATH`. Install Rust 1.98+ and `rustup component add rust-src` first. Cargo registers the executable in its bin directory. This optional helper uses pinned rust-analyzer 0.0.358 internal APIs; the main CLI stays on Node with no runtime npm dependencies. `--server rust-analyzer-api` selects this backend explicitly. Normal LSP navigation continues using the installed rust-analyzer.

Queries require a linked Cargo target and prepared dependencies/lockfile. The helper uses `cargo metadata --locked`; prepare an absent lockfile before querying. It inherits the existing rust-analyzer `cargo.features`, `noDefaultFeatures` and `target` settings. Build scripts and external process macros are disabled in this initial backend, with `analysis.buildScripts` and `analysis.procMacros` reported explicitly. Prepare generated sources separately. Inactive cfg branches, unresolved imports and missing generated code can prevent a type result.

| View | Meaning |
|---|---|
| `computed` | The checker's original expression/binding type; `type.adjusted` separately records coercions/autoderef when provided. |
| `declared` | Resolves the symbol to its declaration. `declarationSource` identifies an annotation, destructuring pattern, inferred binding, signature or type definition. |
| `expected` | Direct argument parameter after generic substitution, annotated initializer, assignment RHS, record field or function return context, propagated through blocks, match arms and if/else branches. `expectedSource` identifies the evidence. |

Select the whole argument/RHS with `--range` when operators or nested expressions matter, including a leading `&`. Selecting an enclosing statement, match arm, single argument list or part of a larger argument can return `found:false`, `suggestedRange` and a copyable expression retry. Contexts outside the implemented semantic cases return `found:false` and a hint. A cast's target type is not used as the expected input type. Method signature parameters exclude a bound receiver. Source-code formatting retains associated projections such as `<F as Future>::Output`; function items are presented as callable signatures. Named/static lifetimes emitted by the engine remain intact. `incomplete:true` marks a returned type containing unresolved components.

Declarative macro use sites descend into their active expansion for semantic queries and declaration lookup. Multiple expansions of the same source token return an explicit ambiguity hint. Inactive cfg declarations require the Cargo feature that enables them; check the returned `analysis.features` before retrying.

The provider is `rust-analyzer-api`, using the helper's `codex/types` API. JSON retains `engineVersion`, `backendVersion`, `apiVersion`, `snapshot`, `view`, `summary` and structured `type`; this backend implements no TSP wire protocol. Type details include fields, instantiated generic arguments, tuples and call signatures. Preview text/member limits and whole-type budget omission follow the shared CLI. `--fields summary` keeps the answer and API identity compact; request `--fields summary,analysis` when configuration scope matters.

Batch/session queries share the Cargo database. Source/dependency/configuration changes invalidate the workspace snapshot; the next query reloads it, and concurrent changes reject the in-progress answer. Cache identity includes the workspace and selected Cargo settings. Large cold workspaces can need `--timeout 120`. Use a stdio session for follow-up questions instead of repeated cold starts. The CLI reads disk-backed files and preserves source/Git index.

Official API sources: [rust-analyzer architecture](https://rust-analyzer.github.io/book/contributing/architecture.html), [semantic APIs](https://docs.rs/ra_ap_hir/0.0.358/ra_ap_hir/struct.Semantics.html), [Cargo workspace loading](https://docs.rs/ra_ap_load-cargo/0.0.358/ra_ap_load_cargo/).
