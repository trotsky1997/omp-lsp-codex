# Setup and readiness

Read this for missing servers, dependencies or initialization problems. `status --file PATH` is quick discovery; `doctor --file PATH` checks initialization and reports runtime, commands, roots and Python interpreters. Avoid repeating doctor for every successful query.

`setup rust python` accepts multiple languages, including comma-separated names. It registers an executable and preserves unrelated settings. `setup python --project` writes the selected project's configuration; `--project` takes no path, so select it with `--cwd PROJECT`.

When a server is absent, inspect the project's instructions/manifests, `command -v EXECUTABLE`, and the package manager's install prefix. Follow the platform-specific install command and official documentation emitted by setup. Register and verify one task-relevant query after installation. For npm, use `--fetch-timeout=15000 --fetch-retries=0`; if the registry is unavailable, inspect `npm cache ls PACKAGE` and use a compatible cached version with `--offline`.

The CLI runs compiled JavaScript on Node.js 22.20+ and has no runtime npm dependencies. Use `npm install --global git+https://github.com/trotsky1997/omp-lsp-codex.git` to register it. `npm prefix --global` identifies the prefix; add `bin` on macOS/Linux, the prefix itself on Windows, to PATH. Run from the project directory; the bundled fallback is `node PLUGIN_ROOT/dist/cli.js COMMAND`.

## Python

Install the project's declared dependencies into its environment before diagnosing imports. Pyright/basedpyright select `.venv`, then `venv`, under the matched project root: `bin/python` on macOS/Linux, `Scripts/python.exe` on Windows. Doctor JSON shows `pythonPath`. Explicit `settings.python.pythonPath` overrides discovery; use it for custom environments and check reported missing imports with that interpreter.

File queries wait for initial Python diagnostics before cross-file navigation or rename. Existing type errors keep navigation usable. A timeout is a readiness failure; retry with the larger `--timeout` suggested by the error after checking dependencies.

## TypeScript

The configuration ID can name `typescript-language-server` while its executable is `tsgo`; check `status.command`. Compare the selected command and settings when CLI, project compiler and hook results differ. Hooks ignore project overrides and honor user-global configuration.

If the actual TypeScript Language Server reports no TypeScript installation, check `node_modules/typescript/lib/tsserver.js`. Without a local installation, locate the existing global package (`npm root --global`) and set `initOptions.tsserver.fallbackPath` to its `lib/tsserver.js`, preserving other options. See the [official server configuration](https://github.com/typescript-language-server/typescript-language-server/blob/master/docs/configuration.md#tsserver-options). A duplicate TypeScript installation is usually unnecessary. The CLI defaults `tsserver.useSyntaxServer` to `never` for semantic cross-file results.

## Rust and incomplete analysis

Rust commands wait for a ready workspace; large projects may need `--timeout 120` (range 5–300 seconds). Workspace health warnings/errors include the server's reason. Inspect `cargo metadata --locked --format-version 1`, dependencies, build scripts and toolchains; without Cargo.lock, allow an initial metadata run without `--locked`. LSP subprocesses disable rustup's implicit installation, so explicitly install a required toolchain before retrying.

Rust diagnostics enable and wait for Cargo check. Match analysis features to the project test command using project-local `settings.rust-analyzer.cargo.features` and `noDefaultFeatures` as needed; see [official feature configuration](https://rust-analyzer.github.io/book/configuration.html#cargo.features). A zero-test run leaves project acceptance incomplete.

Diagnostics require every selected server to verify the file. Stale versions, concurrent source changes, silence or initialization failures remain unverified. Git enumeration errors, over 200 changed files, oversized files and symlink escapes fail explicitly; inspect the error or check individual supported files with `--file`.

Workspace-symbol results depend on server indexing. `symbols --workspace --file PATH --query NAME` selects the target language in mixed repositories; root searches may include both results and server errors. If empty, try file symbols, navigation from a known use, or source search. Each invocation closes its server; use inspect for several related questions to share startup.
