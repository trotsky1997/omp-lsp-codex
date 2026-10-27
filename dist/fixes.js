import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { captureBaseline, serverFingerprint } from "./baseline.js";
import { applyWorkspaceEdit, atomicWrite, textChanges } from "./edits.js";
import { applyTextEditsToString } from "./omp/text-edits.js";
import { availableServers, fileServers, fileUri, gitRoot, insideWorkspace, loadConfig, MAX_FILE_BYTES, MAX_FILES, object, readText, resolveFile, uriFile } from "./config.js";
import { validRange, requestBefore, requestedActionKinds, normalizeCodeAction } from "./semantic.js";
import { changedFiles } from "./commands.js";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const UID = typeof process.getuid === "function" ? process.getuid() : undefined;
function privateStore() {
    let path = realpathSync(homedir());
    for (const part of [".cache", "codex-lsp", "plans"]) {
        path = join(path, part);
        try {
            mkdirSync(path, { mode: 0o700 });
        }
        catch (error) {
            if (object(error).code !== "EEXIST")
                throw error;
        }
        const info = lstatSync(path);
        if (!info.isDirectory() || info.isSymbolicLink() || UID !== undefined && info.uid !== UID || process.platform !== "win32" && (info.mode & (part === ".cache" ? 0o022 : 0o077)))
            throw new Error(`Unsafe fix-plan cache directory: ${path}; use an owned private directory`);
    }
    return path;
}
function ownedFile(path) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || UID !== undefined && info.uid !== UID || process.platform !== "win32" && (info.mode & 0o077) || info.size > MAX_FILE_BYTES)
        throw new Error(`Unsafe or oversized fix-plan artifact: ${path}`);
    return readFileSync(path);
}
function sourceFile(root, path) {
    if (path !== resolve(path) || !insideWorkspace(root, path) || relative(root, path).split(sep).includes(".git"))
        throw new Error(`Fix target is outside the workspace: ${path}`);
    let next = root;
    for (const part of relative(root, path).split(sep)) {
        next = join(next, part);
        if (lstatSync(next).isSymbolicLink())
            throw new Error(`Fix target contains a symlink: ${path}`);
    }
    if (realpathSync(path) !== path || !statSync(path).isFile())
        throw new Error(`Unsupported fix target: ${path}`);
    return readText(path);
}
export function validateEdits(text, edits) {
    const lines = text.split("\n");
    for (const edit of edits) {
        if (!validRange(edit.range) || typeof edit.newText !== "string" || !edit.newText.isWellFormed())
            throw new Error("Invalid fix text edit");
        for (const point of [edit.range.start, edit.range.end]) {
            const line = lines[point.line]?.replace(/\r$/, ""), unit = line?.charCodeAt(point.character);
            if (line === undefined || point.character > line.length || unit !== undefined && unit >= 0xdc00 && unit <= 0xdfff)
                throw new Error("Fix edit range is outside source or splits UTF-16");
        }
    }
    return applyTextEditsToString(text, edits);
}
export function normalizedEdits(edit) {
    if (!edit || typeof edit !== "object" || Array.isArray(edit))
        throw new Error("Invalid fix workspace edit");
    const value = object(edit);
    if (value.changes !== undefined && (!value.changes || typeof value.changes !== "object" || Array.isArray(value.changes)) || value.documentChanges !== undefined && !Array.isArray(value.documentChanges))
        throw new Error("Invalid fix workspace edit");
    if (value.changeAnnotations && Object.values(object(value.changeAnnotations)).some(item => object(item).needsConfirmation === true))
        throw new Error("Fix edit requires confirmation; use code-actions to review it individually");
    const changes = textChanges(value);
    for (const [uri, edits] of changes) {
        if (!uriFile(uri) || !Array.isArray(edits))
            throw new Error("Invalid fix edit target");
        if (edits.some(item => typeof item !== "object" || item === null || "annotationId" in item))
            throw new Error("Annotated fix edits require individual review");
    }
    return changes;
}
async function unifiedDiff(root, file, original, updated, deadline) {
    const scratch = mkdtempSync(join(privateStore(), "preview-"));
    try {
        const before = join(scratch, "before"), after = join(scratch, "after");
        writeFileSync(before, original, { mode: 0o600 });
        writeFileSync(after, updated, { mode: 0o600 });
        let diff;
        try {
            diff = (await promisify(execFile)("git", ["-c", "diff.autoRefreshIndex=false", "diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--", before, after], { encoding: "utf8", maxBuffer: MAX_FILE_BYTES, timeout: Math.max(1, deadline - Date.now()), killSignal: "SIGKILL", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })).stdout;
        }
        catch (error) {
            const e = error;
            if (e.code !== 1 || typeof e.stdout !== "string")
                throw error;
            diff = e.stdout;
        }
        const name = relative(root, file).split(sep).join("/");
        return diff.replace(/^diff --git .*\n/, "").replace(/^--- .*$/m, `--- a/${name}`).replace(/^\+\+\+ .*$/m, `+++ b/${name}`);
    }
    finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}
