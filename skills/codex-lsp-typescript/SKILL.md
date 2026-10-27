---
name: codex-lsp-typescript
description: Use codex-lsp with TypeScript or JavaScript projects for tsconfig-aware navigation, generic signatures, import actions and runtime-verified refactors.
---

Use [shared CLI essentials](../codex-lsp/SKILL.md) once for commands, output and edit boundaries.

## Project and server

Start from the package/tsconfig containing the file. Prepare declared dependencies and required generated sources using the project's package manager and build scripts. In a monorepo, check tsconfig inclusion, references and path aliases before interpreting missing imports or an unlinked probe. Missing generated exports can cause downstream type errors; run the declared generation/build task before recording those as baseline diagnostics.

Projects enforcing `devEngines.packageManager` can reject `npm exec` before pnpm starts. Bootstrap the declared package-manager version from outside the checkout, then run its executable from the project directory. Prepare the selected workspace package and its dependencies using the lockfile.

`status --file PATH` shows the actual executable. The configuration ID `typescript-language-server` can select `tsgo`. Compare command, project/compiler versions and options when editor and CLI results differ. Hooks ignore project overrides.

If TypeScript Language Server cannot find TypeScript, check local `node_modules/typescript/lib/tsserver.js`, then the existing global package. Set `initOptions.tsserver.fallbackPath` when needed instead of installing a duplicate compiler. Semantic navigation defaults `tsserver.useSyntaxServer` to `never`.

## Types, imports and execution

A concise hover can name an alias without expanding its return type. Follow type-definition/definition or query the alias; complete output still reflects the server's abbreviations. Use `signature-help --symbol NAME` on the target call's line so ast-grep finds its argument list, including generics and nested calls. Explicit `--column` selects an exact active-parameter position. Compare the returned callable before using the signature. `snippet` reads the enclosing function/method/class directly from syntax without starting tsserver.

For missing imports, list code actions, preview the selected original index with `--query INDEX`, inspect its edit scope and `executesCommand`, then apply. Check diagnostics and the project build/tests afterwards.

For extraction, select the expression or statements inside the function body with `code-actions --range ... --kind refactor.extract`. An entire declaration can expose move actions or no extraction. Check returned kinds and disabled reasons before applying. Type hierarchy and hint/resolve support vary by executable; check capabilities on the actual server. An already installed TypeScript Language Server can provide refactors or inlay hints missing from another backend; use an isolated project override for a comparison and preserve the original configuration.

`fix --plan` persists pure-text actions; server commands stay in the individual code-actions workflow. Select a reviewed unpreferred edit with `--file --query INDEX`; inspect `saved`, `skipped` and the actual provider. API/dependency syntax follows exports, relative imports and barrels, while tsconfig aliases and inferred types need compiler checks. Watch events use `event` names; `changes` is the diagnostic delta field. Read [continuous workflows](../codex-lsp/references/workflows.md).

Module suffixes `.mjs`/`.cjs` use JavaScript; `.mts`/`.cts` use TypeScript. Ensure the chosen file is in the intended project. Node can execute supported erasable TypeScript from a `.ts` or `.mts` file. Keep an ordinary eval driver in JavaScript, for example:

```sh
node --input-type=module -e 'import("./path/probe.ts").then(m => { if (m.increment(4) !== 5) throw new Error("unexpected result"); })'
```

Use the project's runner/build for namespaces, JSX, transforms, aliases or loader requirements. Pure type stripping cannot execute a namespace. Type-checking and type stripping are separate checks; run both when behavior changed.
