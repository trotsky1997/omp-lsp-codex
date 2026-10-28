import { createHash, randomBytes } from "node:crypto";
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { gitRoot, MAX_FILES, MAX_FILE_BYTES, object, readText } from "./config.js";
const TTL = 10 * 60 * 1000, MAX_TARGETS = 2000;
const hash = (text) => createHash("sha256").update(text).digest("hex");
const workspace = (cwd) => realpathSync(gitRoot(cwd));
function directory() {
    let root = realpathSync(homedir());
    for (const part of [".cache", "codex-lsp", "targets"]) {
        root = join(root, part);
        try {
            mkdirSync(root, { mode: 0o700 });
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
        }
        const info = lstatSync(root);
        if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== "win32" && (process.getuid && info.uid !== process.getuid() || (info.mode & 0o022) || part === "targets" && (info.mode & 0o077)))
            throw new Error(`Unsafe target cache directory: ${root}`);
    }
    return root;
}
function readCache(file) {
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_FILE_BYTES || process.platform !== "win32" && (before.mode & 0o077 || process.getuid && before.uid !== process.getuid()))
        throw new Error("Unsafe target snapshot");
    const fd = openSync(file, "r");
    try {
        const after = fstatSync(fd);
        if (after.dev !== before.dev || after.ino !== before.ino || after.size > MAX_FILE_BYTES)
            throw new Error("Target snapshot changed while opening");
        return object(JSON.parse(readFileSync(fd, "utf8")));
    }
    finally {
        closeSync(fd);
    }
}
export function resolveTarget(args) {
    if (!args.target)
        return args;
    if (args.file || args.symbol || args.column || args.line !== 1 || args.range)
        throw new Error("Choose --target ID or --file/--line/--column/--symbol/--range");
    const match = /^t_([A-Za-z0-9_-]{16})\.(\d{1,4})$/.exec(args.target);
    if (!match)
        throw new Error("Invalid target ID; request a fresh result with --targets");
    let snapshot;
    try {
        snapshot = readCache(join(directory(), match[1] + ".json"));
    }
    catch (error) {
        throw new Error(`Target snapshot unavailable; rerun the original query with --targets. ${error}`);
    }
    if (snapshot.root !== workspace(args.cwd))
        throw new Error("Target workspace mismatch; use --cwd with the original project");
    if (typeof snapshot.created !== "number" || snapshot.created > Date.now() || Date.now() - snapshot.created > TTL)
        throw new Error("Target expired; rerun the original query with --targets");
    if (!Array.isArray(snapshot.targets) || snapshot.targets.length > MAX_TARGETS)
        throw new Error("Invalid target snapshot");
    const target = object(snapshot.targets[Number(match[2])]);
    if (typeof target.file !== "string" || typeof target.hash !== "string" || !Number.isSafeInteger(target.line) || !Number.isSafeInteger(target.column))
        throw new Error("Invalid target record");
    const file = realpathSync(target.file), text = readText(file);
    if (file !== target.file || hash(text) !== target.hash)
        throw new Error(`Target source changed: ${target.file}; rerun symbols/definition/references with --targets`);
    const line = Number(target.line), column = Number(target.column), sourceLine = text.split("\n")[line - 1]?.replace(/\r$/, "");
    if (line < 1 || column < 1 || sourceLine === undefined || column > sourceLine.length + 1 || /^[\uDC00-\uDFFF]/.test(sourceLine.slice(column - 1)))
        throw new Error("Invalid target position; request a fresh result with --targets");
    return { ...args, target: undefined, file, line, column };
}
export function attachTargets(args, data) {
    if (!args.targets)
        return data;
    const result = structuredClone(data), entries = [], visible = [], sources = new Map();
    const positions = new Map(), id = randomBytes(12).toString("base64url");
    let omitted = 0, sourceBytes = 0;
    const visit = (value, path, inheritedFile) => {
        if (Array.isArray(value)) {
            value.forEach((item, index) => visit(item, `${path}.${index}`, inheritedFile));
            return;
        }
        if (!value || typeof value !== "object")
            return;
        const row = value, source = typeof row.file === "string" ? row.file : inheritedFile;
        const start = object(object(row.range).start);
        const line = Number.isSafeInteger(row.line) ? Number(row.line) : Number.isSafeInteger(start.line) ? Number(start.line) + (start.character !== undefined ? 1 : 0) : 0;
        const column = Number.isSafeInteger(row.column) ? Number(row.column) : Number.isSafeInteger(start.character) ? Number(start.character) + 1 : Number.isSafeInteger(start.column) ? Number(start.column) : 1;
        if (source && line > 0 && column > 0 && !source.includes("://")) {
            try {
                const file = realpathSync(resolve(args.cwd, source));
                let document = sources.get(file);
                if (!document) {
                    if (sources.size >= MAX_FILES)
                        throw new Error("Target source limit");
                    const text = readText(file);
                    sourceBytes += Buffer.byteLength(text);
                    if (sourceBytes > MAX_FILE_BYTES)
                        throw new Error("Target source size limit");
                    document = { text, hash: hash(text) };
                    sources.set(file, document);
                }
                const sourceLine = document.text.split("\n")[line - 1]?.replace(/\r$/, "");
                if (sourceLine === undefined || column > sourceLine.length + 1 || /^[\uDC00-\uDFFF]/.test(sourceLine.slice(column - 1)))
                    throw new Error("Invalid position");
                const key = JSON.stringify([file, line, column]);
                let target = positions.get(key);
                if (!target) {
                    if (entries.length >= MAX_TARGETS)
                        throw new Error("Target count limit");
                    target = `t_${id}.${entries.length}`;
                    positions.set(key, target);
                    entries.push({ file, line, column, hash: document.hash });
                    visible.push({ id: target, path: path.replace(/^\./, ""), ...(typeof row.name === "string" ? { name: row.name } : {}) });
                }
                row.target = target;
            }
            catch {
                omitted++;
            }
        }
        for (const [key, child] of Object.entries(row))
            if (!["target", "workspaceEdit", "workspaceEdits", "data", "range"].includes(key) && !(key === "type" && row.provider === "tsp"))
                visit(child, path ? `${path}.${key}` : key, source);
    };
    visit(result, "");
    if (!entries.length)
        return { ...result, targets: [], ...(omitted ? { targetsHint: "Some locations have no readable current source; use their explicit file/line anchors." } : {}) };
    const root = directory();
    const snapshots = readdirSync(root).filter(name => /^[A-Za-z0-9_-]{16}\.json$/.test(name)).flatMap(name => {
        try {
            const info = lstatSync(join(root, name));
            return info.isFile() && !info.isSymbolicLink() ? [{ name, time: info.mtimeMs, bytes: info.size }] : [];
        }
        catch {
            return [];
        }
    }).sort((a, b) => a.time - b.time);
    let bytes = snapshots.reduce((sum, item) => sum + item.bytes, 0), count = snapshots.length;
    for (const item of snapshots)
        if (Date.now() - item.time > TTL || count > 15 || bytes > MAX_FILE_BYTES) {
            rmSync(join(root, item.name));
            bytes -= item.bytes;
            count--;
        }
    for (const [file, document] of sources)
        if (readText(file) !== document.text)
            throw new Error("Source changed while creating targets; retry the query");
    const encoded = JSON.stringify({ root: workspace(args.cwd), created: Date.now(), targets: entries });
    if (Buffer.byteLength(encoded) > MAX_FILE_BYTES)
        throw new Error("Target snapshot too large; reduce --limit");
    writeFileSync(join(root, id + ".json"), encoded, { flag: "wx", mode: 0o600 });
    return { ...result, targets: visible, ...(omitted ? { targetsHint: "Some locations exceed target limits or have unavailable source; use explicit anchors for those locations." } : {}) };
}
