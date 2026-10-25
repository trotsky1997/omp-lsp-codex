#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { run, type Options } from "./commands.ts";
import { hook } from "./hooks.ts";
import { LspClient } from "./client.ts";
import { version } from "../package.json";

const HELP = `codex-lsp ${version} — TypeScript LSP tools for agents (Bun ${Bun.version})

Commands:
  setup LANGUAGE...      Register servers; print install commands and official docs if missing
  status                 List available servers
  doctor [--file PATH]    Check configuration, runtime and workspace health
  diagnostics            --file PATH or --changed
  definition             --file PATH --line N [--symbol NAME | --column N]
  references             --file PATH --line N [--symbol NAME | --column N]
  hover                  --file PATH --line N [--symbol NAME | --column N]
  type-definition        Find symbol types
  implementation         Find implementations
  symbols                --file PATH [--query NAME], or --workspace --query NAME [--file PATH]
  rename                 --file PATH --line N --symbol NAME --new-name NAME [--apply]
  rename-file            --file PATH --new-name PATH [--apply]
  code-actions           --file PATH --line N [--symbol NAME] [--query TITLE] [--apply]
  capabilities           [--file PATH]
  request                --method METHOD [--file PATH] [--payload JSON] [--apply]

Options: --json, --timeout SECONDS (5–300, default 20), --builtins-only
Positions are one-based UTF-16 columns. Use NAME#2 for a repeated token.
Rename and code-actions preview by default. Add --apply to write changes.
`;

export function parseOptions(
  argv: string[],
  cwd = process.cwd(),
): Options & { help: boolean; version: boolean } {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      file: { type: "string" },
      line: { type: "string" },
      column: { type: "string" },
      symbol: { type: "string" },
      query: { type: "string" },
      "new-name": { type: "string" },
      method: { type: "string" },
      payload: { type: "string" },
      timeout: { type: "string" },
      json: { type: "boolean" },
      changed: { type: "boolean" },
      workspace: { type: "boolean" },
      apply: { type: "boolean" },
      project: { type: "boolean" },
      "builtins-only": { type: "boolean" },
      "global-bins-only": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
    },
  });
  const timeout = Number(v.timeout ?? 20),
    line = Number(v.line ?? 1),
    column = v.column === undefined ? undefined : Number(v.column);
  if (!Number.isFinite(timeout)) throw new Error("--timeout must be a number");
  if (
    !Number.isInteger(line) ||
    line < 1 ||
    (column !== undefined && (!Number.isInteger(column) || column < 1))
  )
    throw new Error("--line and --column must be positive integers");
  const [command = "", ...languages] = positionals;
  if (languages.length && !["setup", "hook"].includes(command))
    throw new Error(`Unexpected argument: ${languages[0]}`);
  return {
    command,
    languages,
    cwd: realpathSync(cwd),
    file: v.file,
    line,
    column,
    symbol: v.symbol,
    query: v.query,
    newName: v["new-name"],
    method: v.method,
    payload: v.payload,
    timeout: Math.max(5, Math.min(300, timeout)) * 1000,
    json: !!v.json,
    changed: !!v.changed,
    workspace: !!v.workspace,
    apply: !!v.apply,
    project: !!v.project,
    builtinsOnly: !!v["builtins-only"],
    globalBinsOnly: !!v["global-bins-only"],
    help: !!v.help,
    version: !!v.version,
  };
}
export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseOptions(argv);
    if (args.version) {
      console.log(`codex-lsp ${version}`);
      return 0;
    }
    if (args.help || !args.command) {
      console.log(HELP);
      return 0;
    }
    if (args.command === "hook") {
      await hook(args);
      return 0;
    }
    const result = await run(args);
    console.log(args.json ? JSON.stringify(result.data) : result.human);
    return result.code ?? 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (argv.includes("--json")) console.log(JSON.stringify({ success: false, error: message }));
    else console.error(`codex-lsp: ${message}`);
    return 2;
  } finally {
    await Promise.allSettled([...LspClient.active].map((client) => client.close()));
  }
}
if (import.meta.main) {
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)
    process.once(signal, async () => {
      await Promise.allSettled([...LspClient.active].map((client) => client.close()));
      process.exit(code);
    });
  process.exitCode = await main();
}
