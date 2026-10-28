#!/usr/bin/env node
import { parseArgs } from "node:util";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { run, outputData } from "./commands.js";
import { hook } from "./hooks.js";
import { LspClient } from "./client.js";
import { expandHome, MAX_FILE_BYTES } from "./config.js";
import { version } from "./version.js";
import { failure, parseFields } from "./output.js";
import { parseRange } from "./range.js";
import { stdioSession } from "./session.js";
import { watchDiagnostics } from "./watch.js";
const HELP = `codex-lsp ${version} — Multi-language LSP tools for agents (Node ${process.versions.node})

Commands:
  setup LANGUAGE... [--project]  Register servers; project scope uses the current directory
  status [--file PATH]    List available servers for the workspace or target file
  doctor [--file PATH]    Check configuration, runtime and workspace health
  batch --input PATH|-   Run read-only JSONL queries with shared language servers
  session --stdio       Interactive JSONL queries; one result per line, shared servers
  next --cursor ID      Read the next cached references page without starting a server
  inspect                --file PATH --line N [--symbol NAME] [--context] [--new-name NAME]
                         Hover, definition, references, symbols and diagnostics in one session
  diagnostics            --file PATH or --changed
                         [--baseline PATH] [--save-baseline PATH]
                         [--watch --jsonl] Stream verified diagnostic changes
  fix --changed | --file PATH --plan PATH [--kind source.fixAll|quickfix] Save pure-text repairs
  lint                   --file PATH or --changed [--tool NAME | --server NAME] [--plan PATH]
  format                 --file PATH or --changed [--tool NAME | --server NAME] [--check | --plan PATH]
                         Preview edits; --check exits 1 when formatting changes are needed
  apply --plan PATH      Apply a reviewed unchanged plan and verify its selected providers
  api-diff --base REF    [--file PATH] Compare public syntax against a Git revision
  dependencies           --file PATH [--reverse] [--depth N] Import/re-export evidence graph
  callers / callees      --file PATH --line N [--symbol NAME] [--depth N]
  supertypes / subtypes  --file PATH --line N [--symbol NAME] [--depth N]
  inlay-hints            --file PATH --range START:COL-END:COL [--resolve]
  complete               --file PATH --line N [--column N] [--query NAME] [--resolve]
  impact --changed       Find changed declarations, references and candidate tests
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
  code-actions           --file PATH [--line N | --range START:COL-END:COL]
                         [--kind refactor.extract] [--query INDEX|TITLE] [--apply]
  capabilities           [--file PATH]
  request                --method METHOD [--file PATH] [--payload JSON] [--apply]

Options: --json, --timeout SECONDS (5–300, default 20), --global-config-only
  --cwd PATH            Use this project directory for setup, relative paths and --changed
  --limit N             Max results/hover lines (default 50, inspect/batch/impact 10, signature-help 1; 0 shows all)
  --fields A,B          Select JSON object paths (implies --json), e.g. total,results.diagnostics.counts
                        Keeps status/error/truncation metadata; arrays are selected whole
  --page-size N         References per snapshot page (1-1000); follow nextCursor with next
  --budget N            JSON character budget (512-16777216, implies --json); each streaming row is bounded
  --targets             Return reusable location IDs (implies --json); --fields targets gives compact handles
  --target ID           Reuse a location from --targets in the same workspace; source version is checked
  --context             Include enclosing source, definitions, types and sampled references in inspect
  --tool NAME           Select CLI backend: ruff, eslint, biome, prettier, rustfmt, clippy, oxlint, oxfmt
  --server NAME         Select an LSP provider for lint/format/fix/diagnostics/code-actions/request/capabilities
Lint/format fields: --fields checked (providers), diagnostics (lint), files (diff), checkedFiles,changedFiles,needsFormatting
Positions are one-based UTF-16 columns. Use NAME#2 for a repeated token.
ast-grep improves --symbol and selects call arguments for signature-help --symbol.
Install it with npm install --global @ast-grep/cli. Explicit --column stays exact.
--project is a flag without a path; run setup from the intended project directory.
Rename and code-actions preview by default. Add --apply to write changes.
Lint repairs and formatting use --plan PATH followed by apply --plan PATH.
code-actions --query INDEX previews edit scope and flags server commands before execution.
inspect is read-only; --new-name adds a rename preview. Each section honors --limit.
Batch rows: {"command":"hover","file":"src/main.ts","line":10,"symbol":"parse"}
Optional row fields: cwd, column, symbol, query, limit, fields, workspace; context is available for inspect.
Rows also support range/kind, depth, resolve, pageSize, cursor and budget for matching commands.
Session replies before EOF; send {"command":"close"} or close stdin to release servers.
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
            stdio: { type: "boolean" },
            target: { type: "string" },
            targets: { type: "boolean" },
            watch: { type: "boolean" },
            jsonl: { type: "boolean" },
            plan: { type: "string" },
            base: { type: "string" },
            reverse: { type: "boolean" },
            tool: { type: "string" },
            server: { type: "string" },
            check: { type: "boolean" },
            range: { type: "string" },
            kind: { type: "string" },
            "page-size": { type: "string" },
            cursor: { type: "string" },
            budget: { type: "string" },
            depth: { type: "string" },
            resolve: { type: "boolean" },
            baseline: { type: "string" },
            "save-baseline": { type: "string" },
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
    const timeout = Number(v.timeout ?? 20), limit = Number(v.limit ?? (["inspect", "batch", "session", "impact"].includes(positionals[0]) ? 10 : positionals[0] === "signature-help" ? 1 : 50)), line = Number(v.line ?? 1), column = v.column === undefined ? undefined : Number(v.column);
    if (!Number.isFinite(timeout))
        throw new Error("--timeout must be a number");
    if (!Number.isSafeInteger(limit) || limit < 0)
        throw new Error("--limit must be a nonnegative integer; 0 shows all results");
    if (!Number.isInteger(line) ||
        line < 1 ||
        (column !== undefined && (!Number.isInteger(column) || column < 1)))
        throw new Error("--line and --column must be positive integers");
    const [command = "", ...languages] = positionals;
    const depth = Number(v.depth ?? 1);
    if (!Number.isSafeInteger(depth) || depth < 1 || depth > 10)
        throw new Error("--depth must be an integer from 1 to 10");
    if (v.depth !== undefined && !["callers", "callees", "supertypes", "subtypes", "dependencies"].includes(command))
        throw new Error("--depth is only available for callers/callees/supertypes/subtypes/dependencies");
    if (v.resolve && !["complete", "inlay-hints"].includes(command))
        throw new Error("--resolve is only available for complete/inlay-hints");
    const range = v.range === undefined ? undefined : parseRange(v.range);
    if (range && !["code-actions", "inlay-hints", "format"].includes(command))
        throw new Error("--range is only available for code-actions/inlay-hints/format");
    if (range && (v.line !== undefined || v.column !== undefined || v.symbol !== undefined))
        throw new Error("Choose --range or --line/--column/--symbol");
    if (v.kind !== undefined && (!["code-actions", "fix"].includes(command) || !/^[\w-]+(?:\.[\w-]+)*$/.test(v.kind)))
        throw new Error("--kind requires code-actions/fix and an action kind such as refactor.extract");
    const pageSize = v["page-size"] === undefined ? undefined : Number(v["page-size"]);
    if (pageSize !== undefined && (command !== "references" || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000))
        throw new Error("--page-size requires references and an integer from 1 to 1000");
    if (pageSize !== undefined && v.limit !== undefined)
        throw new Error("Choose --page-size or --limit");
    if (v.cursor !== undefined && (command !== "next" || !v.cursor.trim()))
        throw new Error("--cursor requires next and a nonempty snapshot cursor");
    const budget = v.budget === undefined ? undefined : Number(v.budget);
    if (budget !== undefined && (command === "hook" || !Number.isSafeInteger(budget) || budget < 512 || budget > MAX_FILE_BYTES))
        throw new Error(`--budget must be an integer from 512 to ${MAX_FILE_BYTES}; hooks emit their own protocol`);
    if (v.watch && command !== "diagnostics")
        throw new Error("--watch is only available for diagnostics");
    if (v.jsonl && (command !== "diagnostics" || !v.watch))
        throw new Error("Use diagnostics --watch --jsonl");
    if (v.plan !== undefined && (!["fix", "apply", "lint", "format"].includes(command) || !v.plan.trim()))
        throw new Error("--plan requires fix/apply/lint/format and a nonempty path");
    if (v.tool !== undefined && (!["lint", "format", "fix"].includes(command) || !v.tool.trim()))
        throw new Error("--tool requires lint/format/fix and a nonempty backend name");
    if (v.server !== undefined && (!["lint", "format", "fix", "diagnostics", "code-actions", "request", "capabilities"].includes(command) || !v.server.trim()))
        throw new Error("--server requires lint/format/fix/diagnostics/code-actions/request/capabilities and a nonempty provider name");
    if (v.tool !== undefined && v.server !== undefined)
        throw new Error("Choose --tool NAME or --server NAME");
    if (v.check && (command !== "format" || v.plan !== undefined))
        throw new Error("--check requires format; choose --check or --plan");
    if (v.base !== undefined && (command !== "api-diff" || !v.base.trim()))
        throw new Error("--base requires api-diff and a nonempty Git revision");
    if (v.reverse && command !== "dependencies")
        throw new Error("--reverse requires dependencies");
    if (v.target !== undefined && (!v.target.trim() || v.file !== undefined || v.line !== undefined || v.column !== undefined || v.symbol !== undefined || range))
        throw new Error("Choose --target ID or --file/--line/--column/--symbol/--range");
    if (v.target !== undefined && !["hover", "definition", "references", "type-definition", "implementation", "signature-help", "snippet", "inspect", "rename", "code-actions", "callers", "callees", "supertypes", "subtypes", "complete"].includes(command))
        throw new Error("--target requires a position-based query or rename/code-actions");
    if (v.stdio && command !== "session")
        throw new Error("--stdio is only available for session");
    if ((v.baseline !== undefined || v["save-baseline"] !== undefined) && command !== "diagnostics")
        throw new Error("Baseline flags are only available for diagnostics");
    if (v.baseline === "" || v["save-baseline"] === "")
        throw new Error("Baseline paths must be nonempty");
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
        line: range ? range.start.line + 1 : line,
        column,
        symbol: v.symbol,
        query: v.query,
        newName: v["new-name"],
        method: v.method,
        payload: v.payload,
        input: v.input,
        context: !!v.context,
        depth,
        resolveCompletion: !!v.resolve,
        baseline: v.baseline,
        saveBaseline: v["save-baseline"],
        range, kind: v.kind, pageSize, cursor: v.cursor, budget, stdio: !!v.stdio,
        target: v.target, targets: !!v.targets, watch: !!v.watch, jsonl: !!v.jsonl || !!v.watch,
        plan: v.plan, base: v.base, reverse: !!v.reverse,
        tool: v.tool, server: v.server, check: !!v.check,
        timeout: Math.max(5, Math.min(300, timeout)) * 1000,
        limit,
        json: !!v.json || fields !== undefined || budget !== undefined || !!v.stdio || !!v.targets || !!v.watch,
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
    let limit = 50, maximum, completed;
    const json = argv[0] === "session" || argv.includes("--json") || argv.includes("--targets") || argv.includes("--watch") || argv.includes("--jsonl") || argv.some(arg => arg === "--fields" || arg.startsWith("--fields=") || arg === "--budget" || arg.startsWith("--budget="));
    try {
        const args = parseOptions(argv);
        limit = args.limit;
        maximum = args.budget;
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
        if (args.command === "session")
            return await stdioSession(args);
        if (args.watch) {
            const controller = new AbortController(), stop = () => {
                controller.abort();
                for (const client of LspClient.active)
                    void client.close();
            };
            process.once("SIGINT", stop);
            process.once("SIGTERM", stop);
            try {
                return await watchDiagnostics(args, process.stdout, controller.signal);
            }
            finally {
                process.removeListener("SIGINT", stop);
                process.removeListener("SIGTERM", stop);
            }
        }
        const result = completed = await run(args);
        console.log(args.json ? JSON.stringify(outputData(result.data, args)) : result.human);
        return result.code ?? 0;
    }
    catch (error) {
        const state = Object.fromEntries(["applied", "applicationState", "verification", "diagnosticVerification", "toolVerification", "saved", "needsFormatting", "plan"].filter(key => completed?.data[key] !== undefined).map(key => [key, completed.data[key]]));
        const changed = state.applied === true || state.applied === null;
        const message = { ...failure(error, limit), ...state, ...(changed ? { hint: "Output failed after editing. Inspect applied/file states and rerun diagnostics; do not retry the edit." } : {}) };
        let result;
        try {
            result = outputData(message, { budget: maximum });
        }
        catch {
            const { plan, ...short } = message;
            result = outputData({ ...short, ...(plan ? { planPathOmitted: true } : {}) }, { budget: maximum });
        }
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
    if (!process.argv.includes("--watch"))
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
