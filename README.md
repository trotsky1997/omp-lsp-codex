# Codex LSP

A standalone Python 3.10+ CLI for local Language Server Protocol tools, packaged with a Codex skill and lifecycle hooks. Runtime code uses only the Python standard library.

## Run the CLI with uvx

The repository is private, so the GitHub account used by `uvx` needs access to it. Run a command directly from GitHub:

```sh
uvx --from 'git+https://github.com/trotsky1997/omp-lsp-codex.git' codex-lsp status
```

To run from a local checkout, use `uvx --from . codex-lsp status` from the repository root. Add the same `uvx --from ...` prefix to other `codex-lsp` commands. The plugin itself already bundles the CLI, so this step is only needed for standalone CLI use.

## Commands

```sh
codex-lsp status
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

## Server configuration

The bundled server list comes from the upstream `oh-my-pi` defaults. Install the language server executable for the language you need; the CLI does not install language servers.

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

## Codex skill and hooks

The `skills/codex-lsp` skill directs Codex to the CLI for navigation and diagnostics. Plugin hooks add available-server context when a session starts and check changed files before Codex stops. The Stop hook uses only bundled server definitions and executables resolved outside the project root. It asks Codex to continue when changed files have LSP errors; it skips when no server can verify them.

For plugin installation, add this folder as a local marketplace with `codex plugin marketplace add /absolute/path/to/omp-lsp-codex`, then install it from the local marketplace in the Codex desktop app. Review and trust the hook definitions with `/hooks` before they run. Lifecycle hooks are for manually installed Codex desktop plugins; packages containing them cannot be submitted to the public plugin directory.

For the Codex CLI without plugin installation, clone this private repository, copy `skills/codex-lsp` into `~/.codex/skills/`, then merge the two handlers from `hooks/hooks.json` into `~/.codex/hooks.json`. Replace `${PLUGIN_ROOT}` in each command with the checkout's absolute path. The skill can run the CLI with the `uvx --from 'git+https://github.com/trotsky1997/omp-lsp-codex.git' codex-lsp` prefix. The scripts also work when called directly; they infer the package root from their own file path.

## Scope

Each CLI invocation starts and stops its language server; there is no OMP project mux or persistent server cache. This package includes diagnostics, navigation, document/workspace symbols, rename, code actions, capabilities, and raw requests. Workspace diagnostics, OMP-specific linter adapters, and YAML configuration are not included. Workspace edits are restricted to the server's workspace root.