function planDestination(args) {
    if (!args.plan || extname(args.plan).toLowerCase() !== ".json")
        throw new Error("Fix plans require --plan PATH.json");
    const path = resolve(args.cwd, args.plan), parent = realpathSync(dirname(path));
    const destination = join(parent, basename(path));
    if (existsSync(destination))
        throw new Error(`Fix plan destination already exists: ${destination}; choose a new artifact path`);
    return destination;
}
function checkGuards(guards = []) {
    if (!Array.isArray(guards) || guards.length > MAX_FILES)
        throw new Error("Invalid edit-plan configuration guards");
    const seen = new Set();
    for (const guard of guards) {
        if (typeof guard?.file !== "string" || guard.file !== resolve(guard.file) || seen.has(guard.file) || guard.sha256 !== null && (typeof guard.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(guard.sha256)))
            throw new Error("Invalid edit-plan configuration guard");
        seen.add(guard.file);
        if (guard.sha256 === null) {
            try {
                lstatSync(guard.file);
            }
            catch (error) {
                if (object(error).code === "ENOENT")
                    continue;
                throw error;
            }
            throw new Error(`Configuration changed since edit planning: ${guard.file}; generate a fresh plan`);
        }
        if (!existsSync(guard.file))
            throw new Error(`Configuration changed since edit planning: ${guard.file}; generate a fresh plan`);
        const info = lstatSync(guard.file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES || realpathSync(guard.file) !== guard.file || hash(readFileSync(guard.file)) !== guard.sha256)
            throw new Error(`Configuration changed since edit planning: ${guard.file}; generate a fresh plan`);
    }
}
async function persistPlan(args, plan, destination) {
    if (destination && plan.files.some(file => file.file === destination))
        throw new Error("Edit plan cannot overwrite analyzed source");
    checkGuards(plan.guards);
    for (const file of plan.files)
        if (sourceFile(plan.root, file.file) !== file.original)
            throw new Error(`Source changed during edit planning: ${file.file}`);
    const edited = plan.files.filter(file => file.original !== file.updated), shown = args.limit ? edited.slice(0, args.limit) : edited;
    if (!edited.length)
        return { data: { success: true, applied: false, saved: false, complete: !plan.skipped.length, actions: plan.actions, skipped: plan.skipped, files: [], total: 0 }, human: "No text changes; no plan was written." };
    if (destination) {
        if (!plan.baseline && !plan.verification)
            throw new Error("Edit plans require a post-apply verification provider");
        const bytes = Buffer.from(JSON.stringify(plan, null, 2) + "\n");
        if (bytes.length > MAX_FILE_BYTES)
            throw new Error("Edit plan exceeds 16 MiB; narrow the source scope");
        const receiptPath = join(privateStore(), plan.id + ".json"), receipt = { digest: hash(bytes), root: plan.root, path: destination, state: "planned" };
        writeFileSync(receiptPath, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
        try {
            writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
        }
        catch (error) {
            rmSync(receiptPath, { force: true });
            throw error;
        }
    }
    return { data: { success: true, applied: false, saved: !!destination, ...(destination ? { plan: destination, id: plan.id } : {}), kind: plan.kind, complete: !plan.skipped.length, actions: plan.actions, skipped: plan.skipped, total: edited.length, shown: shown.length, truncated: shown.length < edited.length, files: shown.map(({ file, edits, diff }) => ({ file, editCount: edits.length, diff })), hint: destination ? "Review the plan diff, then run codex-lsp apply --plan PATH. Source and configuration hashes are checked before applying." : "Preview only. Add --plan PATH.json to save a reviewed, source-bound edit plan." }, human: [destination ? `Edit plan saved: ${destination}` : "Edit preview:", ...shown.map(file => file.diff), destination ? "Review, then run codex-lsp apply --plan PATH." : "Add --plan PATH.json to save this preview."].join("\n") };
}
export async function saveEditPlan(args, input) {
    if (args.apply)
        throw new Error("Review edits with --plan PATH.json, then use apply --plan PATH.json");
    if (!input || typeof input.kind !== "string" || !input.kind || !Array.isArray(input.files) || input.files.length > MAX_FILES)
        throw new Error("Invalid edit-plan input or scope exceeds 200 files");
    if (input.verification !== undefined && (!input.verification || typeof input.verification !== "object" || Array.isArray(input.verification)))
        throw new Error("Invalid edit-plan verification provider");
    const destination = args.plan ? planDestination(args) : undefined, root = realpathSync(gitRoot(args.cwd)), deadline = Date.now() + args.timeout, files = [], seen = new Set();
    let snapshotBytes = 0;
    for (const source of input.files) {
        if (typeof source?.file !== "string" || seen.has(source.file) || typeof source.original !== "string" || typeof source.updated !== "string" || !source.updated.isWellFormed())
            throw new Error("Invalid or duplicate edit-plan source");
        seen.add(source.file);
        const actual = sourceFile(root, source.file);
        if (actual !== source.original)
            throw new Error(`Source changed during edit planning: ${source.file}`);
        snapshotBytes += Buffer.byteLength(source.original) + Buffer.byteLength(source.updated);
        if (snapshotBytes > MAX_FILE_BYTES)
            throw new Error("Edit source snapshots exceed 16 MiB; narrow the source scope");
        const lines = actual.split("\n"), edits = actual === source.updated ? [] : [{ range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1).length } }, newText: source.updated }];
        if (validateEdits(actual, edits) !== source.updated)
            throw new Error("Edit plan does not match its source preview");
        files.push({ ...source, sha256: hash(actual), edits, version: 1, diff: actual === source.updated ? "" : await unifiedDiff(root, source.file, actual, source.updated, deadline) });
    }
    return persistPlan(args, { schema: 1, id: randomUUID(), root, createdAt: new Date().toISOString(), kind: input.kind, files, actions: input.actions ?? [], skipped: input.skipped ?? [], ...(input.baseline ? { baseline: input.baseline } : {}), ...(input.verification ? { verification: input.verification } : {}), ...(input.guards ? { guards: input.guards } : {}) }, destination);
}
export async function fixPlan(args, acquire) {
    if (args.apply || args.file && args.changed || !args.file && !args.changed)
        throw new Error("Use fix --file PATH or fix --changed with --plan PATH.json; apply the reviewed plan separately");
    if (args.query !== undefined && (!args.file || !args.query.trim()))
        throw new Error("Choose a fix with --file PATH --query INDEX|TITLE; changed-file indexes are ambiguous");
    const destination = planDestination(args), root = realpathSync(gitRoot(args.cwd)), kind = args.kind ?? "source.fixAll", deadline = Date.now() + args.timeout;
    if (!(kind === "quickfix" || kind.startsWith("quickfix.") || kind === "source.fixAll" || kind.startsWith("source.fixAll.")))
        throw new Error("fix supports source.fixAll or quickfix kinds; use code-actions for refactors");
    const paths = args.file ? [resolveFile(args.file, args.cwd)] : (await changedFiles(args.cwd)).filter(path => path !== destination);
    if (paths.length > MAX_FILES)
        throw new Error("Fix scope exceeds 200 files; narrow the changed file set");
    const contexts = new Map(), records = new Map(), originals = new Map();
    const changes = new Map(), actions = [], skipped = [], fingerprints = new Set();
    let snapshotBytes = 0, resolves = 0;
    const context = async (file) => {
        if (contexts.has(file))
            return contexts.get(file);
        if (contexts.size >= MAX_FILES)
            throw new Error("Fix scope exceeds 200 files");
        const text = sourceFile(root, file);
        snapshotBytes += Buffer.byteLength(text);
        if (snapshotBytes > MAX_FILE_BYTES)
            throw new Error("Fix source snapshots exceed 16 MiB; narrow the source scope");
        const value = await acquire(file);
        if (value.path !== file || value.text !== text || readText(file) !== text)
            throw new Error(`Source changed during fix analysis: ${file}`);
        const diagnostics = await value.client.getDiagnostics(value.uri);
        if (!diagnostics.verified)
            throw new Error(`Unverified diagnostics for ${file}; run doctor and retry`);
        contexts.set(file, value);
        originals.set(file, text);
        fingerprints.add(serverFingerprint(value.server));
        records.set(file, { file, diagnostics: diagnostics.diagnostics, verified: true, errors: [] });
        return value;
    };
    for (const file of paths) {
        if (Date.now() >= deadline)
            throw new Error("Fix analysis deadline exceeded; narrow scope or increase --timeout");
        if (!fileServers(availableServers(loadConfig(dirname(file), args.globalConfigOnly), dirname(file), args.globalBinsOnly), file).length) {
            skipped.push({ file, reason: "No available language server matches this file; use status --file PATH or setup LANGUAGE" });
            continue;
        }
        const current = await context(file);
        if (!current.client.capabilities.codeActionProvider) {
            skipped.push({ file, reason: "Code actions are unavailable", provider: current.server.resolvedCommand });
            continue;
        }
        const lines = current.text.split("\n"), diagnosticItems = records.get(file).diagnostics;
        const selectionRange = `1:1-${lines.length}:${lines.at(-1).replace(/\r$/, "").length + 1}`;
        const response = await requestBefore(current.client, "textDocument/codeAction", { textDocument: { uri: current.uri }, range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1).replace(/\r$/, "").length } }, context: { diagnostics: diagnosticItems, only: requestedActionKinds(current.client, kind), triggerKind: 1 } }, deadline);
        if (response !== null && !Array.isArray(response))
            throw new Error(`Invalid code actions from ${current.server.name}`);
        if (Array.isArray(response) && response.length > MAX_FILES)
            throw new Error("Fix action list exceeds 200 actions; narrow the source scope with code-actions");
        const candidates = [];
        for (const [index, raw] of (response ?? []).entries()) {
            let action = object(raw);
            if (typeof action.title !== "string")
                throw new Error(`Invalid code action from ${current.server.name}`);
            if (!action.kind || !(action.kind === kind || action.kind.startsWith(kind + ".")))
                continue;
            if (!action.edit && !action.command && !action.disabled && object(current.client.capabilities.codeActionProvider).resolveProvider === true) {
                if (resolves++ >= MAX_FILES)
                    throw new Error("Fix action resolution exceeds 200 requests; narrow the source scope");
                action = await requestBefore(current.client, "codeAction/resolve", action, deadline);
                if (!action || typeof action.title !== "string" || action.kind !== kind && !action.kind?.startsWith(kind + "."))
                    throw new Error("Invalid resolved fix action");
            }
            if (action.disabled || action.command || !action.edit) {
                skipped.push({ file, index, range: selectionRange, kind, title: action.title, reason: action.disabled?.reason ?? (action.command ? "Command actions require individual code-actions review" : "Action has no persistent text edit") });
                continue;
            }
            candidates.push({ action, index });
        }
        const preferred = candidates.filter(item => item.action.isPreferred === true);
        const matching = args.query === undefined ? [] : candidates.filter(({ action, index }) => /^\d+$/.test(args.query) ? index === Number(args.query) : action.title.toLowerCase().includes(args.query.toLowerCase()));
        const selected = args.query !== undefined ? matching.length === 1 ? matching : [] : kind.startsWith("quickfix") ? preferred.length === 1 ? preferred : [] : candidates.length <= 1 ? candidates : preferred.length === 1 ? preferred : [];
        if (!selected.length && (candidates.length || args.query !== undefined))
            skipped.push({ file, range: selectionRange, kind, needsSelection: true, reason: args.query !== undefined ? "Query must select one persistent text action; inspect the original indexes below" : candidates.length > 1 ? "Multiple fixes match; preview code-actions, then use fix --file PATH --query INDEX with this range and original index" : "Quickfix is not marked preferred; preview code-actions, then use fix --file PATH --query INDEX with this range and original index", actions: candidates.map(({ action, index }) => ({ index, title: action.title, preferred: !!action.isPreferred })) });
        for (const { action, index } of selected) {
            const edits = normalizedEdits(normalizeCodeAction(action, current.uri, current.text).edit);
            for (const [uri, items] of edits) {
                const path = uriFile(uri);
                await context(path);
                for (const change of action.edit?.documentChanges ?? [])
                    if ("textDocument" in change && change.textDocument.uri === uri && change.textDocument.version != null && change.textDocument.version !== contexts.get(path).client.documents.get(uri)?.version)
                        throw new Error("Fix edit document version is stale");
                const previous = changes.get(uri) ?? [], seen = new Set(previous.map(item => JSON.stringify(item)));
                if (items.some(item => item.range?.start.line === item.range?.end.line && item.range?.start.character === item.range?.end.character && previous.some(before => JSON.stringify(before.range) === JSON.stringify(item.range) && before.newText !== item.newText)))
                    throw new Error("Conflicting fix insertions at the same position; select code actions individually");
                changes.set(uri, [...previous, ...items.filter(item => { const key = JSON.stringify(item); if (seen.has(key))
                        return false; seen.add(key); return true; })]);
            }
            actions.push({ file, index, title: action.title, kind: action.kind, provider: current.server.resolvedCommand });
        }
    }
    const files = [];
    for (const [file, original] of originals) {
        const edits = changes.get(fileUri(file)) ?? [], updated = validateEdits(original, edits);
        if (Buffer.byteLength(updated) > MAX_FILE_BYTES)
            throw new Error("Updated fix source exceeds 16 MiB");
        files.push({ file, sha256: hash(original), original, updated, edits, version: contexts.get(file).client.documents.get(fileUri(file)).version, diff: original === updated ? "" : await unifiedDiff(root, file, original, updated, deadline) });
    }
    if (!files.some(file => file.original !== file.updated)) {
        const needsSelection = skipped.some(item => item.needsSelection === true);
        return { code: needsSelection ? 1 : 0, data: { success: !needsSelection, applied: false, saved: false, complete: skipped.length === 0, actions: [], skipped, files: [], total: 0, hint: "No persistent text fixes selected. Review skipped actions with code-actions; no plan was written." }, human: "No persistent text fixes selected; no plan was written. Review skipped actions with code-actions." };
    }
    const baseline = captureBaseline([...records.values()], root, [...fingerprints], originals);
    const plan = { schema: 1, id: randomUUID(), root, createdAt: new Date().toISOString(), kind, baseline, files, actions, skipped };
    return persistPlan(args, plan, destination);
}
export async function applyPlan(args, verify, preflight) {
    if (!args.plan || args.file || args.changed || args.apply)
        throw new Error("Use apply --plan PATH.json; review the saved fix plan first");
    const requested = resolve(args.cwd, args.plan), path = join(realpathSync(dirname(requested)), basename(requested));
    const bytes = ownedFile(path), value = object(JSON.parse(bytes.toString("utf8")));
    if (value.schema !== 1 || typeof value.id !== "string" || !/^[0-9a-f-]{36}$/.test(value.id) || typeof value.root !== "string" || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > MAX_FILES)
        throw new Error("Invalid fix plan; create a new plan with fix");
    const plan = value, root = realpathSync(gitRoot(args.cwd)), store = privateStore(), receiptPath = join(store, plan.id + ".json");
    if (!existsSync(receiptPath))
        throw new Error("Fix plan receipt is unavailable on this machine; generate a fresh plan");
    const receipt = JSON.parse(ownedFile(receiptPath).toString("utf8"));
    if (receipt.digest !== hash(bytes) || receipt.path !== path || receipt.root !== root || plan.root !== root)
        throw new Error("Fix plan was modified, moved or belongs to another workspace; generate a fresh plan");
    if (receipt.state !== "planned")
        throw new Error(`Fix plan is ${receipt.state}; inspect the files and generate a fresh plan before retrying`);
    if (!plan.baseline && (!plan.verification || typeof plan.verification !== "object" || Array.isArray(plan.verification)))
        throw new Error("Edit plan has no verification provider; generate a fresh plan");
    checkGuards(plan.guards);
    const documents = new Map(), changes = {}, seen = new Set();
    for (const file of plan.files) {
        if (typeof file.file !== "string" || seen.has(file.file) || typeof file.original !== "string" || typeof file.updated !== "string" || !Array.isArray(file.edits) || !Number.isSafeInteger(file.version) || file.version < 1 || hash(file.original) !== file.sha256)
            throw new Error("Invalid fix plan source snapshot");
        seen.add(file.file);
        const actual = sourceFile(root, file.file);
        if (hash(actual) !== file.sha256 || actual !== file.original)
            throw new Error(`Source changed since fix planning: ${file.file}; generate a fresh plan`);
        if (validateEdits(actual, file.edits) !== file.updated)
            throw new Error("Fix plan edits do not match their preview");
        documents.set(fileUri(file.file), { text: actual, version: file.version });
        if (file.original !== file.updated)
            changes[fileUri(file.file)] = file.edits;
    }
    if (!Object.keys(changes).length)
        throw new Error("Fix plan has no changes; generate a fresh plan");
    const lock = receiptPath + ".lock";
    let descriptor;
    try {
        descriptor = openSync(lock, "wx", 0o600);
    }
    catch (error) {
        if (object(error).code === "EEXIST")
            throw new Error("Fix plan is already being applied; inspect it before retrying");
        throw error;
    }
    const baselinePath = plan.baseline ? join(store, plan.id + ".baseline.json") : undefined;
    let applied = false;
    try {
        if (JSON.parse(ownedFile(receiptPath).toString("utf8")).state !== "planned")
            throw new Error("Fix plan state changed; generate a fresh plan");
        checkGuards(plan.guards);
        if (preflight)
            await preflight(plan.files.map(file => file.file), plan.verification, plan.baseline);
        checkGuards(plan.guards);
        if (baselinePath)
            writeFileSync(baselinePath, JSON.stringify(plan.baseline), { flag: "wx", mode: 0o600 });
        receipt.state = "applying";
        atomicWrite(receiptPath, Buffer.from(JSON.stringify(receipt)));
        const updated = await applyWorkspaceEdit({ changes }, root, documents);
        applied = updated.size > 0;
        receipt.state = "applied";
        atomicWrite(receiptPath, Buffer.from(JSON.stringify(receipt)));
        let result;
        try {
            result = await verify(plan.files.map(file => file.file), baselinePath, plan.verification);
        }
        catch (error) {
            return { code: 1, data: { success: false, applied, applicationState: "applied", plan: path, verification: "pending", [plan.baseline ? "diagnosticVerification" : "toolVerification"]: "failed", error: String(error), files: [...updated.keys()].map(uriFile), hint: "Edits were applied. Inspect files and retry verification; project build/tests are still pending." }, human: `Edits applied; verification failed: ${error}. Inspect files before retrying.` };
        }
        if (!plan.baseline) {
            const verified = result.data.verified === true, success = verified && result.data.hasErrors === false && (result.code ?? 0) === 0;
            return { code: success ? 0 : 1, data: { success, applied, applicationState: "applied", plan: path, verification: "pending", toolVerification: verified ? "verified" : "unverified", ...(result.data.comparison !== undefined ? { comparison: result.data.comparison } : {}), toolResults: result.data, files: [...updated.keys()].map(uriFile), hint: "Edits applied. Review tool verification and run relevant project build/tests; the plan is single-use." }, human: `Applied ${updated.size} file(s). Tool verification: ${verified ? success ? "passed" : "failed" : "unverified"}. Project build/tests pending.` };
        }
        const comparison = object(result.data.comparison), verified = result.data.verified === true && comparison.verified === true;
        const success = verified && comparison.newErrors === 0;
        return { code: success ? 0 : 1, data: { success, applied, applicationState: "applied", plan: path, verification: "pending", diagnosticVerification: verified ? "verified" : "unverified", comparison, diagnostics: result.data, files: [...updated.keys()].map(uriFile), hint: "Edits applied. Review diagnostic differences and run relevant project build/tests; the plan is single-use." }, human: `Applied ${updated.size} file(s). Diagnostics: ${verified ? JSON.stringify(comparison.counts) : "unverified"}. Project build/tests pending.` };
    }
    catch (error) {
        if (receipt.state === "applying") {
            receipt.state = "failed";
            try {
                atomicWrite(receiptPath, Buffer.from(JSON.stringify(receipt)));
            }
            catch (stateError) {
                error = new Error(`${error}; fix-plan state could not be saved: ${stateError}`);
            }
        }
        if (applied)
            return { code: 1, data: { success: false, applied: true, applicationState: "applied", verification: "pending", error: String(error), hint: "Edits were applied; inspect files before retrying." }, human: `Edits were applied: ${error}` };
        const states = plan.files.filter(file => file.original !== file.updated).map(file => { let current; try {
            current = readText(file.file);
        }
        catch { /* A concurrent removal remains visible as changed. */ } return { file: file.file, state: current === file.original ? "original" : current === file.updated ? "planned" : "changed" }; });
        if (states.some(file => file.state !== "original"))
            return { code: 1, data: { success: false, applied: null, applicationState: "failed", verification: "pending", error: String(error), files: states, hint: "Application failed; inspect the reported file states before retrying. Concurrent changes were preserved." }, human: `Fix application failed: ${error}; inspect file states before retrying.` };
        throw error;
    }
    finally {
        closeSync(descriptor);
        rmSync(lock, { force: true });
        if (baselinePath)
            rmSync(baselinePath, { force: true });
    }
}
