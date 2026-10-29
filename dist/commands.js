import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import childProcess from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { LspClient } from "./client.js";
import { availableServers, configPaths, expandHome, fileServers, fileUri, gitRoot, inside, insideWorkspace, languageId, loadConfig, matchesFile, numstatFiles, MAX_FILES, MAX_FILE_BYTES, object, readOverrides, readText, resolveCommand, resolveFile, serverForLanguage, serverRoot, uriFile, workspaceSource, } from "./config.js";
import { applyWorkspaceEdit, atomicWrite, editSummary, editTextLimit, moveNoReplace, remapEdit, textChanges, } from "./edits.js";
import { findReference, symbolAt } from "./devdocs.js";
import { resolveSymbolColumn } from "./omp/symbol-column.js";
import { version } from "./version.js";
import { compactText, failure, selectFields, textPrefix } from "./output.js";
import { syntaxLanguage, syntaxLookup, syntaxPosition, syntaxSnippet, syntaxTool } from "./syntax.js";
import { batchQueries } from "./batch.js";
import { attachTargets, resolveTarget } from "./targets.js";
import { apiDiff, dependencies } from "./analysis.js";
import { applyPlan, fixPlan, validateEdits, workspaceEditPlan } from "./fixes.js";
import { inspectContext } from "./context.js";
import { callHierarchy, complete, normalizeCodeAction, requestedActionKinds } from "./semantic.js";
import { captureBaseline, compareBaseline, loadBaseline, saveBaseline, serverFingerprint } from "./baseline.js";
import { impactAnalysis } from "./impact.js";
import { typeHierarchy, inlayHints, unsupportedFeature } from "./type-hints.js";
import { firstPage, nextPage } from "./pagination.js";
import { budgetData } from "./budget.js";
import { combinedPlan, declaredTools, runTooling, validateToolPlan, verifyToolPlan } from "./tooling.js";
import { queryType, typeServerVersion } from "./tsp.js";
import { typescriptFile, typescriptTypes } from "./typescript-api.js";
export function outputData(data, args) {
    const selected = args.fields ? selectFields(data, args.fields) : data;
    return args.budget === undefined ? selected : budgetData(selected, args.budget);
}
function outputInfo(total, limit) {
    const shown = limit ? Math.min(total, limit) : total, truncated = shown < total;
    return { total, shown, truncated, ...(truncated ? { hint: `Showing ${shown} of ${total}. Use --limit 0 for the complete result; redirect --json output to a file for large results.` } : {}) };
}
function locationLines(items, root, named = false) {
    const groups = new Map();
    for (const item of items) {
        const file = typeof item.file === "string" ? item.file : "(location unavailable)";
        const path = isAbsolute(file) && inside(root, file) ? relative(root, file) || "." : file;
        const point = item.line === undefined ? "?" : `${item.line}:${item.column}`;
        if (!groups.has(path))
            groups.set(path, []);
        groups.get(path).push(named ? `${item.name}@${point}` : point);
    }
    return [...groups].map(([file, points]) => `${file}:${points.join(", ")}`);
}
function signatureHelp(value, server, limit, cursor) {
    const response = object(value);
    if (value !== null && (!Array.isArray(response.signatures) || response.signatures.some(item => typeof object(item).label !== "string")))
        throw new Error(`Invalid signature help response from ${server}`);
    const signatures = (response.signatures ?? []);
    const index = (value, count) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < count ? Number(value) : 0;
    const activeSignature = index(response.activeSignature, signatures.length), active = signatures[activeSignature];
    const parameters = Array.isArray(active?.parameters) ? active.parameters : [];
    const activeParameter = parameters.length ? index(active?.activeParameter ?? response.activeParameter, parameters.length) : null;
    const parameter = activeParameter === null ? undefined : object(parameters[activeParameter]).label;
    const activeLabel = String(active?.label ?? "");
    let activeParameterLabel = null;
    if (typeof parameter === "string")
        activeParameterLabel = parameter;
    else if (Array.isArray(parameter) && parameter.length === 2 && parameter.every(Number.isSafeInteger) && parameter[0] >= 0 && parameter[1] >= parameter[0] && parameter[1] <= activeLabel.length && parameter.every(offset => !(activeLabel.charCodeAt(offset) >= 0xdc00 && activeLabel.charCodeAt(offset) <= 0xdfff)))
        activeParameterLabel = activeLabel.slice(parameter[0], parameter[1]);
    const summary = outputInfo(signatures.length, limit);
    const indexes = signatures.map((_, index) => index);
    if (limit && signatures.length)
        indexes.unshift(...indexes.splice(activeSignature, 1));
    let remaining = limit ? 6000 : Infinity, textTruncated = false;
    const selected = indexes.slice(0, summary.shown).map(index => {
        const signature = signatures[index], original = String(signature.label), label = textPrefix(original, remaining);
        remaining -= label.length;
        textTruncated ||= label.length < original.length;
        return limit ? { index, label } : { ...signature, index, label };
    });
    if (limit && activeParameterLabel) {
        const preview = textPrefix(activeParameterLabel, 1000);
        textTruncated ||= preview.length < activeParameterLabel.length;
        activeParameterLabel = preview;
    }
    const documentationOmitted = !!limit && signatures.some(signature => signature.documentation !== undefined || (Array.isArray(signature.parameters) && signature.parameters.some(parameter => object(parameter).documentation !== undefined)));
    const hint = !signatures.length ? cursor.automatic
        ? `Automatic argument cursor ${cursor.line}:${cursor.column}; ${server} returned no signature. Try hover or definition on the callable.`
        : "Place the cursor inside a call's arguments, just after '(' or a comma; string interiors can return no help. Try hover on the callable if still empty." : summary.truncated || documentationOmitted || textTruncated
        ? [documentationOmitted ? "Documentation omitted." : "", textTruncated ? "Signature text clipped." : "", "Use --limit 0 --json for complete signature information."].filter(Boolean).join(" ") : "";
    return {
        data: { success: true, found: !!signatures.length, server, ...summary, truncated: summary.truncated || textTruncated, activeSignature: signatures.length ? activeSignature : null, activeParameter, activeParameterLabel, signatures: selected, ...(!signatures.length ? { cursor } : {}), ...(documentationOmitted ? { documentationOmitted: true } : {}), ...(textTruncated ? { textTruncated: true } : {}), ...(hint ? { hint } : {}) },
        human: [signatures.length ? `${signatures.length} signature(s); active ${activeSignature + 1}${activeParameterLabel ? `; parameter: ${activeParameterLabel}` : ""}` : "No signature help", ...selected.map(signature => `${signature.index === activeSignature ? "*" : ""}[${signature.index + 1}] ${signature.label}`), hint].filter(Boolean).join("\n"),
    };
}
const VERIFY_EDITS = "Project verification pending. Run relevant build/tests; use code-actions for missing imports or re-exports if checks fail.";
const UNVERIFIED_DIAGNOSTICS = "Unable to verify diagnostics for the current file. Run codex-lsp doctor --file <source-file> and retry after analysis and file changes settle (--timeout 120).";
function editVerification(applied, hint) {
    return applied ? { verification: "pending", hint: [hint, VERIFY_EDITS].filter(Boolean).join(" ") } : {};
}
const READ_ONLY = new Set([
    "textDocument/definition",
    "textDocument/declaration",
    "textDocument/typeDefinition",
    "textDocument/implementation",
    "textDocument/references",
    "textDocument/hover",
    "textDocument/signatureHelp",
    "textDocument/documentSymbol",
    "textDocument/codeAction",
    "workspace/symbol",
    "workspace/diagnostic",
    "textDocument/diagnostic",
    "textDocument/semanticTokens/full",
    "textDocument/prepareCallHierarchy", "callHierarchy/incomingCalls", "callHierarchy/outgoingCalls",
    "textDocument/completion", "completionItem/resolve",
    "textDocument/prepareTypeHierarchy", "typeHierarchy/supertypes", "typeHierarchy/subtypes",
    "textDocument/inlayHint", "inlayHint/resolve", "codeAction/resolve",
    "textDocument/formatting", "textDocument/rangeFormatting",
    "typeServer/getSupportedProtocolVersion", "typeServer/getSnapshot", "typeServer/getComputedType",
    "typeServer/getDeclaredType", "typeServer/getExpectedType", "typeServer/getPythonSearchPaths", "typeServer/resolveImport",
]);
const NAVIGATION = {
    definition: "textDocument/definition",
    references: "textDocument/references",
    hover: "textDocument/hover",
    "signature-help": "textDocument/signatureHelp",
    "type-definition": "textDocument/typeDefinition",
    implementation: "textDocument/implementation",
};
const POSITION_METHODS = new Set([...Object.values(NAVIGATION), "textDocument/declaration", "textDocument/signatureHelp", "textDocument/prepareCallHierarchy", "textDocument/prepareTypeHierarchy", "textDocument/completion"]);
export async function sessionClient(server, args, session) {
    const key = JSON.stringify(server);
    let client = session?.clients.get(key);
    if (client && !client.reusable) {
        await client.close();
        session.clients.delete(key);
        client = undefined;
    }
    if (!client) {
        if (session && session.clients.size >= 8) {
            const [oldest, previous] = session.clients.entries().next().value;
            await previous.close();
            session.clients.delete(oldest);
        }
        client = await LspClient.start(server, args.timeout, args.apply);
    }
    if (session) {
        session.clients.delete(key);
        session.clients.set(key, client);
    }
    return client;
}
function compilerDiagnostics(server) {
    return server.name === "rust-analyzer" ? {
        ...server, settings: { ...server.settings,
            "rust-analyzer": { ...object(server.settings?.["rust-analyzer"]), checkOnSave: true },
        },
    } : server;
}
function validateFixProviders(baseline, args) {
    if (!Array.isArray(baseline.servers) || !baseline.servers.length || !Array.isArray(baseline.files))
        throw new Error("Invalid fix-plan provider baseline");
    const expected = new Set(baseline.servers), found = new Set();
    for (const { file } of baseline.files) {
        const matches = fileServers(availableServers(loadConfig(dirname(file), args.globalConfigOnly), dirname(file), args.globalBinsOnly), file)
            .map(server => serverFingerprint(compilerDiagnostics(server))).filter(value => expected.has(value));
        if (!matches.length)
            throw new Error(`Fix provider configuration changed for ${file}; generate a fresh plan using the same configuration flags`);
        matches.forEach(value => found.add(value));
    }
    if ([...expected].some(value => !found.has(value)))
        throw new Error("Fix provider configuration changed; generate a fresh plan");
}
async function fileContext(args, semantic = true, session) {
    if (!args.file)
        throw new Error("--file is required");
    const path = resolveFile(args.file, args.cwd);
    let server = fileServers(availableServers(loadConfig(dirname(path), args.globalConfigOnly), dirname(path), args.globalBinsOnly, args.command === "types" || args.method?.startsWith("typeServer/") ? args.server ? "all" : "tsp" : "lsp"), path).find(server => !args.server || server.name === args.server);
    if (!server && args.command === "types") {
        const hint = /\.pyi?$/i.test(path)
            ? "install with uv tool install pyrefly, then run codex-lsp setup pyrefly-tsp. Official documentation: https://pyrefly.org/blog/pyrefly-pylance/"
            : "use hover or type-definition for this language, or configure a TSP provider matching its file type";
        throw new Error(`No available TSP server${args.server ? ` named ${args.server}` : ""} matches ${path}; ${hint}`);
    }
    if (!server)
        throw new Error(`No available language server${args.server ? ` named ${args.server}` : ""} matches ${path}; run codex-lsp setup <language> --project from the project root`);
    if (args.command === "inspect" || session?.diagnostics)
        server = compilerDiagnostics(server);
    const client = await sessionClient(server, args, session);
    try {
        const opened = await client.open(path);
        if (semantic || server.name !== "rust-analyzer")
            await client.ready(opened.uri);
        return { server, path, client, ...opened };
    }
    catch (error) {
        await client.close();
        throw error;
    }
}
export async function position(path, text, args) {
    const lines = text.split("\n").map(line => line.endsWith("\r") ? line.slice(0, -1) : line);
    if (!Number.isInteger(args.line) || args.line < 1 || args.line > lines.length)
        throw new Error(`Line ${args.line} is outside this file; valid lines: 1-${lines.length}`);
    const syntax = args.column === undefined || args.symbol
        ? await syntaxPosition(path, text, args.line, args.symbol, args.command === "signature-help" && args.column === undefined, args.globalBinsOnly)
        : undefined;
    const character = syntax?.character ?? (args.symbol
        ? await resolveSymbolColumn(path, args.line, args.symbol)
        : args.column === undefined
            ? lines[args.line - 1].search(/\S/) < 0
                ? 0
                : lines[args.line - 1].search(/\S/)
            : args.column - 1);
    const targetLine = syntax?.line ?? args.line - 1;
    if (!Number.isInteger(character) || character < 0 || character > lines[targetLine].length)
        throw new Error(`Column ${character + 1} is outside line ${targetLine + 1}; valid columns: 1-${lines[targetLine].length + 1} (UTF-16). Use --symbol NAME for a token anchor.`);
    const unit = lines[targetLine].charCodeAt(character);
    if (unit >= 0xdc00 && unit <= 0xdfff)
        throw new Error(`Column ${character + 1} on line ${targetLine + 1} splits a UTF-16 surrogate pair; use column ${character} or ${character + 2}.`);
    return syntax ?? { line: args.line - 1, character };
}
async function snippet(args) {
    if (args.apply)
        throw new Error("snippet is read-only; omit --apply");
    if (!args.file)
        throw new Error("--file is required");
    const path = resolveFile(args.file, args.cwd), text = readText(path);
    const pos = await position(path, text, { line: args.line, column: args.column });
    const selected = await syntaxSnippet(path, text, args.line, pos.character + 1, args.symbol, args.globalBinsOnly);
    const lines = selected.text.split("\n"), summary = outputInfo(lines.length, args.limit);
    const preview = lines.slice(0, summary.shown).join("\n"), code = args.limit ? textPrefix(preview, 6000) : preview;
    summary.truncated ||= code.length < preview.length;
    summary.shown = code.split("\n").length;
    const range = { start: { line: selected.start.line + 1, column: selected.start.character + 1 },
        end: { line: selected.end.line + 1, column: selected.end.character + 1 } };
    const hint = summary.truncated ? "Snippet clipped; use --limit 0 for the complete declaration." : undefined;
    return { data: { success: true, found: true, provider: "ast-grep", file: path, range, snippet: code, ...summary,
            characters: { total: selected.text.length, shown: code.length }, ...(hint ? { hint } : {}) },
        human: [`${path}:${range.start.line}:${range.start.column}`,
            hint ? `Preview: ${summary.shown}/${summary.total} lines, ${code.length}/${selected.text.length} characters. ${hint}` : undefined,
            code].filter(Boolean).join("\n") };
}
export function location(value) {
    const entry = object(value), uri = entry.uri ?? entry.targetUri;
    const range = object(entry.range ?? entry.targetSelectionRange ?? entry.targetRange), start = object(range.start);
    if (typeof uri !== "string" ||
        !Number.isInteger(start.line) || Number(start.line) < 0 ||
        !Number.isInteger(start.character) || Number(start.character) < 0)
        return;
    const path = uriFile(uri);
    return {
        file: path && existsSync(path) ? realpathSync(path) : (path ?? uri),
        line: Number(start.line) + 1,
        column: Number(start.character) + 1,
    };
}
export function formatSymbols(values, uri = "", container) {
    if (!Array.isArray(values))
        return [];
    return values.flatMap((value) => {
        const item = object(value), range = item.selectionRange ?? item.range;
        const point = location(item.location ?? { uri, range }) ?? {};
        const name = String(item.name ?? "");
        return [
            { name, kind: Number.isSafeInteger(item.kind) ? item.kind : undefined, container: typeof item.containerName === "string" ? item.containerName : container ?? null, ...point },
            ...formatSymbols(item.children, uri, name),
        ];
    });
}
function hoverText(value) {
    if (typeof value === "string")
        return value;
    if (Array.isArray(value))
        return value.map(hoverText).filter(Boolean).join("\n\n");
    return typeof object(value).value === "string" ? String(object(value).value) : "";
}
async function navigate(args, shared, session) {
    const { server, path, client, uri, text } = shared ?? await fileContext(args, true, session);
    try {
        const pos = await position(path, text, args), method = NAVIGATION[args.command];
        const anchor = () => {
            if (!args.targets)
                return {};
            if (readText(path) !== text)
                throw new Error("Source changed while querying targets; rerun with a current anchor");
            return { file: path, cursor: { line: pos.line + 1, column: pos.character + 1 } };
        };
        const params = {
            textDocument: { uri },
            position: pos,
            ...(args.command === "references" ? { context: { includeDeclaration: true } } : {}),
        };
        const deadline = Date.now() + args.timeout;
        const knownReady = ["rust-analyzer", "pyright", "basedpyright"].includes(server.name);
        let result, content = "", locations = [], delay = 100;
        let timedOut = false;
        let checkedAnalysis = false;
        while (true) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                timedOut = true;
                break;
            }
            try {
                result = await client.request(method, params, remaining);
            }
            catch (error) {
                if (object(error).code === -32601)
                    return unsupportedFeature(client, { "type-definition": "typeDefinitionProvider", "signature-help": "signatureHelpProvider" }[args.command] ?? `${args.command}Provider`);
                if (Date.now() >= deadline && String(error).includes(`LSP request ${method} timed out after`)) {
                    timedOut = true;
                    break;
                }
                if (/Content\s*Modified|-32801/i.test(String(error))) {
                    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
                    continue;
                }
                throw error;
            }
            if (args.command === "hover")
                content = hoverText(object(result).contents);
            else if (args.command !== "signature-help")
                locations = (Array.isArray(result) ? result : [result])
                    .map(location)
                    .filter((x) => !!x);
            if (content.trim() ||
                locations.length ||
                args.command === "signature-help" ||
                knownReady ||
                !symbolAt(text, pos.line, pos.character))
                break;
            if (!checkedAnalysis) {
                checkedAnalysis = true;
                if ((await client.getDiagnostics(uri, Math.max(1, deadline - Date.now()))).verified)
                    break;
            }
            await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
            delay = Math.min(delay * 2, 500);
        }
        if (args.command === "hover") {
            let provider = "lsp";
            if (!content.trim()) {
                const reference = await findReference(languageId(server, path), symbolAt(text, pos.line, pos.character) ?? "", Math.min(args.timeout, 3000));
                if (reference) {
                    content = reference;
                    provider = "devdocs";
                }
            }
            if (timedOut && !content.trim())
                throw new Error(`Timed out waiting for hover information from ${server.name}`);
            const found = !!content.trim(), lines = found ? content.split("\n") : [], summary = outputInfo(lines.length, args.limit);
            const originalCharacters = content.length, preview = lines.slice(0, summary.shown).join("\n");
            content = args.limit ? textPrefix(preview, 6000) : preview;
            if (content.length < preview.length) {
                summary.shown = content ? content.split("\n").length : 0;
                summary.truncated = true;
                summary.hint = `Hover text clipped (${content.length}/${originalCharacters} characters); use --limit 0 for complete output.`;
            }
            return {
                data: {
                    success: true,
                    found,
                    server: server.name,
                    provider,
                    hover: content,
                    ...summary,
                    ...anchor(),
                    ...(content.length < preview.length ? { characters: { total: originalCharacters, shown: content.length } } : {}),
                },
                human: [content.trim() ? content : found ? "Hover information found." : "No hover information", summary.hint].filter(Boolean).join("\n"),
            };
        }
        if (timedOut)
            throw new Error(`Timed out waiting for ${args.command} from ${server.name}`);
        const sourceAnchor = anchor();
        if (args.command === "signature-help") {
            const signature = signatureHelp(result, server.name, args.limit, {
                line: pos.line + 1, column: pos.character + 1, automatic: args.column === undefined && !!syntaxLanguage(path),
            });
            return { ...signature, data: { ...sourceAnchor, ...signature.data } };
        }
        if (args.pageSize !== undefined) {
            const data = firstPage({ cwd: args.cwd, sourceFile: path, sourceText: text, pageSize: args.pageSize }, { success: true, found: !!locations.length, server: server.name, locations });
            return { data, human: [`References: ${data.shown} of ${data.total} (snapshot page)`, ...locationLines(data.locations, gitRoot(server.root)), data.hint,
                    ...(data.nextCursor ? [`Next: codex-lsp next --cursor ${data.nextCursor}`] : [])].filter(Boolean).join("\n") };
        }
        const summary = outputInfo(locations.length, args.limit);
        locations = locations.slice(0, summary.shown);
        return {
            data: { success: true, found: !!summary.total, server: server.name, ...summary, locations },
            human: locations.length
                ? [`Found ${summary.total} ${args.command}(s):`,
                    ...(!shared ? [`Root: ${gitRoot(server.root)}`] : []), ...locationLines(locations, gitRoot(server.root)), summary.hint].filter(Boolean).join("\n")
                : `No ${args.command} found`,
        };
    }
    finally {
        if (!shared && !session)
            await client.close();
    }
}
function prioritizeSymbols(items, query) {
    if (!query)
        return;
    const lower = query.toLowerCase(), rank = (item) => item.name === query ? 0 : String(item.name).toLowerCase() === lower ? 1 : 2;
    items.sort((a, b) => rank(a) - rank(b));
}
async function symbols(args, shared, session) {
    if (!args.workspace) {
        const { server, client, uri } = shared ?? await fileContext(args, false, session);
        try {
            let items = formatSymbols(await client.request("textDocument/documentSymbol", { textDocument: { uri } }), uri);
            if (args.query)
                items = items.filter((x) => String(x.name).toLowerCase().includes(args.query.toLowerCase()));
            prioritizeSymbols(items, args.query);
            const summary = outputInfo(items.length, args.limit);
            const { items: selected, ...preview } = compactText(items.slice(0, summary.shown), ["name", "container"], args.limit);
            const hint = preview.hint ?? (!items.length && args.query ? "Use symbols --workspace --file <path> --query <name> to search the project." : undefined);
            return {
                data: { success: true, server: server.name, ...summary, ...preview, ...(hint ? { hint } : {}), symbols: selected },
                human: [items.length
                        ? [...(!shared ? [`Root: ${gitRoot(server.root)}`] : []), ...locationLines(selected, gitRoot(server.root), true)].join("\n")
                        : "No symbols found", summary.hint, hint].filter(Boolean).join("\n"),
            };
        }
        finally {
            if (!shared && !session)
                await client.close();
        }
    }
    if (!args.query)
        throw new Error("--query is required with --workspace");
    const path = args.file ? resolveFile(args.file, args.cwd) : undefined, cwd = path ? dirname(path) : args.cwd;
    let servers = availableServers(loadConfig(cwd, args.globalConfigOnly), cwd, args.globalBinsOnly);
    if (path)
        servers = fileServers(servers, path);
    const items = [], used = [], errors = [];
    for (const server of servers.filter((x) => !x.isLinter)) {
        let client;
        try {
            client = await sessionClient(session?.diagnostics ? compilerDiagnostics(server) : server, args, session);
            if (!client.capabilities.workspaceSymbolProvider)
                continue;
            // shortcut: one seed loads one project; discover more roots for cross-project searches.
            const source = path ?? workspaceSource(server);
            if (source) {
                const { uri } = await client.open(source);
                await client.ready(uri);
            }
            else if (server.name === "rust-analyzer")
                await client.waitWorkspace();
            items.push(...formatSymbols(await client.request("workspace/symbol", { query: args.query })));
            used.push(server.name);
        }
        catch (error) {
            errors.push({ server: server.name, ...failure(error, args.limit) });
        }
        finally {
            if (!session)
                await client?.close();
        }
    }
    if (!used.length && !errors.length)
        throw new Error("No available server supports workspace symbols; use --file to select a project");
    prioritizeSymbols(items, args.query);
    const summary = outputInfo(items.length, args.limit), { items: selected, ...preview } = compactText(items.slice(0, summary.shown), ["name", "container"], args.limit);
    return {
        data: { success: !errors.length, servers: used, ...summary, ...preview, symbols: selected, errors },
        code: errors.length ? 1 : 0,
        human: [
            ...(selected.length ? [`Root: ${gitRoot(cwd)}`, ...locationLines(selected, gitRoot(cwd), true)] : []),
            ...errors.map((x) => [`ERROR ${x.server}: ${x.error}`, x.hint].filter(Boolean).join("\n")),
            summary.hint,
            preview.hint,
        ].filter(Boolean).join("\n") || "No symbols found",
    };
}
async function rename(args, shared) {
    if (!args.newName)
        throw new Error("--new-name is required");
    if (args.plan && args.apply)
        throw new Error("Choose --plan or --apply");
    const pool = { clients: new Map(), diagnostics: !!args.plan };
    const current = shared ?? await fileContext(args, true, pool), { server, path, client, uri, text } = current;
    try {
        const edit = (await client.request("textDocument/rename", {
            textDocument: { uri },
            position: await position(path, text, args),
            newName: args.newName,
        })) ?? {};
        if (![...textChanges(edit).values()].some((x) => x.length))
            throw new Error("The language server returned no rename edits; try the symbol's declaration or check rename support");
        if (args.plan)
            return await workspaceEditPlan(args, edit, file => file === path ? Promise.resolve(current) : fileContext({ ...args, file }, true, pool), [{ file: path, kind: "rename", newName: args.newName, server: server.name }]);
        const summary = outputInfo([...textChanges(edit).values()].reduce((n, items) => n + items.length, 0), args.limit);
        const preview = editSummary(edit, summary.shown, editTextLimit([edit], summary.shown, !!args.limit)), edits = preview.lines;
        if (preview.textTruncated) {
            summary.truncated = true;
            summary.hint = [summary.hint, "Replacement text clipped; use --limit 0 --json for complete edits."].filter(Boolean).join(" ");
        }
        if (args.apply)
            await client.edit(edit);
        return {
            data: {
                success: true,
                applied: args.apply,
                server: server.name,
                ...summary,
                ...(preview.textTruncated ? { textTruncated: true } : {}),
                edits,
                ...(!args.apply ? summary.truncated ? { workspaceEditOmitted: true } : { workspaceEdit: edit } : {}),
                ...editVerification(args.apply, summary.hint),
            },
            human: [`${args.apply ? "Applied rename" : "Rename preview"}:\n${edits.join("\n")}`, summary.hint, args.apply ? VERIFY_EDITS : undefined].filter(Boolean).join("\n"),
        };
    }
    catch (error) {
        if (server.name === "rust-analyzer" && object(error).code === -32602 && /No references found/i.test(String(error)))
            throw new Error(`${error instanceof Error ? error.message : String(error)}. Check Cargo target membership with cargo metadata --no-deps --format-version 1; confirm the file is in a target with the required features, then retry at the symbol declaration.`, { cause: error });
        throw error;
    }
    finally {
        if (!shared)
            await Promise.allSettled([...pool.clients.values()].map(client => client.close()));
    }
}
async function codeActions(args, session) {
    if (args.plan && (args.apply || session))
        throw new Error("Save code-action plans outside read-only sessions, then use apply --plan");
    const pool = session ?? { clients: new Map(), diagnostics: !!args.plan };
    const current = await fileContext(args, true, pool), { server, path, client, uri, text } = current;
    let edited = false;
    let editFailure;
    try {
        const pos = args.range?.start ?? await position(path, text, args);
        let diagnostics = client.diagnostics.get(uri) ?? [];
        if (client.capabilities.diagnosticProvider && server.name !== "rust-analyzer")
            diagnostics = (await client.getDiagnostics(uri)).diagnostics;
        else if (server.name !== "rust-analyzer" && !client.diagnostics.has(uri)) {
            try {
                diagnostics = await client.waitDiagnostics(uri, Math.min(args.timeout, 1000));
            }
            catch { /* Actions can be available without published diagnostics. */ }
        }
        const actionRange = args.range ?? (args.column === undefined && !args.symbol
            ? { start: { line: pos.line, character: 0 }, end: { line: pos.line, character: text.split("\n")[pos.line].replace(/\r$/, "").length } }
            : { start: pos, end: pos });
        const actions = (await client.request("textDocument/codeAction", {
            textDocument: { uri },
            range: actionRange,
            context: { diagnostics, triggerKind: 1, ...(args.kind ? { only: requestedActionKinds(client, args.kind) } : {}) },
        })) ?? [];
        const invalidAction = (item) => {
            const row = object(item);
            return typeof row.title !== "string" || (row.kind !== undefined && typeof row.kind !== "string") || (row.disabled != null && typeof object(row.disabled).reason !== "string");
        };
        if (!Array.isArray(actions) || actions.some(invalidAction))
            throw new Error(`Invalid code action response from ${server.name}`);
        const matches = actions.map((action, index) => ({ action, index })).filter(({ action, index }) => (!args.kind || "kind" in action && typeof action.kind === "string" && (action.kind === args.kind || action.kind.startsWith(args.kind + "."))) &&
            (!args.query || (/^\d+$/.test(args.query) ? index === Number(args.query) : action.title.toLowerCase().includes(args.query.toLowerCase()))));
        if (args.apply && matches.length > 1)
            throw new Error("Multiple code actions match; choose the original index with --query INDEX");
        let chosen = args.query && matches.length === 1 ? matches[0].action : undefined;
        if (chosen && !("disabled" in chosen && chosen.disabled) && !("edit" in chosen) && !("command" in chosen) && object(client.capabilities.codeActionProvider).resolveProvider === true) {
            chosen = await client.request("codeAction/resolve", chosen);
            if (invalidAction(chosen))
                throw new Error(`Invalid resolved code action from ${server.name}`);
        }
        if (chosen && "kind" in chosen)
            chosen = normalizeCodeAction(chosen, uri, text);
        if (args.plan) {
            if (!args.query || matches.length !== 1 || !chosen)
                throw new Error("Save one reviewed code action with --query INDEX|TITLE --plan PATH.json");
            if ("disabled" in chosen && chosen.disabled)
                throw new Error(chosen.disabled.reason);
            if (chosen.command || !("edit" in chosen) || !chosen.edit)
                throw new Error("Plans require pure-text edits; review server commands with code-actions --apply");
            return await workspaceEditPlan(args, chosen.edit, file => file === path ? Promise.resolve(current) : fileContext({ ...args, file }, true, pool), [{ file: path, index: matches[0].index, title: chosen.title, server: server.name }]);
        }
        if (!args.apply) {
            const items = matches
                .map(({ action, index }) => {
                const item = chosen ?? action;
                return {
                    index,
                    title: item.title,
                    kind: "kind" in item ? item.kind : undefined,
                    ...("disabled" in item && item.disabled ? { disabledReason: item.disabled.reason } : {}),
                };
            });
            const summary = outputInfo(items.length, args.limit), { items: selected, ...preview } = compactText(items.slice(0, summary.shown), ["title", "kind", "disabledReason"], args.limit);
            let editPreview;
            if (chosen && "edit" in chosen && chosen.edit) {
                const changes = textChanges(chosen.edit), total = [...changes.values()].reduce((sum, edits) => sum + edits.length, 0), info = outputInfo(total, args.limit);
                const details = editSummary(chosen.edit, info.shown, editTextLimit([chosen.edit], info.shown, !!args.limit));
                editPreview = { fileCount: changes.size, files: [...changes.keys()].slice(0, args.limit || Infinity).map(uri => uriFile(uri) ?? uri), ...info, truncated: info.truncated || details.textTruncated, edits: details.lines, ...(details.textTruncated ? { textTruncated: true, hint: "Replacement text clipped. Use --limit 0 --json for complete edits." } : {}), ...(args.limit ? { workspaceEditOmitted: true } : { workspaceEdit: chosen.edit }) };
            }
            const executesCommand = chosen ? !!chosen.command : undefined;
            const hint = [preview.hint ?? summary.hint, !items.length ? `No ${args.kind ?? "applicable"} actions for this range from ${server.resolvedCommand}. ${args.kind?.startsWith("refactor.extract") ? "Select an expression or statements inside the function body; try --kind refactor to inspect other available refactors." : "Check diagnostics and server capabilities, or select a different range/position."}` : chosen
                    ? "disabled" in chosen && chosen.disabled ? `Selected action is disabled: ${selected[0].disabledReason}` : "Use --apply to execute this action."
                    : "Use --query INDEX to preview edit scope, then add --apply to execute.", executesCommand ? "This action executes a server command; its file scope can extend beyond the edit preview." : "", editPreview?.hint].filter(Boolean).join(" ");
            return {
                data: { success: true, applied: false, server: server.name, ...summary, ...preview, ...(executesCommand !== undefined ? { executesCommand } : {}), ...(editPreview ? { editPreview } : {}), hint, actions: selected },
                human: [`${items.length} code action(s):`, ...selected.map((x) => `${x.index}: ${x.title}${x.disabledReason !== undefined ? ` [disabled: ${x.disabledReason}]` : ""}`), ...(editPreview?.edits ?? []), hint].filter(Boolean).join("\n"),
            };
        }
        if (!args.query)
            throw new Error("--query must select an action when using --apply");
        if (!chosen)
            throw new Error(`No code action matches ${args.query}`);
        if ("disabled" in chosen && chosen.disabled)
            throw new Error(chosen.disabled.reason);
        client.applyEdit = async (edit) => {
            try {
                edited = (await client.edit(edit)) || edited;
                editFailure = undefined;
            }
            catch (error) {
                editFailure = error;
                throw error;
            }
        };
        if ("edit" in chosen && chosen.edit)
            await client.applyEdit(chosen.edit);
        if (typeof chosen.command === "string")
            await client.request("workspace/executeCommand", {
                command: chosen.command,
                arguments: "arguments" in chosen ? chosen.arguments : [],
            });
        else if (chosen.command)
            await client.request("workspace/executeCommand", {
                command: chosen.command.command,
                arguments: chosen.command.arguments ?? [],
            });
        else if (!("edit" in chosen) || !chosen.edit)
            throw new Error("Selected code action has no edit or command");
        if (editFailure !== undefined)
            throw editFailure;
        const { items: selected, ...preview } = compactText([{ title: chosen.title }], ["title"], args.limit);
        const renameHint = client.renameTarget ? "Generated helper name retained; renameTarget identifies an optional follow-up rename." : undefined;
        return {
            data: { success: true, applied: true, server: server.name, ...preview, title: selected[0].title, ...(client.renameTarget ? { renameTarget: client.renameTarget } : {}), ...editVerification(true, [preview.hint, renameHint].filter(Boolean).join(" ") || undefined) },
            human: [`Applied ${selected[0].title}`, preview.hint, renameHint, VERIFY_EDITS].filter(Boolean).join("\n"),
        };
    }
    catch (error) {
        if (edited)
            throw new Error(`Code action failed after applying edits: ${error}`);
        throw error;
    }
    finally {
        if (!session)
            await Promise.allSettled([...pool.clients.values()].map(client => client.close()));
    }
}
export function status(args) {
    const path = args.file ? resolveFile(args.file, args.cwd) : undefined, cwd = path ? dirname(path) : args.cwd;
    const available = availableServers(loadConfig(cwd, args.globalConfigOnly), cwd, args.globalBinsOnly, "all");
    const servers = (path ? fileServers(available, path) : available).map((x) => ({
        name: x.name,
        command: x.resolvedCommand,
        args: x.args ?? [],
        root: x.root,
        fileTypes: x.fileTypes ?? [],
        isLinter: !!x.isLinter,
        protocol: x.protocol ?? "lsp",
    }));
    return {
        data: { success: true, servers },
        human: servers.length
            ? servers.map((x) => `${x.name}: ${x.command} (root: ${x.root})`).join("\n")
            : "No configured language servers are available for this workspace",
    };
}
async function doctor(args) {
    const path = args.file ? resolveFile(args.file, args.cwd) : undefined, cwd = path ? dirname(path) : args.cwd;
    const syntax = syntaxTool(cwd, args.globalBinsOnly);
    let configs = loadConfig(cwd, args.globalConfigOnly);
    if (path)
        configs = Object.fromEntries(Object.entries(configs).filter(([, config]) => matchesFile(config, path)));
    const servers = [], issues = [];
    for (const server of availableServers(configs, cwd, args.globalBinsOnly, "all")) {
        let client;
        const row = {
            name: server.name,
            command: server.resolvedCommand,
            root: server.root,
        };
        const pythonPath = object(server.settings?.python).pythonPath;
        if (pythonPath)
            row.pythonPath = pythonPath;
        try {
            client = await LspClient.start(server, args.timeout);
            if (server.protocol === "tsp")
                row.protocolVersion = await typeServerVersion(client, Date.now() + args.timeout);
            if (server.name === "rust-analyzer")
                await client.waitWorkspace();
            Object.assign(row, {
                status: "ok",
                capabilities: Object.keys(client.capabilities)
                    .filter((key) => client.capabilities[key])
                    .sort(),
            });
        }
        catch (error) {
            const result = failure(error, args.limit), preview = result.hint ? { errorTruncated: true, hint: result.hint } : {};
            Object.assign(row, { status: "error", error: result.error, ...preview });
            issues.push({ severity: "error", server: server.name, message: result.error, ...preview });
        }
        finally {
            await client?.close();
        }
        servers.push(row);
    }
    for (const file of configPaths(cwd, args.globalConfigOnly))
        for (const name of Object.keys(readOverrides(file))) {
            const config = configs[name];
            if (!config || config.disabled)
                continue;
            const root = serverRoot(cwd, config.rootMarkers);
            if (!root || resolveCommand(config.command, root, args.globalBinsOnly))
                continue;
            const message = `Executable ${config.command} is missing; run codex-lsp setup ${name} for install guidance`;
            if (servers.some((row) => row.name === name))
                continue;
            servers.push({ name, status: "missing", command: config.command, root, message });
            issues.push({ severity: "error", server: name, message });
        }
    if (!servers.length)
        issues.push({
            severity: "warning",
            message: "No language server is available; run codex-lsp setup <language...>",
        });
    const success = !!servers.length && servers.every((row) => row.status === "ok");
    return {
        data: {
            success,
            runtime: { version, node: process.versions.node, executable: process.execPath },
            syntax,
            configFiles: configPaths(cwd, args.globalConfigOnly).filter(existsSync),
            servers,
            issues,
        },
        code: success ? 0 : 1,
        human: [
            `codex-lsp doctor (${version}, Node ${process.versions.node})`,
            `Optional ast-grep: ${syntax.command ?? syntax.hint}`,
            ...servers.map((row) => `${row.status === "ok" ? "OK" : "ERROR"} ${row.name}: ${row.error ?? row.message ?? row.command} (root: ${row.root})${row.pythonPath ? `\n  Analysis Python: ${row.pythonPath}` : ""}${row.hint ? `\n  ${row.hint}` : ""}`),
            ...issues.filter((x) => x.severity === "warning").map((x) => `WARNING: ${x.message}`),
            success ? "Doctor result: OK" : "Doctor result: needs attention",
        ].join("\n"),
    };
}
function setup(args) {
    const configs = loadConfig(args.cwd, args.globalConfigOnly), languages = args.languages
        .flatMap((x) => x.split(/[,，]/))
        .map((x) => x.trim())
        .filter(Boolean);
    if (!languages.length)
        throw new Error("Provide languages, such as codex-lsp setup rust python");
    if (args.project && languages.some((name) => name === "." || name === ".." || /[\\/]/.test(name) && !Object.hasOwn(configs, name)))
        throw new Error("--project takes no path; select the project with --cwd PATH, for example: codex-lsp --cwd PATH setup python --project");
    const selected = {}, missing = [];
    for (const language of languages) {
        const name = serverForLanguage(language, configs), config = configs[name], command = resolveCommand(config.command, args.cwd);
        if (command) {
            selected[name] = command;
            continue;
        }
        const guide = config.setup;
        const install = typeof guide?.install === "string" || Array.isArray(guide?.install)
            ? guide.install
            : (guide?.install?.[process.platform] ?? guide?.install?.default);
        missing.push(`- ${language}: ${name} (executable: ${config.command})\n  Install commands (${process.platform}):\n${(Array.isArray(install) ? install : [install ?? "Use the official documentation for your platform."]).map((x) => `    ${x}`).join("\n")}\n  Official documentation: ${guide?.docs ?? "Consult the language server upstream documentation."}`);
    }
    if (missing.length)
        throw new Error(`Missing language servers:\n${missing.join("\n")}\nAfter installation, rerun: codex-lsp setup ${languages.join(" ")}${args.project ? " --project" : ""}`);
    const path = configPaths(args.cwd)[args.project ? 1 : 0];
    const doc = existsSync(path)
        ? JSON.parse(readFileSync(path, "utf8"))
        : { servers: {} };
    if (!doc || typeof doc !== "object" || Array.isArray(doc))
        throw new Error(`Invalid LSP config: ${path}`);
    const entries = "servers" in doc ? doc.servers : doc;
    if (!entries || typeof entries !== "object" || Array.isArray(entries))
        throw new Error(`Invalid servers object: ${path}`);
    for (const [name, command] of Object.entries(selected)) {
        const previous = entries[name];
        if (previous !== undefined &&
            (!previous || typeof previous !== "object" || Array.isArray(previous)))
            throw new Error(`Invalid server entry ${name}`);
        entries[name] = {
            ...object(previous), command, disabled: false,
            ...(args.project ? { rootMarkers: [...new Set([...(configs[name].rootMarkers ?? []), ".codex/lsp.json"])] } : {}),
        };
    }
    atomicWrite(path, Buffer.from(JSON.stringify(doc, null, 2) + "\n"));
    return {
        data: { success: true, path, servers: selected },
        human: `Configured language servers in ${path}:\n` +
            Object.entries(selected)
                .map(([name, command]) => `- ${name}: ${command}`)
                .join("\n"),
    };
}
export async function changedFiles(cwd) {
    const root = gitRoot(cwd), found = new Set();
    // Numstat verifies content without refreshing the index or reporting stat-only changes.
    for (const args of [
        ["diff", "--numstat", "--no-renames", "-z", "--diff-filter=ACMRTUXB", "HEAD"],
        ["diff", "--numstat", "--no-renames", "-z", "--diff-filter=ACMRTUXB"],
        ["diff", "--cached", "--numstat", "--no-renames", "-z", "--diff-filter=ACMRTUXB"],
        ["ls-files", "--others", "--exclude-standard", "-z"],
    ]) {
        let output;
        const options = { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } };
        try {
            ({ stdout: output } = await promisify(childProcess.execFile)("git", ["-c", "diff.autoRefreshIndex=false", "-C", root, ...args], options));
        }
        catch (error) {
            const failure = error;
            if (args.at(-1) === "HEAD" && failure.code === 128 && !failure.killed && !failure.signal) {
                try {
                    await promisify(childProcess.execFile)("git", ["-c", "diff.autoRefreshIndex=false", "-C", root, "rev-parse", "--verify", "--quiet", "HEAD"], options);
                }
                catch (headError) {
                    const head = headError;
                    // Only an unborn HEAD may fail; timeouts and other Git failures stay visible.
                    if (head.code === 1 && !head.killed && !head.signal)
                        continue;
                }
            }
            const reason = failure.stderr?.trim() || failure.message;
            throw new Error(`Git ${args.join(" ")} failed in ${root}${reason ? `: ${reason.slice(-1000)}` : ""}. Select the project with --cwd <project-root> diagnostics --changed, or use diagnostics --file <source-file>`);
        }
        for (const name of args[0] === "diff" ? numstatFiles(output) : output.split("\0").filter(Boolean)) {
            let path, info;
            try {
                path = realpathSync(join(root, name));
                info = statSync(path);
            }
            catch (error) {
                if (error.code === "ENOENT")
                    continue;
                throw error;
            }
            if (!info.isFile())
                continue;
            if (!inside(root, path))
                throw new Error(`Changed file is outside the workspace: ${path}`);
            if (info.size > MAX_FILE_BYTES)
                throw new Error(`Changed file exceeds the 16 MiB LSP limit: ${path}`);
            found.add(path);
        }
    }
    if (found.size > MAX_FILES)
        throw new Error(`Changed files exceed the ${MAX_FILES} file limit; use --file to check individual files`);
    return [...found].sort();
}
export async function diagnostics(args, shared, session, providers) {
    if (args.workspace)
        return workspaceDiagnostics(args, session);
    const before = args.baseline ? loadBaseline(resolve(args.cwd, expandHome(args.baseline))) : undefined;
    if (args.file && args.changed || !args.file && !args.changed && !before)
        throw new Error("Choose exactly one of --file or --changed, or provide --baseline");
    const paths = args.changed ? await changedFiles(args.cwd) : args.file ? [resolveFile(args.file, args.cwd)] : before.files.map(file => resolveFile(file.file, args.cwd));
    const root = gitRoot(paths.length ? dirname(paths[0]) : args.cwd);
    if (before && before.root !== root)
        throw new Error(`Baseline workspace mismatch: expected ${root}, got ${before.root}`);
    const sourceTexts = new Map();
    const configurationPaths = args.changed ? configPaths(args.cwd).filter(existsSync).map(file => realpathSync(file)) : [];
    const scopedConfigurationPaths = args.changed ? configPaths(args.cwd, args.globalConfigOnly).filter(existsSync).map(file => realpathSync(file)) : [];
    const configurationChecks = [];
    const groups = new Map();
    const records = new Map();
    let diagnosticBytes = 0;
    for (const path of paths) {
        const configs = loadConfig(dirname(path), args.globalConfigOnly);
        if (configurationPaths.includes(path)) {
            configurationChecks.push({ file: path, status: scopedConfigurationPaths.includes(path) ? "validated" : "ignored" });
            continue;
        }
        const servers = fileServers(availableServers(configs, dirname(path), args.globalBinsOnly), path).filter(server => (!args.server || server.name === args.server) && (!providers || providers.has(serverFingerprint(compilerDiagnostics(server)))));
        records.set(path, {
            file: path, diagnostics: [], verified: !!servers.length,
            errors: servers.length ? [] : ["No available language server matches this file. Run codex-lsp status --file <path>, then codex-lsp setup <language> for installation and configuration guidance; use diagnostics --file <source-file> to check an individual supported file."],
        });
        for (const server of servers) {
            const key = `${server.name}\0${server.root}`;
            if (!groups.has(key))
                groups.set(key, { server, files: [] });
            groups.get(key).files.push(path);
        }
    }
    for (let { server, files } of groups.values()) {
        server = compilerDiagnostics(server);
        const reuse = shared?.server.name === server.name && shared.server.root === server.root;
        let client;
        try {
            client = reuse ? shared.client : await sessionClient(server, args, session);
            for (const file of files)
                if (!client.documents.has(fileUri(file)))
                    await client.open(file);
            for (const file of files) {
                const result = await client.getDiagnostics(fileUri(file)), record = records.get(file);
                diagnosticBytes += Buffer.byteLength(JSON.stringify(result.diagnostics));
                if (diagnosticBytes > MAX_FILE_BYTES)
                    throw new Error("Diagnostic results exceed the 16 MiB aggregate limit; narrow to --file or a smaller changed scope");
                record.verified &&= result.verified;
                if (args.baseline || args.saveBaseline) {
                    const text = client.documents.get(fileUri(file)).text;
                    if (sourceTexts.has(file) && sourceTexts.get(file) !== text) {
                        record.verified = false;
                        record.errors.push("Source changed between diagnostic servers");
                    }
                    sourceTexts.set(file, text);
                }
                if (!result.verified)
                    record.errors.push(`${server.name}: ${UNVERIFIED_DIAGNOSTICS}`);
                const seen = new Set(record.diagnostics.map((x) => JSON.stringify([x.range, x.message, x.severity ?? 1, x.code, x.source])));
                for (const diagnostic of result.diagnostics) {
                    const key = JSON.stringify([diagnostic.range, diagnostic.message, diagnostic.severity ?? 1, diagnostic.code, diagnostic.source]);
                    if (!seen.has(key)) {
                        record.diagnostics.push(diagnostic);
                        seen.add(key);
                    }
                }
            }
        }
        catch (error) {
            for (const file of files) {
                records.get(file).verified = false;
                records.get(file).errors.push(`${server.name}: ${error}`);
            }
        }
        finally {
            if (!reuse && !session)
                await client?.close();
        }
    }
    return diagnosticResult(args, [...records.values()], root, [...groups.values()].map(group => serverFingerprint(compilerDiagnostics(group.server))), sourceTexts, before, configurationChecks);
}
function diagnosticResult(args, checked, root, fingerprints, sourceTexts, before, configurationChecks = []) {
    if (args.baseline || args.saveBaseline)
        for (const record of checked)
            if (sourceTexts.has(record.file) && readText(record.file) !== sourceTexts.get(record.file)) {
                record.verified = false;
                record.errors.push("Source changed during baseline analysis; retry diagnostics");
            }
    const verified = checked.every((x) => x.verified), hasErrors = checked.some((x) => x.diagnostics.some((d) => (d.severity ?? 1) === 1));
    const snapshot = (args.baseline || args.saveBaseline) && verified ? captureBaseline(checked, root, fingerprints, sourceTexts) : undefined;
    let baselineSaved;
    if (args.saveBaseline) {
        if (!snapshot)
            throw new Error("Cannot save an unverified diagnostics baseline; existing baseline is unchanged");
        baselineSaved = resolve(args.cwd, expandHome(args.saveBaseline));
        saveBaseline(baselineSaved, snapshot);
    }
    const comparison = before ? compareBaseline(before, snapshot, checked.map(record => record.file), fingerprints, args.limit) : undefined;
    const success = verified && checked.every((x) => !x.errors.length) && (comparison ? comparison.verified === true && comparison.newErrors === 0 : !hasErrors);
    const all = checked.flatMap((record) => record.diagnostics), summary = outputInfo(all.length, args.limit);
    const counts = { errors: 0, warnings: 0, information: 0, hints: 0 };
    for (const diagnostic of all)
        counts[["errors", "warnings", "information", "hints"][(diagnostic.severity ?? 1) - 1]]++;
    const selected = new Map();
    if (args.limit) {
        const ranked = checked.flatMap(record => record.diagnostics.map(diagnostic => ({ record, diagnostic })))
            .sort((a, b) => (a.diagnostic.severity ?? 1) - (b.diagnostic.severity ?? 1));
        for (const { record, diagnostic } of ranked.slice(0, summary.shown)) {
            if (!selected.has(record))
                selected.set(record, []);
            selected.get(record).push(diagnostic);
        }
    }
    const content = args.limit ? [...[...selected.values()].flat().map(diagnostic => JSON.stringify(diagnostic)), ...checked.flatMap(record => record.errors)] : [];
    const maximum = content.reduce((sum, text) => sum + text.length, 0) > 6000 ? Math.floor(6000 / content.length) : Infinity;
    let textTruncated = false, detailsOmitted = false;
    const preview = (text) => { const shown = textPrefix(text, maximum); textTruncated ||= shown.length < text.length; return shown; };
    const visible = checked.map((record) => {
        const diagnostics = (args.limit ? selected.get(record) ?? [] : record.diagnostics).map(diagnostic => {
            if (!Number.isFinite(maximum))
                return diagnostic;
            const message = preview(diagnostic.message);
            if (JSON.stringify(diagnostic).length - JSON.stringify(diagnostic.message).length <= 512)
                return { ...diagnostic, message };
            detailsOmitted = true;
            const { start, end } = diagnostic.range;
            return { range: { start: { line: start.line, character: start.character }, end: { line: end.line, character: end.character } }, severity: diagnostic.severity, code: typeof diagnostic.code === "string" ? textPrefix(diagnostic.code, 128) : typeof diagnostic.code === "number" ? diagnostic.code : undefined,
                source: typeof diagnostic.source === "string" ? textPrefix(diagnostic.source, 128) : undefined, message };
        });
        return { ...record, errors: record.errors.map(preview), diagnosticCount: record.diagnostics.length, diagnostics };
    });
    if (textTruncated || detailsOmitted) {
        summary.truncated = true;
        summary.hint = "Diagnostic text or metadata clipped; use --limit 0 --json for complete output. Counts and verification cover all diagnostics.";
    }
    if (!verified)
        summary.hint = [summary.hint, UNVERIFIED_DIAGNOSTICS].filter(Boolean).join(" ");
    return {
        data: { success, verified, hasErrors, ...summary, counts, checked: visible, ...(comparison ? { comparison } : {}), ...(baselineSaved ? { baselineSaved } : {}), ...(textTruncated ? { textTruncated: true } : {}), ...(detailsOmitted ? { detailsOmitted: true } : {}), ...(configurationChecks.length ? { configurationChecks } : {}) },
        code: success ? 0 : 1,
        human: [checked.length
                ? [`${all.length} diagnostic(s): ${counts.errors} error(s), ${counts.warnings} warning(s), ${counts.information} information, ${counts.hints} hint(s)`, ...visible
                        .flatMap((x) => [
                        `${x.file}: ${x.verified ? "verified" : "unverified"}, ${x.diagnosticCount} diagnostic(s)`,
                        ...x.diagnostics.map((d) => `  ${d.range.start.line + 1}:${d.range.start.character + 1} [${d.severity ?? 1}] ${d.message}`),
                        ...x.errors.map((e) => `  ERROR: ${e}`),
                    ]), summary.hint].filter(Boolean).join("\n")
                : "No changed source files to check",
            ...configurationChecks.map(row => `${row.status === "validated" ? "Validated CLI configuration" : "Ignored project LSP configuration (global-config-only)"}: ${row.file}`),
            ...(comparison ? [comparison.verified ? `Baseline: ${JSON.stringify(comparison.counts)}; ${comparison.newErrors} new error(s). Existing diagnostics remain visible above.` : String(comparison.hint),
                ...["new", "resolved", "existing"].flatMap(kind => (Array.isArray(object(comparison[kind]).issues) ? object(comparison[kind]).issues : []).map(issue => `${kind}: ${issue.file}:${issue.line}:${issue.column} ${issue.message}`))] : []),
            ...(baselineSaved ? [`Baseline saved: ${baselineSaved}`] : []),].join("\n"),
    };
}
async function workspaceDiagnostics(args, session) {
    if (args.changed || args.apply || args.watch)
        throw new Error("Use diagnostics --workspace [--file PATH | --server NAME] without --changed/--watch/--apply");
    const root = realpathSync(gitRoot(args.cwd)), anchor = args.file ? resolveFile(args.file, args.cwd) : undefined;
    const before = args.baseline ? loadBaseline(resolve(args.cwd, expandHome(args.baseline))) : undefined;
    if (before && before.root !== root)
        throw new Error("Baseline workspace mismatch");
    const available = availableServers(loadConfig(anchor ? dirname(anchor) : args.cwd, args.globalConfigOnly), anchor ? dirname(anchor) : args.cwd, args.globalBinsOnly);
    const servers = (anchor ? fileServers(available, anchor) : available).filter(server => !args.server || server.name === args.server);
    if (!servers.length)
        throw new Error("No available workspace provider; use status --file PATH or setup LANGUAGE");
    const pool = session ?? { clients: new Map(), diagnostics: true }, records = new Map(), texts = new Map(), fingerprints = [], coverage = [];
    const deadline = Date.now() + args.timeout;
    let bytes = 0;
    try {
        for (const configured of servers) {
            const server = compilerDiagnostics(configured), detail = { server: server.name, root: server.root, supported: false, verified: false, checkedFiles: 0 };
            coverage.push(detail);
            try {
                if (Date.now() >= deadline)
                    throw new Error("Workspace diagnostic deadline exceeded; select --server NAME or increase --timeout");
                const client = await sessionClient(server, { ...args, apply: false }, pool);
                if (object(client.capabilities.diagnosticProvider).workspaceDiagnostics !== true) {
                    const checker = server.name === "rust-analyzer" ? "cargo check" : /typescript|tsgo/i.test(server.name) ? `${/tsgo/i.test(basename(server.resolvedCommand)) ? "tsgo" : "tsc"} --noEmit` : /python|pyright|pyrefly|^ty(?:$|[-_])/i.test(server.name) ? "pyright or the configured Python checker" : "see project scripts";
                    detail.hint = `${server.name} does not advertise workspace diagnostics; run the project's native type-check command (${checker})`;
                    continue;
                }
                detail.supported = true;
                await client.refresh();
                if (server.name === "rust-analyzer")
                    await client.waitWorkspace(Math.max(1, deadline - Date.now()));
                const report = await client.getWorkspaceDiagnostics(Math.max(1, deadline - Date.now()));
                for (const row of report) {
                    const raw = uriFile(row.uri);
                    if (!raw || !insideWorkspace(root, raw))
                        throw new Error(`Workspace provider returned a non-local or outside-workspace URI: ${row.uri}`);
                    const file = resolveFile(raw, args.cwd), text = readText(file), document = client.documents.get(row.uri);
                    if (row.version != null && (!document || document.version !== row.version || document.text !== text))
                        throw new Error(`Workspace diagnostics have an unverifiable document version: ${file}`);
                    if (texts.has(file) && texts.get(file) !== text)
                        throw new Error(`Source changed during workspace diagnostics: ${file}`);
                    if (!texts.has(file)) {
                        bytes += Buffer.byteLength(text);
                        texts.set(file, text);
                    }
                    bytes += Buffer.byteLength(JSON.stringify(row.items));
                    if (bytes > MAX_FILE_BYTES || texts.size > MAX_FILES)
                        throw new Error("Workspace diagnostic scope exceeds 16 MiB or 200 files; select a narrower provider");
                    for (const item of row.items)
                        validateEdits(text, [{ range: item.range, newText: "" }]);
                    const record = records.get(file) ?? { file, diagnostics: [], verified: true, errors: [] };
                    record.diagnostics.push(...row.items);
                    records.set(file, record);
                }
                detail.checkedFiles = report.length;
                detail.verified = true;
                fingerprints.push(serverFingerprint(server));
            }
            catch (error) {
                detail.error = String(failure(error, args.limit).error);
            }
        }
        for (const record of records.values())
            if (readText(record.file) !== texts.get(record.file)) {
                record.verified = false;
                record.errors.push("Source changed during workspace analysis; retry");
            }
        const complete = coverage.every(row => row.verified === true) && [...records.values()].every(row => row.verified);
        if (args.saveBaseline && !complete)
            throw new Error("Cannot save a partial workspace baseline; select a supported --server or --file provider");
        const result = diagnosticResult(args, [...records.values()], root, fingerprints, texts, complete ? before : undefined);
        return { ...result, code: complete ? result.code : 1, data: { ...result.data, success: complete && result.data.success === true, verified: complete && result.data.verified === true, ...(!complete && before ? { comparison: { verified: false, hint: "Workspace coverage is incomplete; no resolved issues are claimed" } } : {}), coverage: { scope: "server-workspaces", basis: "Server-reported workspace diagnostics; provider configuration controls included files", complete, requestedRoot: root, providers: coverage } }, human: [result.human, ...coverage.map(row => `${row.server}: ${row.verified ? `${row.checkedFiles} reported file(s)` : row.error ?? row.hint}`)].join("\n") };
    }
    finally {
        if (!session)
            await Promise.allSettled([...pool.clients.values()].map(client => client.close()));
    }
}
async function check(args, session) {
    if (!!args.file === args.changed || args.apply || args.workspace || args.plan || args.symbol || args.column !== undefined || args.line !== 1 || args.query !== undefined)
        throw new Error("Use check --changed or --file PATH for read-only diagnostics, lint and format checks");
    const pool = session ?? { clients: new Map(), diagnostics: true }, checks = [], deadline = Date.now() + args.timeout;
    try {
        for (const command of ["diagnostics", "lint", "format"]) {
            let result;
            try {
                if (Date.now() >= deadline)
                    throw new Error("Check deadline exceeded; narrow scope or increase --timeout");
                const options = { ...args, command, check: command === "format", timeout: Math.max(1, deadline - Date.now()) };
                result = command === "diagnostics" ? await diagnostics(options, undefined, pool) : await runTooling(options, pool);
            }
            catch (error) {
                result = { code: 1, data: { success: false, verified: false, error: String(failure(error, args.limit).error) }, human: String(error) };
            }
            const data = result.data, checked = Array.isArray(data.checked) ? data.checked.map(object) : [];
            const errors = [...(Array.isArray(data.errors) ? data.errors.map(object) : []), ...checked.flatMap(row => (Array.isArray(row.errors) ? row.errors : []).map(error => ({ file: row.file, error }))), ...(data.error ? [{ error: data.error }] : [])];
            const { items, ...meta } = compactText((args.limit ? errors.slice(0, args.limit) : errors), ["error"], args.limit);
            checks.push({ command, code: result.code ?? 0, success: (result.code ?? 0) === 0 && data.success !== false, verified: data.verified === true, hasErrors: data.hasErrors, checkedFiles: data.checkedFiles ?? checked.length, diagnosticCount: data.diagnosticCount ?? (command === "diagnostics" ? data.total : undefined), ...(data.counts ? { counts: data.counts } : {}), ...(data.needsFormatting !== undefined ? { needsFormatting: data.needsFormatting, changedFiles: data.changedFiles } : {}), skippedCount: data.skippedCount ?? 0, ignoredFiles: data.ignoredFiles ?? 0, errors: items, errorCount: errors.length, ...meta });
        }
        const failedChecks = checks.filter(row => !row.success || !row.verified).map(row => row.command), verified = checks.every(row => row.verified);
        return { code: failedChecks.length ? 1 : 0, data: { command: "check", success: !failedChecks.length, verified, failedChecks, checks, hint: "Run the named diagnostics/lint/format command for issue details; check preserves source and Git index" }, human: checks.map(row => `${row.command}: ${row.success && row.verified ? "passed" : "failed"}, ${row.checkedFiles} file(s)${row.diagnosticCount !== undefined ? `, ${row.diagnosticCount} diagnostic(s)` : ""}${row.needsFormatting ? `, ${row.changedFiles} need formatting` : ""}${row.errorCount ? `, ${row.errorCount} tool error(s)` : ""}`).join("\n") };
    }
    finally {
        if (!session)
            await Promise.allSettled([...pool.clients.values()].map(client => client.close()));
    }
}
async function inspect(args, session) {
    if (args.apply || args.workspace || args.changed)
        throw new Error("inspect is read-only and checks one file; omit --apply, --workspace and --changed");
    const context = await fileContext(args, true, session);
    const results = {}, human = [], failedSections = [];
    try {
        const pos = await position(context.path, context.text, args);
        const queries = [
            ["hover", "hoverProvider"], ["definition", "definitionProvider"],
            ["references", "referencesProvider"], ["symbols", "documentSymbolProvider"],
            ...(args.context ? [["type-definition", "typeDefinitionProvider"]] : []),
            ["diagnostics", undefined], ...(args.newName ? [["rename", "renameProvider"]] : []),
        ];
        for (const [command, capability] of queries) {
            if (capability && !context.client.capabilities[capability]) {
                results[command] = { success: true, supported: false, hint: `${context.server.name} does not advertise ${capability}` };
                human.push(`${command}: unsupported by ${context.server.name}`);
                continue;
            }
            try {
                const query = { ...args, command, query: args.query ?? symbolAt(context.text, pos.line, pos.character) };
                const result = command === "symbols" ? await symbols(query, context)
                    : command === "diagnostics" ? await diagnostics(query, context, session)
                        : command === "rename" ? await rename(query, context) : await navigate(query, context);
                results[command] = result.data;
                if (result.data.success === false)
                    failedSections.push(command);
                human.push(`${command}:\n${result.human}`);
            }
            catch (error) {
                failedSections.push(command);
                const result = failure(error, args.limit);
                results[command] = result;
                human.push([`${command}: ERROR ${result.error}`, result.hint].filter(Boolean).join("\n"));
            }
        }
        if (args.context) {
            const result = await inspectContext(args, context, pos, results);
            results.context = result.data;
            human.push(`context:\n${result.human}`);
            if (result.data.success === false)
                failedSections.push("context");
        }
        const success = !failedSections.length;
        const diagnostic = object(results.diagnostics);
        const hint = diagnostic.verified === true && diagnostic.hasErrors === true
            ? `Diagnostics verified: ${object(diagnostic.counts).errors} project code error(s). Navigation results remain available; see results.diagnostics.checked for locations.` : undefined;
        if (hint)
            human.unshift(hint);
        if (!success)
            human.unshift(`Inspection has issues in: ${failedSections.join(", ")}. See each section below.`);
        return { data: { success, applied: false, server: context.server.name, failedSections, ...(hint ? { hint } : {}), results }, human: [`Root: ${gitRoot(context.server.root)}`, ...human].join("\n\n"), code: success ? 0 : 1 };
    }
    finally {
        if (!session)
            await context.client.close();
    }
}
async function batch(args) {
    const queries = await batchQueries(args), results = [], human = [];
    const session = { clients: new Map(), diagnostics: queries.some(query => ["inspect", "diagnostics"].includes(query.options.command)) };
    try {
        for (const { line, options } of queries) {
            let result, data;
            try {
                result = await run(options, session);
                data = outputData(result.data, { fields: options.fields });
            }
            catch (error) {
                data = failure(error, options.limit);
                result = { data, human: [data.error, data.hint].filter(Boolean).join("\n"), code: 2 };
            }
            let code = result.code ?? 0;
            const metadata = { index: results.length, inputLine: line, command: options.command, file: options.file, line: options.line, ...(options.symbol ? { symbol: options.symbol } : {}) };
            let row = { ...metadata, code, ...data };
            try {
                row = outputData(row, { budget: options.budget });
            }
            catch (error) {
                code = 2;
                data = failure(error, options.limit);
                row = { ...metadata, code, ...data };
            }
            results.push(row);
            human.push(`[${results.length}] ${options.command} ${options.file ?? ""} (exit ${code})\n${options.fields || options.budget ? JSON.stringify(row) : result.human}`);
        }
        const failedQueries = results.filter(row => row.code !== 0).map(row => ({ index: row.index, inputLine: row.inputLine, code: row.code, ...(row.failedSections ? { failedSections: row.failedSections } : {}) })), failed = failedQueries.length;
        const hint = failed ? `${failed}/${results.length} queries failed. Successful results remain available; failedQueries maps each results[index] to its inputLine and failedSections.` : undefined;
        return { data: { success: !failed, applied: false, total: results.length, succeeded: results.length - failed, failed, failedQueries, ...(hint ? { hint } : {}), results }, code: failed ? 1 : 0,
            human: [`Batch: ${results.length - failed}/${results.length} queries succeeded`, ...human].join("\n\n") };
    }
    finally {
        await Promise.allSettled([...session.clients.values()].map(client => client.close()));
    }
}
async function renameFile(args) {
    if (!args.file || !args.newName)
        throw new Error("--file and --new-name are required");
    const source = resolveFile(args.file, args.cwd), desired = resolve(dirname(source), expandHome(args.newName));
    const pathHint = `--new-name resolves relative to the source file directory (${dirname(source)}); use a basename or absolute path and create the destination directory first.`;
    let parent;
    try {
        parent = realpathSync(dirname(desired));
    }
    catch (error) {
        if (["ENOENT", "ENOTDIR"].includes(String(object(error).code)))
            throw new Error(`Destination directory is missing: ${dirname(desired)}. ${pathHint}`);
        throw error;
    }
    if (!statSync(parent).isDirectory())
        throw new Error(`Destination parent is not a directory: ${parent}. ${pathHint}`);
    const destination = join(parent, basename(desired));
    if (source === destination || existsSync(destination))
        throw new Error(`Destination already exists or matches source: ${destination}`);
    const servers = fileServers(availableServers(loadConfig(dirname(source), args.globalConfigOnly), dirname(source), args.globalBinsOnly), source).filter((x) => !x.isLinter);
    const pairs = { files: [{ oldUri: fileUri(source), newUri: fileUri(destination) }] };
    const clients = [];
    try {
        for (const server of servers) {
            const client = await LspClient.start(server, args.timeout);
            try {
                const { uri } = await client.open(source);
                await client.ready(uri);
                const edit = (await client.request("workspace/willRenameFiles", pairs)) ?? {};
                clients.push({ server, client, edit });
            }
            catch (error) {
                await client.close();
                if (object(error).code !== -32601)
                    throw error;
            }
        }
        const total = clients.reduce((n, x) => n + [...textChanges(x.edit).values()].reduce((n, items) => n + items.length, 0), 0);
        const summary = outputInfo(total, args.limit), maximumText = editTextLimit(clients.map(x => x.edit), summary.shown, !!args.limit);
        let remaining = summary.shown, textTruncated = false;
        const edits = clients.map(x => {
            const count = [...textChanges(x.edit).values()].reduce((n, items) => n + items.length, 0);
            const preview = editSummary(x.edit, remaining, maximumText);
            remaining -= Math.min(remaining, count);
            textTruncated ||= preview.textTruncated;
            return preview.lines;
        });
        if (textTruncated) {
            summary.truncated = true;
            summary.hint = [summary.hint, "Replacement text clipped; use --limit 0 --json for complete edits."].filter(Boolean).join(" ");
        }
        const importUpdates = total ? "provided" : clients.length ? "none" : "unavailable";
        const importHint = total ? undefined : clients.length
            ? "Language servers returned no import-update edits; check affected imports manually."
            : "No available language server provided file-rename support; this is a file-only move. Update affected imports manually.";
        const hint = [summary.hint, importHint].filter(Boolean).join(" ") || undefined;
        if (args.apply) {
            const root = gitRoot(servers[0]?.root ?? dirname(source));
            if (!insideWorkspace(realpathSync(root), source) || !insideWorkspace(realpathSync(root), destination))
                throw new Error("File rename must stay inside the workspace");
            moveNoReplace(source, destination);
            try {
                const combined = { changes: {}, documentChanges: [] };
                const documents = new Map();
                for (const { client, edit } of clients) {
                    const remapped = remapEdit(edit, fileUri(source), fileUri(destination));
                    for (const [uri, edits] of Object.entries(remapped.changes ?? {}))
                        combined.changes[uri] = [...(combined.changes[uri] ?? []), ...edits];
                    combined.documentChanges.push(...(remapped.documentChanges ?? []));
                    for (const [uri, document] of client.documents) {
                        const target = uri === fileUri(source) ? fileUri(destination) : uri;
                        if (documents.has(target) && documents.get(target).text !== document.text)
                            throw new Error(`File changed since LSP analysis: ${source}`);
                        documents.set(target, document);
                    }
                }
                await applyWorkspaceEdit(combined, root, documents);
            }
            catch (error) {
                try {
                    moveNoReplace(destination, source);
                }
                catch (rollbackError) {
                    throw new Error(`${error}; file rename rollback failed (${destination} → ${source}): ${rollbackError}`);
                }
                throw error;
            }
            try {
                for (const { client } of clients)
                    await client.notify("workspace/didRenameFiles", pairs);
            }
            catch (error) {
                throw new Error(`File renamed and edits applied, but LSP notification failed (${source} → ${destination}): ${error}`);
            }
        }
        return {
            data: {
                success: true,
                applied: args.apply,
                source,
                destination,
                importUpdates,
                ...summary,
                ...(textTruncated ? { textTruncated: true } : {}),
                ...(hint ? { hint } : {}),
                edits,
                ...(!args.apply
                    ? summary.truncated ? { workspaceEditOmitted: true } : { workspaceEdits: clients.map((x) => ({ server: x.server.name, edit: x.edit })) }
                    : {}),
                ...editVerification(args.apply, hint),
            },
            human: [`${args.apply ? "Renamed" : "Rename preview"}: ${source} → ${destination}\n${edits.flat().join("\n")}`, hint, args.apply ? VERIFY_EDITS : undefined].filter(Boolean).join("\n"),
        };
    }
    finally {
        for (const { client } of clients)
            await client.close();
    }
}
async function request(args) {
    if (!args.method)
        throw new Error("--method is required");
    if (!READ_ONLY.has(args.method) && !args.apply)
        throw new Error("Raw request methods require --apply unless listed as read-only");
    let client, server, params = args.payload ? JSON.parse(args.payload) : ["typeServer/getSnapshot", "typeServer/getSupportedProtocolVersion"].includes(args.method) ? undefined : {};
    let applied = false, editFailure;
    if (args.file && args.payload && args.method.startsWith("textDocument/") &&
        (params === null || typeof params !== "object" || Array.isArray(params)))
        throw new Error("--payload with --file must contain an object for textDocument requests");
    try {
        if (args.file) {
            const context = await fileContext(args);
            ({ client, server } = context);
            if (!args.payload && !args.method.startsWith("typeServer/") || args.method.startsWith("textDocument/")) {
                const supplied = object(params);
                params = { ...supplied, textDocument: { uri: context.uri, ...object(supplied.textDocument) } };
                if (POSITION_METHODS.has(args.method) && supplied.position === undefined)
                    params = {
                        ...object(params),
                        position: await position(context.path, context.text, args),
                        ...(args.method === "textDocument/references"
                            ? { context: { includeDeclaration: true } }
                            : {}),
                    };
            }
        }
        else {
            const servers = availableServers(loadConfig(args.cwd, args.globalConfigOnly), args.cwd, args.globalBinsOnly, args.method.startsWith("typeServer/") ? args.server ? "all" : "tsp" : "lsp").filter(server => !args.server || server.name === args.server);
            server = servers.find((x) => !x.isLinter) ?? servers[0];
            if (!server)
                throw new Error("No available language server for this workspace");
            client = await LspClient.start(server, args.timeout, args.apply);
        }
        if (args.apply)
            client.applyEdit = async (edit) => {
                try {
                    applied = (await client.edit(edit)) || applied;
                }
                catch (error) {
                    editFailure = error;
                    throw error;
                }
            };
        const result = await client.request(args.method, params);
        if (editFailure !== undefined)
            throw editFailure;
        if (args.apply && (object(result).changes || object(result).documentChanges)) {
            applied = (await client.edit(result)) || applied;
        }
        return {
            data: { success: true, server: server.name, method: args.method, applied, result, ...editVerification(applied) },
            human: [JSON.stringify(result, null, 2), applied ? VERIFY_EDITS : undefined].filter(Boolean).join("\n"),
        };
    }
    catch (error) {
        if (applied)
            throw new Error(`Raw request failed after applying edits: ${error}`);
        throw error;
    }
    finally {
        await client?.close();
    }
}
export async function run(args, session) {
    let resolved = resolveTarget(args);
    const finish = (result) => {
        try {
            return { ...result, data: attachTargets(resolved, result.data) };
        }
        catch (error) {
            return { ...result, data: { ...result.data, targets: [], targetsHint: `Targets unavailable; use explicit file/line anchors. ${error instanceof Error ? error.message : String(error)}` } };
        }
    };
    if (resolved.file && resolved.symbol && resolved.column === undefined && resolved.lineExplicit === false && resolved.line === 1 && ["hover", "definition", "references", "type-definition", "implementation", "snippet", "inspect", "rename", "code-actions", "callers", "callees", "supertypes", "subtypes", "types"].includes(resolved.command)) {
        const file = resolveFile(resolved.file, resolved.cwd);
        if (syntaxLanguage(file)) {
            const lookup = await syntaxLookup(file, readText(file), resolved.symbol, resolved.globalBinsOnly);
            const candidates = resolved.lineExplicit ? lookup.candidates.filter(row => row.line === resolved.line) : lookup.candidates;
            const selected = resolved.lineExplicit ? candidates.length === 1 ? { line: candidates[0].line - 1, character: candidates[0].column - 1 } : undefined : lookup.position;
            if (!selected) {
                const shown = candidates.slice(0, resolved.limit || undefined), hint = candidates.length ? "Choose a candidate with --line N --column N, or qualify the symbol by its containing class/module." : "No matching declaration; use symbols --file PATH --query NAME or an explicit source position.";
                const data = { success: false, found: false, reason: candidates.length ? "ambiguous-symbol" : "symbol-not-found", candidates: shown, total: candidates.length, shown: shown.length, truncated: shown.length < candidates.length, hint };
                return finish({ code: 1, data, human: [hint, ...shown.map(row => `${row.file}:${row.line}:${row.column} ${row.symbol}`)].join("\n") });
            }
            resolved = { ...resolved, line: selected.line + 1, column: selected.character + 1, query: resolved.query ?? (resolved.command === "inspect" ? resolved.symbol.split(/::|\./).at(-1).replace(/#\d+$/, "") : undefined), symbol: undefined, lineExplicit: true };
        }
    }
    return finish(await runQuery(resolved, session));
}
async function runQuery(args, session) {
    const navigation = Object.hasOwn(NAVIGATION, args.command);
    if (args.apply && (session || navigation || ["symbols", "diagnostics", "callers", "callees", "supertypes", "subtypes", "inlay-hints", "complete", "impact", "next", "api-diff", "dependencies", "fix", "lint", "format", "check", "types"].includes(args.command)))
        throw new Error(`${args.command} is read-only; omit --apply`);
    if (args.command === "types" && args.view !== undefined && !["computed", "declared", "expected"].includes(args.view))
        throw new Error("types --view must be computed, declared or expected");
    if (args.command === "inlay-hints" && !args.range)
        throw new Error("inlay-hints requires --range START_LINE:COL-END_LINE:COL");
    let requestPosition = false;
    if (args.command === "request" && POSITION_METHODS.has(args.method ?? "")) {
        const payload = args.payload ? JSON.parse(args.payload) : {};
        requestPosition = !!payload && typeof payload === "object" && !Array.isArray(payload) && !("position" in payload);
    }
    if (args.file && (navigation || ["inspect", "rename", "code-actions", "callers", "callees", "supertypes", "subtypes", "inlay-hints", "complete", "types"].includes(args.command) ||
        requestPosition)) {
        const path = resolveFile(args.file, args.cwd);
        const text = readText(path);
        if (args.range)
            for (const point of [args.range.start, args.range.end])
                await position(path, text, { line: point.line + 1, column: point.character + 1 });
        else
            await position(path, text, args);
    }
    if (navigation)
        return navigate(args, undefined, session);
    switch (args.command) {
        case "types": {
            if (args.file && typescriptFile(args.file) && (!args.server || args.server === "typescript-api"))
                return typescriptTypes(args, session);
            const context = await fileContext(args, true, session);
            try {
                const point = await position(context.path, context.text, args);
                const result = await queryType(args, context.client, context.uri, args.range ?? { start: point, end: point });
                if (readText(context.path) !== context.text)
                    throw new Error("Source changed during TSP query; retry with a current anchor");
                return { ...result, data: { ...result.data, file: context.path } };
            }
            finally {
                if (!session)
                    await context.client.close();
            }
        }
        case "check": return check(args, session);
        case "lint":
        case "format":
            return runTooling(args, session);
        case "api-diff":
            return apiDiff(args);
        case "dependencies":
            return dependencies(args);
        case "fix": {
            if (!args.plan)
                throw new Error("Fix plans require --plan PATH.json");
            if (args.format)
                return combinedPlan(args);
            if (args.tool)
                return runTooling({ ...args, command: "lint" });
            if (!args.server && args.query === undefined && args.symbol === undefined && args.column === undefined && args.line === 1 && !args.range && (!args.kind || args.kind === "source.fixAll" || args.kind.startsWith("source.fixAll."))) {
                const paths = args.file ? [resolveFile(args.file, args.cwd)] : args.changed ? await changedFiles(args.cwd) : [];
                if (paths.some(file => declaredTools(file, false).length))
                    return runTooling({ ...args, command: "lint" });
            }
            const pool = { clients: new Map(), diagnostics: true };
            try {
                return await fixPlan(args, file => fileContext({ ...args, file }, true, pool));
            }
            finally {
                await Promise.allSettled([...pool.clients.values()].map(client => client.close()));
            }
        }
        case "apply":
            return applyPlan(args, (files, baseline, verification) => verification
                ? verifyToolPlan(files, verification, args)
                : diagnostics({ ...args, command: "diagnostics", file: undefined, changed: false, apply: false, baseline, saveBaseline: undefined, limit: 0 }, undefined, undefined, new Set(loadBaseline(baseline).servers)), async (files, verification, baseline) => {
                if (verification)
                    await validateToolPlan(files, verification, args);
                else if (baseline)
                    validateFixProviders(baseline, args);
            });
        case "next": {
            if (!args.cursor || args.file || args.changed || args.symbol || args.query || args.column || args.line !== 1 || args.workspace)
                throw new Error("Use next --cursor ID from a references page, in the same workspace");
            const data = nextPage({ cwd: args.cwd, cursor: args.cursor });
            return { data, human: [`References: ${data.shown} of ${data.total} (snapshot offset ${data.offset})`, ...locationLines(data.locations, gitRoot(args.cwd)), data.hint,
                    ...(data.nextCursor ? [`Next: codex-lsp next --cursor ${data.nextCursor}`] : [])].filter(Boolean).join("\n") };
        }
        case "impact": {
            if (!args.changed || args.file || args.apply)
                throw new Error("impact is read-only; use impact --changed");
            const pool = session ?? { clients: new Map(), diagnostics: false };
            try {
                return await impactAnalysis(args, await changedFiles(args.cwd), file => fileContext({ ...args, command: "symbols", file }, true, pool));
            }
            finally {
                if (!session)
                    await Promise.allSettled([...pool.clients.values()].map(client => client.close()));
            }
        }
        case "callers":
        case "callees":
        case "supertypes":
        case "subtypes":
        case "inlay-hints":
        case "complete": {
            if (args.apply)
                throw new Error(`${args.command} is read-only; omit --apply`);
            const context = await fileContext(args, true, session);
            try {
                if (args.command === "inlay-hints")
                    return await inlayHints(args, context.client, context.uri, args.range);
                const pos = await position(context.path, context.text, args);
                return args.command === "complete" ? await complete(args, context.client, context.uri, pos)
                    : ["supertypes", "subtypes"].includes(args.command) ? await typeHierarchy(args, context.client, context.uri, pos)
                        : await callHierarchy(args, context.client, context.uri, pos);
            }
            finally {
                if (!session)
                    await context.client.close();
            }
        }
        case "batch":
            return batch(args);
        case "snippet":
            return snippet(args);
        case "inspect":
            return inspect(args, session);
        case "status":
            return status(args);
        case "setup":
            return setup(args);
        case "doctor":
            return doctor(args);
        case "diagnostics":
            return diagnostics(args, undefined, session);
        case "symbols":
            return symbols(args, undefined, session);
        case "rename":
            return rename(args);
        case "rename-file":
            return renameFile(args);
        case "code-actions":
            return codeActions(args, session);
        case "request":
            return request(args);
        case "capabilities": {
            const path = args.file ? resolveFile(args.file, args.cwd) : undefined, cwd = path ? dirname(path) : args.cwd;
            const all = availableServers(loadConfig(cwd, args.globalConfigOnly), cwd, args.globalBinsOnly, "all"), servers = (path ? fileServers(all, path) : all).filter(server => !args.server || server.name === args.server);
            if (!servers.length)
                throw new Error("No available language server");
            const results = [];
            for (const server of servers) {
                const client = await LspClient.start(server, args.timeout);
                try {
                    results.push({ name: server.name, capabilities: client.capabilities });
                }
                finally {
                    await client.close();
                }
            }
            return { data: { success: true, servers: results }, human: JSON.stringify(results, null, 2) };
        }
        default:
            throw new Error(`Unknown command: ${args.command}; use codex-lsp ${args.command === "version" ? "--version" : "--help"}`);
    }
}
