import { createReadStream, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { expandHome, MAX_FILES, MAX_FILE_BYTES } from "./config.js";
import { parseFields } from "./output.js";
import { parseRange } from "./range.js";
const COMMANDS = new Set(["hover", "definition", "references", "type-definition", "implementation", "signature-help", "symbols", "diagnostics", "snippet", "inspect", "callers", "callees", "complete", "supertypes", "subtypes", "inlay-hints", "code-actions", "next", "dependencies", "api-diff", "lint", "format"]);
const FIELDS = new Set(["command", "file", "cwd", "line", "column", "symbol", "query", "limit", "fields", "workspace", "context", "depth", "resolve", "baseline", "range", "kind", "pageSize", "cursor", "budget", "target", "targets", "base", "reverse", "tool", "server", "check"]);
export async function batchQueries(args) {
    if (!args.input)
        throw new Error('batch requires --input PATH or --input - (JSONL); e.g. {"command":"hover","file":"src/main.ts","line":10}');
    if (args.apply || args.file || args.changed || args.workspace || args.newName || args.method || args.payload || args.project || args.symbol || args.query || args.column || args.line !== 1)
        throw new Error("batch is read-only; put file and query options in its JSONL rows");
    const stream = args.input === "-" ? process.stdin : createReadStream(resolve(args.cwd, expandHome(args.input)));
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_FILE_BYTES)
            throw new Error(`Batch input exceeds ${MAX_FILE_BYTES} bytes`);
        chunks.push(bytes);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    const rows = [];
    for (const [index, textLine] of text.split("\n").entries()) {
        if (!textLine.trim())
            continue;
        try {
            if (rows.length >= MAX_FILES)
                throw new Error(`Batch supports at most ${MAX_FILES} queries`);
            rows.push({ line: index + 1, options: queryOptions(args, JSON.parse(textLine)) });
        }
        catch (error) {
            throw new Error(`Batch input line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (!rows.length)
        throw new Error("Batch input contains no queries; provide one JSON object per line");
    return rows;
}
export function queryOptions(args, value, session = false) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Expected a JSON object per line");
    const row = value;
    for (const field of Object.keys(row))
        if (!FIELDS.has(field) && !(session && field === "id"))
            throw new Error(`Unknown ${session ? "session" : "batch"} field: ${field}; allowed: ${[...FIELDS, ...(session ? ["id"] : [])].join(", ")}`);
    if (typeof row.command !== "string" || !COMMANDS.has(row.command))
        throw new Error(`Unsupported read-only command; choose ${[...COMMANDS].join(", ")}${session ? ", close" : ""}`);
    if (!["next", "api-diff"].includes(row.command) && row.target === undefined && (typeof row.file !== "string" || !row.file.trim()))
        throw new Error("Each query requires file or target");
    for (const field of ["cwd", "symbol", "query", "fields", "baseline", "range", "kind", "cursor", "target", "base", "tool", "server"])
        if (row[field] !== undefined && (typeof row[field] !== "string" || !row[field].trim()))
            throw new Error(`${field} must be a nonempty string`);
    for (const field of ["line", "column", "limit"])
        if (row[field] !== undefined && (typeof row[field] !== "number" || !Number.isSafeInteger(row[field]) || row[field] < (field === "limit" ? 0 : 1)))
            throw new Error(`${field} must be ${field === "limit" ? "a nonnegative" : "a positive"} integer`);
    for (const field of ["workspace", "context", "resolve", "targets", "reverse", "check"])
        if (row[field] !== undefined && typeof row[field] !== "boolean")
            throw new Error(`${field} must be boolean`);
    if (row.tool !== undefined && !["lint", "format"].includes(row.command))
        throw new Error("tool is only available for lint/format");
    if (row.server !== undefined && !["lint", "format", "diagnostics", "code-actions"].includes(row.command))
        throw new Error("server is only available for lint/format/diagnostics/code-actions");
    if (row.tool !== undefined && row.server !== undefined)
        throw new Error("Choose tool or server");
    if (row.check !== undefined && row.command !== "format")
        throw new Error("check is only available for format");
    if (row.depth !== undefined && (!Number.isSafeInteger(row.depth) || Number(row.depth) < 1 || Number(row.depth) > 10 || !["callers", "callees", "supertypes", "subtypes", "dependencies"].includes(row.command)))
        throw new Error("depth must be 1-10 and applies to callers/callees/supertypes/subtypes/dependencies");
    if (row.resolve && !["complete", "inlay-hints"].includes(row.command))
        throw new Error("resolve is only available for complete/inlay-hints");
    if (row.baseline && row.command !== "diagnostics")
        throw new Error("baseline is only available for diagnostics");
    if (row.context && row.command !== "inspect")
        throw new Error("context is only available for inspect");
    if (row.workspace && row.command !== "symbols")
        throw new Error("workspace is only available for symbols");
    const range = typeof row.range === "string" ? parseRange(row.range) : undefined;
    if (range && (!["code-actions", "inlay-hints", "format"].includes(row.command) || row.line !== undefined || row.column !== undefined || row.symbol !== undefined))
        throw new Error("range is for code-actions/inlay-hints/format; choose range or line/column/symbol");
    if (row.kind !== undefined && (row.command !== "code-actions" || !/^[\w-]+(?:\.[\w-]+)*$/.test(String(row.kind))))
        throw new Error("kind requires code-actions and an action kind such as refactor.extract");
    if (row.pageSize !== undefined && (row.command !== "references" || !Number.isSafeInteger(row.pageSize) || Number(row.pageSize) < 1 || Number(row.pageSize) > 1000 || row.limit !== undefined))
        throw new Error("pageSize requires references, an integer from 1 to 1000 and no row limit");
    if (row.budget !== undefined && (!Number.isSafeInteger(row.budget) || Number(row.budget) < 512 || Number(row.budget) > MAX_FILE_BYTES))
        throw new Error(`budget must be an integer from 512 to ${MAX_FILE_BYTES}`);
    if (row.base !== undefined && row.command !== "api-diff")
        throw new Error("base is only available for api-diff");
    if (row.reverse && row.command !== "dependencies")
        throw new Error("reverse is only available for dependencies");
    if (row.target !== undefined && (row.file !== undefined || row.line !== undefined || row.column !== undefined || row.symbol !== undefined || row.range !== undefined))
        throw new Error("Choose target or file/line/column/symbol/range");
    if (row.target !== undefined && ["next", "api-diff", "dependencies", "diagnostics", "symbols", "lint", "format"].includes(row.command))
        throw new Error("target requires a position-based query");
    if (row.cursor !== undefined && row.command !== "next")
        throw new Error("cursor is only available for next");
    if (row.command === "next") {
        if (typeof row.cursor !== "string" || !row.cursor.trim())
            throw new Error("next requires cursor from a references page");
        for (const key of Object.keys(row))
            if (!["command", "cursor", "cwd", "fields", "id", "budget", "targets"].includes(key))
                throw new Error("next accepts cursor, cwd, fields, budget, targets and session id");
    }
    if (row.id !== undefined && !(typeof row.id === "string" && row.id.length > 0 && row.id.length <= 128 || Number.isSafeInteger(row.id)))
        throw new Error("id must be a nonempty string up to 128 characters or a safe integer");
    const cwd = realpathSync(resolve(args.cwd, expandHome(typeof row.cwd === "string" ? row.cwd : ".")));
    if (!statSync(cwd).isDirectory())
        throw new Error("cwd must be a directory");
    return { ...args, command: row.command, file: row.file, cwd,
        line: range ? range.start.line + 1 : row.line ?? 1, column: row.column,
        symbol: row.symbol, query: row.query,
        limit: row.limit ?? args.limit,
        workspace: !!row.workspace, context: !!row.context, input: undefined, stdio: false,
        fields: typeof row.fields === "string" ? parseFields(row.fields) : undefined,
        depth: Number(row.depth ?? 1), resolveCompletion: !!row.resolve, baseline: row.baseline,
        range, kind: row.kind, pageSize: row.pageSize,
        cursor: row.cursor, budget: row.budget ?? (session ? args.budget : undefined),
        target: row.target, targets: row.targets ?? (session ? args.targets : false),
        base: row.base, reverse: !!row.reverse,
        tool: row.tool, server: row.server, check: !!row.check, plan: undefined, };
}
