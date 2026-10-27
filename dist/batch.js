import { createReadStream, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { expandHome, MAX_FILES, MAX_FILE_BYTES } from "./config.js";
import { parseFields } from "./output.js";
const COMMANDS = new Set(["hover", "definition", "references", "type-definition", "implementation", "signature-help", "symbols", "diagnostics", "snippet", "inspect", "callers", "callees", "complete"]);
const FIELDS = new Set(["command", "file", "cwd", "line", "column", "symbol", "query", "limit", "fields", "workspace", "context", "depth", "resolve", "baseline"]);
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
            const value = JSON.parse(textLine);
            if (!value || typeof value !== "object" || Array.isArray(value))
                throw new Error("Expected a JSON object per line");
            const row = value;
            for (const field of Object.keys(row))
                if (!FIELDS.has(field))
                    throw new Error(`Unknown batch field: ${field}; allowed: ${[...FIELDS].join(", ")}`);
            if (typeof row.command !== "string" || !COMMANDS.has(row.command))
                throw new Error(`Unsupported read-only command; choose ${[...COMMANDS].join(", ")}`);
            if (typeof row.file !== "string" || !row.file.trim())
                throw new Error("Each query requires file");
            for (const field of ["cwd", "symbol", "query", "fields", "baseline"])
                if (row[field] !== undefined && (typeof row[field] !== "string" || !row[field].trim()))
                    throw new Error(`${field} must be a nonempty string`);
            for (const field of ["line", "column", "limit"])
                if (row[field] !== undefined && (typeof row[field] !== "number" || !Number.isSafeInteger(row[field]) || row[field] < (field === "limit" ? 0 : 1)))
                    throw new Error(`${field} must be ${field === "limit" ? "a nonnegative" : "a positive"} integer`);
            for (const field of ["workspace", "context", "resolve"])
                if (row[field] !== undefined && typeof row[field] !== "boolean")
                    throw new Error(`${field} must be boolean`);
            if (row.depth !== undefined && (!Number.isSafeInteger(row.depth) || Number(row.depth) < 1 || Number(row.depth) > 10 || !["callers", "callees"].includes(row.command)))
                throw new Error("depth must be 1-10 and applies to callers/callees");
            if (row.resolve && row.command !== "complete")
                throw new Error("resolve is only available for complete");
            if (row.baseline && row.command !== "diagnostics")
                throw new Error("baseline is only available for diagnostics");
            if (row.context && row.command !== "inspect")
                throw new Error("context is only available for inspect");
            if (row.workspace && row.command !== "symbols")
                throw new Error("workspace is only available for symbols");
            const cwd = realpathSync(resolve(args.cwd, expandHome(typeof row.cwd === "string" ? row.cwd : ".")));
            if (!statSync(cwd).isDirectory())
                throw new Error("cwd must be a directory");
            rows.push({ line: index + 1, options: { ...args, command: row.command, file: row.file, cwd,
                    line: row.line ?? 1, column: row.column,
                    symbol: row.symbol, query: row.query,
                    limit: row.limit ?? args.limit,
                    workspace: !!row.workspace, context: !!row.context, input: undefined,
                    fields: typeof row.fields === "string" ? parseFields(row.fields) : undefined,
                    depth: Number(row.depth ?? 1), resolveCompletion: !!row.resolve, baseline: row.baseline,
                } });
        }
        catch (error) {
            throw new Error(`Batch input line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (!rows.length)
        throw new Error("Batch input contains no queries; provide one JSON object per line");
    return rows;
}
