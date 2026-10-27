---
name: codex-lsp-rust
description: Use codex-lsp with Rust Cargo workspaces for semantic navigation, feature-aware diagnostics and verified refactors, including examples and macro-heavy crates.
---

Use [shared CLI essentials](../codex-lsp/SKILL.md) once for commands, output and edit boundaries. Keep Rust setup and verification tied to the actual Cargo target.

## Cargo membership and analysis

Discover manifests and target kinds before choosing a probe or run command:

```sh
cargo metadata --no-deps --format-version 1
```

Read the matching package's `manifest_path` and targets' `kind`, `name`, `src_path` and `required-features`. Workspace directories named `examples` can themselves be packages. Auto examples normally live at `<package-root>/examples/NAME.rs`; a flat file beside explicitly listed examples needs its own target registration. Confirm a newly created file appears in metadata before asking RA to rename it. Dev dependencies are available to examples/tests; an ordinary bin can lack them.

Use the discovered target: `cargo run -p PACKAGE --example NAME`, `--bin NAME`, or `cargo test --manifest-path PATH`, with its required features. Preserve existing manifests when an auto-discovered target suffices.

`doctor --file PATH` reports the nearest analysis root. Cargo workspace, excluded example and Git edit boundaries can differ. Install the required toolchain/dependencies explicitly; LSP subprocesses disable implicit rustup installation. If Cargo.lock exists, use `cargo metadata --locked` for dependency failures; allow an initial unlocked run when it is absent.

## Query and verify

`snippet --file PATH --line N --symbol NAME` reads the enclosing Rust item without Cargo/RA startup. It shows source syntax before macro expansion. `signature-help --symbol NAME` belongs on a call-site line; ast-grep handles qualified/turbofish calls and picks that call's arguments. Use an explicit column for later active parameters.

Macro bodies can expose token trees without parsed calls. If automatic signature selection explains this limit, use an explicit column after the call's `(`. RA can still have no semantic signature for a macro template; inspect the expanded call or the trait/function declaration in that case.

Large cold workspaces may need `--timeout 120`. Use inspect to share startup for related questions. A no-reference response warrants checking the declaration, target membership and enabled cfg/features. For macros/generated code, check build scripts and Cargo health before trusting an empty result. Read [derived implementations](references/derives.md) for derive imports and generated names.

Rust diagnostics enable Cargo check. Match `settings.rust-analyzer.cargo.features` and `noDefaultFeatures` to the intended build/test configuration. Verify a rename with the relevant Cargo target and check that tests actually run; inactive cfg hints or a zero-test run leave that branch untested.
