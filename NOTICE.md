# Upstream source

Source: [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), commit `3a2758b68f7c8e6bdf22c3a76b86c8675e5e0c9e`.

The following TypeScript code is extracted from `packages/coding-agent/src/`:

- `src/omp/message-framing.ts`: `jsonrpc/message-framing.ts`, unchanged.
- `src/omp/types.ts`: core protocol and JSON-RPC types from `lsp/types.ts`, with the OMP tool schema and runtime interfaces excluded.
- `src/omp/capabilities.ts`: `CLIENT_CAPABILITIES` from `lsp/client.ts`, exported for the standalone client. The client adjusts write and diagnostic registration capabilities to its supported invocation mode.
- `src/omp/symbol-column.ts`: symbol matching and column resolution from `lsp/utils.ts`; disk access and missing-file checks use standalone filesystem helpers.
- `src/omp/text-edits.ts`: string edit application, sorting, duplicate handling and overlap validation from `lsp/edits.ts`; errors use the standard Error class.
- `src/client.ts`: adapted async stdio transport and method-first JSON-RPC dispatch from `lsp/client.ts`, with standalone process ownership, explicit write permissions and invocation-scoped readiness.

`src/defaults.json` derives from `lsp/defaults.json`, with install guidance added. The OMP-specific `typescript-native` and `swiftlint` entries are omitted.

OMP's UI, agent runtime, logger, native helpers, shared mux and tool schema are outside this package. The upstream MIT license is included at `LICENSES/oh-my-pi-MIT.txt`.
