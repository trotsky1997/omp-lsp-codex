#!/usr/bin/env node
import { parseArgs } from "node:util";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { run } from "./commands.js";
import { hook } from "./hooks.js";
import { LspClient } from "./client.js";
import { expandHome } from "./config.js";
import { version } from "./version.js";
import { failure, parseFields, selectFields } from "./output.js";
const HELP = `codex-lsp ${version} — TypeScript LSP tools for agents (Node ${process.versions.node})

Commands:
  setup LANGUAGE... [--project]  Register servers; project scope uses the current directory
  status [--file PATH]    List available servers for the workspace or target file
  doctor [--file PATH]    Check configuration, runtime and workspace health
  batch --input PATH|-   Run read-only JSONL queries with shared language servers
  inspect                --file PATH --line N [--symbol NAME] [--context] [--new-name NAME]
                         Hover, definition, references, symbols and diagnostics in one session
  diagnostics            --file PATH or --changed
  definition             --file PATH --line N [--symbol NAME | --column N]
  references             --file PATH --line N [--symbol NAME | --column N]
  hover                  --file PATH --line N [--symbol NAME | --column N]
  signature-help         --file PATH --line N [--symbol NAME | --column N]
  snippet                --file PATH --line N [--symbol NAME | --column N]
                         Extract the enclosing declaration through ast-grep, without LSP
  type-definition        Find symbol types
  implementation         Find implementations
  symbols                --file PATH [--query NAME], or --workspace --query NAME [--file PATH]
  rename                 --file PATH --line N --symbol NAME --new-name NAME [--apply]
  rename-file            --file PATH --new-name PATH [--apply]
  code-actions           --file PATH --line N [--symbol NAME] [--query INDEX|TITLE] [--apply]
  capabilities           [--file PATH]
  request                --method METHOD [--file PATH] [--payload JSON] [--apply]

Options: --json, --timeout SECONDS (5–300, default 20), --global-config-only
  --cwd PATH            Use this project directory for setup, relative paths and --changed
  --limit N             Max results/hover lines (default 50, inspect/batch 10, signature-help 1; 0 shows all)
  --fields A,B          Select JSON object paths (implies --json), e.g. total,results.diagnostics.counts
                        Keeps status/error/truncation metadata; arrays are selected whole
  --context             Include enclosing source, definitions, types and sampled references in inspect
Positions are one-based UTF-16 columns. Use NAME#2 for a repeated token.
ast-grep improves --symbol and selects call arguments for signature-help --symbol.
Install it with npm install --global @ast-grep/cli. Explicit --column stays exact.
--project is a flag without a path; run setup from the intended project directory.
Rename and code-actions preview by default. Add --apply to write changes.
code-actions --query INDEX previews edit scope and flags server commands before execution.
inspect is read-only; --new-name adds a rename preview. Each section honors --limit.
Batch rows: {"command":"hover","file":"src/main.ts","line":10,"symbol":"parse"}
Optional row fields: cwd, column, symbol, query, limit, fields, workspace; context is available for inspect.
Batch continues after query errors; inspect --context shares a 6,000-character snippet budget.
`;
export function parseOptions(argv, cwd = process.cwd()) {
    const { values: v, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
            cwd: { type: "string" },
            file: { type: "string" },
            line: { type: "string" },
            column: { type: "string" },
            symbol: { type: "string" },
            query: { type: "string" },
            "new-name": { type: "string" },
            method: { type: "string" },
            payload: { type: "string" },
            input: { type: "string" },
            context: { type: "boolean" },
            timeout: { type: "string" },
            limit: { type: "string" },
            json: { type: "boolean" },
            fields: { type: "string" },
            changed: { type: "boolean" },
            workspace: { type: "boolean" },
            apply: { type: "boolean" },
            project: { type: "boolean" },
            "global-config-only": { type: "boolean" },
            "global-bins-only": { type: "boolean" },
            help: { type: "boolean", short: "h" },
            version: { type: "boolean" },
        },
    });
    const timeout = Number(v.timeout ?? 20), limit = Number(v.limit ?? (["inspect", "batch"].includes(positionals[0]) ? 10 : positionals[0] === "signature-help" ? 1 : 50)), line = Number(v.line ?? 1), column = v.column === undefined ? undefined : Number(v.column);
    if (!Number.isFinite(timeout))
        throw new Error("--timeout must be a number");
    if (!Number.isSafeInteger(limit) || limit < 0)
        throw new Error("--limit must be a nonnegative integer; 0 shows all results");
    if (!Number.isInteger(line) ||
        line < 1 ||
        (column !== undefined && (!Number.isInteger(column) || column < 1)))
        throw new Error("--line and --column must be positive integers");
    const [command = "", ...languages] = positionals;
    if (v.input !== undefined && command !== "batch")
        throw new Error("--input is only available for batch");
    if (v.context && command !== "inspect")
        throw new Error("--context is only available for inspect; set context on inspect rows in batch input");
    const fields = v.fields === undefined ? undefined : parseFields(v.fields);
    if (fields && command === "hook")
        throw new Error("--fields is unavailable for hook: hooks emit their own protocol");
    if (/\s/.test(command))
        throw new Error("Pass the command and flags as separate arguments; for example: codex-lsp inspect --file path/to/file.ts");
    if (languages.length && !["setup", "hook"].includes(command))
        throw new Error(`Unexpected argument: ${languages[0]}`);
    if (v.cwd === "")
        throw new Error("--cwd must name a directory");
    const context = realpathSync(resolve(cwd, expandHome(v.cwd ?? ".")));
    if (!statSync(context).isDirectory())
        throw new Error("--cwd must be a directory");
    return {
        command,
        languages,
        cwd: context,
        file: v.file,
        line,
        column,
        symbol: v.symbol,
        query: v.query,
        newName: v["new-name"],
        method: v.method,
        payload: v.payload,
        input: v.input,
        context: !!v.context,
        timeout: Math.max(5, Math.min(300, timeout)) * 1000,
        limit,
        json: !!v.json || fields !== undefined,
        fields,
        changed: !!v.changed,
        workspace: !!v.workspace,
        apply: !!v.apply,
        project: !!v.project,
        globalConfigOnly: !!v["global-config-only"],
        globalBinsOnly: !!v["global-bins-only"],
        help: !!v.help,
        version: !!v.version,
    };
}
export async function main(argv = process.argv.slice(2)) {
    let limit = 50;
    const json = argv.includes("--json") || argv.some(arg => arg === "--fields" || arg.startsWith("--fields="));
    try {
        const args = parseOptions(argv);
        limit = args.limit;
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
        console.log(args.json ? JSON.stringify(args.fields ? selectFields(result.data, args.fields) : result.data) : result.human);
        return result.code ?? 0;
    }
    catch (error) {
        const result = failure(error, limit);
        if (json)
            console.log(JSON.stringify(result));
        else
            console.error([`codex-lsp: ${result.error}`, result.hint].filter(Boolean).join("\n"));
        return 2;
    }
    finally {
        await Promise.allSettled([...LspClient.active].map((client) => client.close()));
    }
}
if (import.meta.main) {
    for (const [signal, code] of [
        ["SIGINT", 130],
        ["SIGTERM", 143],
    ])
        process.once(signal, async () => {
            await Promise.allSettled([...LspClient.active].map((client) => client.close()));
            process.exit(code);
        });
    process.exitCode = await main();
}
