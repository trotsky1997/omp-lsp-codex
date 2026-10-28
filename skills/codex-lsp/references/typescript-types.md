# TypeScript and JavaScript type queries

```sh
codex-lsp types --file src/app.ts --line 20 --symbol value --fields summary
codex-lsp types --file src/app.ts --line 20 --symbol value --view declared --fields summary
codex-lsp types --file src/app.ts --range 25:12-25:25 --view expected --json
```

`computed` returns the type at the selected use, including control-flow narrowing. `declared` follows the symbol to its declaration and reads its original annotation; `declarationSource: inferred` identifies a declaration without an explicit annotation, while `type-definition` identifies a named type/class/interface. `expected` returns the contextual requirement for an expression or argument. Some nodes have no contextual type: `found:false` is a successful empty answer with guidance. `--range` uses one-based UTF-16 columns and an exclusive end; select the actual expression. Name-only declarations and `--target` handles use the shared anchor workflow.

The provider is `typescript-api`; `--server typescript-api` selects it explicitly. The CLI prefers the file's installed `typescript` package. Prepare the project's declared dependencies before querying. When it has no compiler, the existing configured tsserver fallback or installed `tsserver`/`tsc` can supply it; missing-compiler errors provide `npm install --global typescript` and official docs. The CLI adds no runtime npm dependency. `compilerVersion`, `compilerPath` and `tsconfig` report the selected implementation. TypeScript 6.0.3 uses its Compiler API; TypeScript 7.0.2 uses its native sync/AST exports. No LSP server or TSP implementation is needed for this provider.

The closest tsconfig.json/jsconfig.json supplies compiler options and file membership. Missing config uses an inferred project. A file excluded by the selected config fails explicitly; confirm the containing package/config when that happens. A checker can return `any` for unresolved imports; prepare dependencies and run the project's type check when validating an edit.

`--fields summary` preserves provider, view, compiler version, snapshot and success state. `type` contains the type text/flags, union/intersection constituents, object properties and call signatures. Previews follow `--limit` and text limits, with a hard 200-member bound; truncation stays explicit. `--budget` omits the whole structured type when necessary and retains a bounded summary/state. The TypeScript shape uses its own flags and members; Python TSP graphs retain their protocol shape.

Batch/session rows accept `command: "types"`, `view`, `range`, `server`, `fields` and normal anchors. Compatible questions share an isolated worker and compiler state. Disk edits, dependency/config changes and newly created missing imports invalidate cached analysis. Queries validate their source snapshot and execute with a timeout; a stalled compiler process is closed before reuse. The CLI never emits project files.

```jsonl
{"command":"types","file":"src/app.ts","line":20,"symbol":"value","view":"computed","fields":"summary"}
{"command":"types","file":"src/app.ts","line":20,"symbol":"value","view":"expected","fields":"summary"}
```

Official references: [Compiler API through TypeScript 6](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API), [TypeScript package](https://www.npmjs.com/package/typescript).
