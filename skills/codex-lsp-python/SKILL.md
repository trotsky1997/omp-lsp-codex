---
name: codex-lsp-python
description: Use codex-lsp with Python packages for environment-correct navigation, stub/source lookup, diagnostics and runtime-verified edits.
---

Use [shared CLI essentials](../codex-lsp/SKILL.md) once for commands, output and edit boundaries.

## Interpreter and imports

Prepare the project's declared dependencies in its environment. Pyright/basedpyright select `.venv`, then `venv`, under the matched project root: `bin/python` on macOS/Linux, `Scripts/python.exe` on Windows. Doctor reports each server's `pythonPath` separately from the CLI's Node runtime. Explicit `settings.python.pythonPath` selects a custom environment; confirm imports with that same interpreter.

Editable installation can connect the checked-out package to runtime imports. Follow the project's package manager version and extras. If the installed manager is too old, use an isolated compatible version (for example uvx with the required uv version) to prepare the environment. File queries wait for initial Python analysis; if it times out, check dependencies and the suggested timeout before repeating queries.

## Static types and runtime

Use `snippet --file PATH --line N --symbol NAME` to read a local function/class without Pyright startup. `signature-help --symbol NAME` on a call-site line lets ast-grep choose the intended nested call's argument cursor; explicit columns select later parameters. Interpreter preparation remains necessary for semantic answers.

Dynamic framework methods can hover as `Unknown` and have no LSP signature. When an empty result reports an automatic argument cursor, follow hover/definition or inspect the implementation's declaration. Typed nested calls can still resolve independently in the same expression.

Find anchors with `symbols --file PATH --query NAME` after source edits. Definition can land in `.pyi` or a dependency stub; inspect its path, then navigate into the implementation/package source when the task needs behavior. A stub is useful evidence for the declared API.

Pyright diagnostics can differ from a project's own checker, plugins or generated typing setup. Keep baseline errors visible, distinguish them from a changed file's diagnostics and run the project's relevant checks. Type-only imports guarded by `TYPE_CHECKING` may be required by the project's existing pattern; import and execute the changed code to verify its runtime path as well.

Use watch for disk-edit diagnostic deltas and cached targets for repeated navigation. An unavailable quickfix leaves `saved:false`; inspect the actual server/actions before changing tools or applying a plan. Static API comparison follows public declarations and literal `__all__`; dependency graphs resolve relative imports and package `__init__` exports. Large reverse graphs may hit the candidate/node cap: check `complete`, `bounded`, and the separate API `surfaceComplete`/`callsComplete` fields. Read [continuous workflows](../codex-lsp/references/workflows.md).

For rename previews, inspect `workspaceEdit.changes` or `workspaceEdit.documentChanges` URIs before applying. File moves can have `importUpdates: none/unavailable`; update affected imports and verify them with the selected Python interpreter. A valid empty diagnostic report covers the configured analysis scope; it does not execute imports or tests. Temporary runtime probes can use `python -B` to keep bytecode artifacts out of the checkout.
