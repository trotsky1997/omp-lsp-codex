import { queryOptions } from "./batch.js";
import { run, outputData } from "./commands.js";
import { MAX_FILES, MAX_FILE_BYTES, object, uriFile } from "./config.js";
import { failure } from "./output.js";
export async function* sessionLines(input) {
    let buffer = Buffer.allocUnsafe(4096), size = 0, oversized = false, line = 1;
    const decode = () => {
        if (oversized)
            return { line, error: `Session input line exceeds ${MAX_FILE_BYTES} bytes` };
        try {
            return { line, text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)) };
        }
        catch {
            return { line, error: "Invalid UTF-8 session input" };
        }
    };
    for await (const value of input) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        let start = 0;
        while (start < chunk.length) {
            const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline;
            const needed = size + end - start;
            if (needed > MAX_FILE_BYTES)
                oversized = true;
            if (!oversized) {
                if (needed > buffer.length) {
                    const larger = Buffer.allocUnsafe(Math.min(MAX_FILE_BYTES, Math.max(needed, buffer.length * 2)));
                    buffer.copy(larger, 0, 0, size);
                    buffer = larger;
                }
                chunk.copy(buffer, size, start, end);
                size = needed;
            }
            if (newline < 0)
                break;
            yield decode();
            size = 0;
            oversized = false;
            line++;
            start = newline + 1;
        }
    }
    if (size || oversized)
        yield decode();
}
async function write(output, data) {
    await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        output.once("error", onError);
        output.write(JSON.stringify(data) + "\n", error => {
            if (error)
                reject(error);
            else {
                output.removeListener("error", onError);
                resolve();
            }
        });
    });
}
async function refresh(session) {
    let count = 0;
    for (const [key, client] of session.clients) {
        if (!client.reusable) {
            await client.close();
            session.clients.delete(key);
            continue;
        }
        try {
            count += await client.refresh();
        }
        catch (error) {
            await client.close();
            session.clients.delete(key);
            throw error;
        }
    }
    return count;
}
async function verify(session) {
    for (const [key, client] of session.clients) {
        try {
            for (const uri of client.documents.keys())
                await client.open(uriFile(uri));
        }
        catch (error) {
            await client.close();
            session.clients.delete(key);
            throw new Error(`Source changed during this query; retry with a current anchor. ${error}`);
        }
    }
    let characters = [...session.clients.values()].reduce((sum, client) => sum + [...client.documents.values()].reduce((n, doc) => n + doc.text.length, 0), 0);
    for (const [key, client] of session.clients) {
        if (characters <= MAX_FILE_BYTES)
            break;
        characters -= [...client.documents.values()].reduce((n, doc) => n + doc.text.length, 0);
        await client.close();
        session.clients.delete(key);
    }
}
export async function stdioSession(args, input = process.stdin, output = process.stdout) {
    if (!args.stdio)
        throw new Error("Use session --stdio; send JSONL queries and close stdin or send {\"command\":\"close\"}");
    if (args.apply || args.file || args.changed || args.workspace || args.newName || args.method || args.payload || args.project || args.symbol || args.query || args.column || args.line !== 1 || args.input || args.fields)
        throw new Error("session is read-only; put file, query and fields in its JSONL rows");
    const session = { clients: new Map(), diagnostics: false };
    let failed = false, queries = 0;
    try {
        for await (const row of sessionLines(input)) {
            if (row.text !== undefined && !row.text.trim())
                continue;
            const started = performance.now();
            const elapsed = () => Math.round((performance.now() - started) * 100) / 100;
            let id = row.line;
            try {
                if (row.error)
                    throw new Error(row.error);
                if (queries++ >= MAX_FILES) {
                    await write(output, { id, inputLine: row.line, code: 2, success: false, error: `Session limit is ${MAX_FILES} queries; start a new session` });
                    return 1;
                }
                const value = JSON.parse(row.text);
                const supplied = object(value).id;
                if (typeof supplied === "string" && supplied.length > 0 && supplied.length <= 128 || Number.isSafeInteger(supplied))
                    id = supplied;
                if (object(value).command === "close") {
                    if (Object.keys(object(value)).some(key => !["command", "id"].includes(key)) || supplied !== undefined && id !== supplied)
                        throw new Error("close accepts only command and an optional string/integer id");
                    await write(output, { id, inputLine: row.line, code: 0, success: true, closed: true, elapsedMs: elapsed() });
                    break;
                }
                const options = queryOptions(args, value, true);
                session.diagnostics ||= ["inspect", "diagnostics"].includes(options.command);
                const refreshed = await refresh(session);
                const result = await run(options, session);
                await verify(session);
                const code = result.code ?? 0;
                const data = outputData(result.data, { fields: options.fields });
                const response = { ...data, ...(refreshed ? { refreshedDocuments: refreshed } : {}), id, inputLine: row.line, code, elapsedMs: elapsed() };
                await write(output, outputData(response, { budget: options.budget }));
                failed ||= code !== 0;
            }
            catch (error) {
                failed = true;
                await write(output, { ...failure(error, args.limit), id, inputLine: row.line, code: 2, elapsedMs: elapsed() });
            }
        }
        return failed ? 1 : 0;
    }
    finally {
        await Promise.allSettled([...session.clients.values()].map(client => client.close()));
    }
}
