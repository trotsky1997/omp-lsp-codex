# Setup and readiness

Read this for missing servers, dependencies or initialization problems. `status --file PATH` is quick discovery; `doctor --file PATH` checks initialization and reports runtime, commands, roots and Python interpreters. Avoid repeating doctor for every successful query.

`setup rust python` accepts multiple languages, including comma-separated names. It registers an executable and preserves unrelated settings. `setup python --project` writes the selected project's configuration; `--project` takes no path, so select it with `--cwd PROJECT`.

When a server is absent, inspect the project's instructions/manifests, `command -v EXECUTABLE`, and the package manager's install prefix. Follow the platform-specific install command and official documentation emitted by setup. Register and verify one task-relevant query after installation. For npm, use `--fetch-timeout=15000 --fetch-retries=0`; if the registry is unavailable, inspect `npm cache ls PACKAGE` and use a compatible cached version with `--offline`.

The CLI runs compiled JavaScript on Node.js 22.20+ and has no runtime npm dependencies. Use `npm install --global https://github.com/trotsky1997/omp-lsp-codex/releases/latest/download/codex-lsp.tgz` to register it. `npm prefix --global` identifies the prefix; add `bin` on macOS/Linux, the prefix itself on Windows, to PATH. Run from the project directory; the bundled fallback is `node PLUGIN_ROOT/dist/cli.js COMMAND`.

For language-specific environment, Cargo target and TypeScript project decisions, read the matching subskill linked from the main skill.

Diagnostics require every selected server to verify the file. Stale versions, concurrent source changes, silence or initialization failures remain unverified. Git enumeration errors, over 200 changed files, oversized files and symlink escapes fail explicitly; inspect the error or check individual supported files with `--file`.

Workspace-symbol results depend on server indexing. `symbols --workspace --file PATH --query NAME` selects the target language in mixed repositories; root searches may include both results and server errors. If empty, try file symbols, navigation from a known use, or source search. Each invocation closes its server; use inspect for several related questions to share startup.
