# codex-lsp

A standalone Python 3.10+ CLI for local Language Server Protocol tools, packaged with Codex and Claude Code skills and lifecycle hooks. Runtime code uses only the Python standard library.

## Install the CLI with uv

The repository is private, so the GitHub account used by `uv` needs access. Register the command once:

```sh
uv tool install --from 'git+https://github.com/trotsky1997/omp-lsp-codex.git' codex-lsp
codex-lsp status
```

For a local checkout, run `uv tool install --from . codex-lsp` from the repository root. The plugin also bundles the CLI for environments where the registered command is unavailable.

## Commands

```sh
codex-lsp status
codex-lsp doctor
codex-lsp setup rust python
codex-lsp diagnostics --file path/to/file.rs
codex-lsp diagnostics --changed
codex-lsp definition --file path/to/file.rs --line 20 --symbol parse
codex-lsp references --file path/to/file.rs --line 20 --symbol parse
codex-lsp hover --file path/to/file.rs --line 20 --symbol parse
codex-lsp symbols --file path/to/file.rs
codex-lsp symbols --workspace --query parser
codex-lsp rename --file path/to/file.rs --line 20 --symbol parse --new-name parse_value
codex-lsp code-actions --file path/to/file.rs --line 20
```

`rename`, `rename-file`, and `code-actions` preview changes. Pass `--apply` to write them. `--json` returns structured results. The timeout range is 5–300 seconds.

When an LSP server returns no hover content, `codex-lsp hover` looks up the symbol in the DevDocs index for that file's language and returns a reference link. It downloads and caches the public catalog and indexes for 24 hours under `~/.codex/cache/codex-lsp/devdocs` (or `$CODEX_HOME/cache/codex-lsp/devdocs`); symbol matching happens locally. This is a best-effort reference lookup, not a replacement for full documentation.

## Server configuration

The bundled server list comes from the upstream `oh-my-pi` defaults. `codex-lsp setup rust python` resolves the built-in servers and records their executable paths. If a server is missing, setup selects install command options for the current operating system and prints the official documentation URL. Setup itself does not install language servers.

`codex-lsp doctor` checks the active configuration, initializes available language servers, and reports their capabilities. It does not write LSP configuration or apply workspace edits. A nonzero exit code means a configured server is missing or failed to initialize, or no server is available for the workspace.

For `typescript-language-server`, registration and installation do not guarantee that the server can find TypeScript. If initialization reports a missing TypeScript installation, configure `initOptions.tsserver.fallbackPath` to an installed `typescript/lib/tsserver.js`; see the [upstream configuration](https://github.com/typescript-language-server/typescript-language-server/blob/master/docs/configuration.md#tsserver-options). An empty workspace-symbol response is server-dependent and may be incomplete; try file symbols or navigation from a known use.

The CLI merges optional JSON files in this order:

1. `~/.codex/lsp.json`
2. `<git-root>/.codex/lsp.json`

Example:

```json
{
  "servers": {
    "my-language": {
      "command": "my-language-server",
      "args": ["--stdio"],
      "fileTypes": [".foo"],
      "rootMarkers": [".git", "project.foo"]
    }
  }
}
```

Each server needs a command, file types, and root markers. Built-in fields can be overridden by name. The CLI supports JSON configuration only.

The same configuration is used from Codex and Claude Code. `codex-lsp setup` writes to `~/.codex/lsp.json`, or `.codex/lsp.json` with `--project`.

## Install the Codex plugin

The GitHub repository is private, so the Git credentials available to Codex must have read access. Add the repository as a marketplace, then install the plugin:

```sh
codex plugin marketplace add https://github.com/trotsky1997/omp-lsp-codex.git
codex plugin add codex-lsp@codex-lsp-local
codex plugin list --marketplace codex-lsp-local
```

The list should show `codex-lsp` as installed and enabled. Open `/hooks` in Codex to review and trust the lifecycle hooks. In Tcodex, use the same commands with `tcodex` in place of `codex`.

To refresh after a new repository version is pushed, update the marketplace and reinstall the plugin:

```sh
codex plugin marketplace upgrade codex-lsp-local
codex plugin remove codex-lsp@codex-lsp-local
codex plugin add codex-lsp@codex-lsp-local
```

To uninstall it:

```sh
codex plugin remove codex-lsp@codex-lsp-local
codex plugin marketplace remove codex-lsp-local
```

## Install the Claude Code plugin

The GitHub repository is private, so your Git credentials must have read access. Install the plugin for your user:

```sh
claude plugin install codex-lsp --marketplace trotsky1997/omp-lsp-codex --scope user
claude plugin list
```

Claude Code exposes the skill as `/codex-lsp:codex-lsp`. The plugin adds the same session context and changed-file diagnostics hooks. Restart Claude Code, or run `/reload-plugins` in an open session after installing or updating.

## Skills and hooks

The `skills/codex-lsp` skill directs the agent to invoke the CLI through terminal or shell execution; this plugin does not add a separate LSP tool entry. Plugin hooks add available-server context when a session starts and check changed files before the agent stops. The Stop hook uses only bundled server definitions and executables resolved outside the project root. It asks the agent to continue when changed files have LSP errors; it skips when no server can verify them.

Codex lifecycle hooks are for manually installed Codex desktop plugins; packages containing them cannot be submitted to the public Codex plugin directory. For development from a local checkout, add its path instead with `codex plugin marketplace add /absolute/path/to/omp-lsp-codex`.

For the Codex CLI without plugin installation, clone this private repository, copy `skills/codex-lsp` into `~/.codex/skills/`, then merge the two handlers from `hooks/codex-hooks.json` into `~/.codex/hooks.json`. Replace `${PLUGIN_ROOT}` in each command with the checkout's absolute path. Install the CLI using the uv command at the top of this page.

## Scope

Each CLI invocation starts and stops its language server; there is no OMP project mux or persistent server cache. This package includes diagnostics, navigation, document/workspace symbols, rename, code actions, capabilities, and raw requests. Workspace-symbol completeness depends on the language server and its indexing behavior. Workspace diagnostics, OMP-specific linter adapters, and YAML configuration are not included. Workspace edits are restricted to the server's workspace root.
