import childProcess from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { gitRoot, insideWorkspace, LANGUAGES, MAX_FILES, MAX_FILE_BYTES, object, readText, uriFile } from "./config.js";
import { compactText, failure, textPrefix } from "./output.js";
import { comparePosition, requestBefore, validRange } from "./semantic.js";
import { syntaxLanguage, syntaxSnippet, syntaxTool } from "./syntax.js";
const testPath = (file) => /(?:^|[/\\])(?:tests?|__tests__|specs?)(?:[/\\])|(?:^|[/\\])test_[^/\\]+\.|[._-](?:test|spec)\.[^/\\]+$/i.test(file);
function changed(range, hunk) {
    const end = range.end.line - (range.end.character === 0 && range.end.line > range.start.line ? 1 : 0);
    return hunk.count ? range.start.line <= hunk.start + hunk.count - 2 && end >= hunk.start - 1 : range.start.line < hunk.start && hunk.start <= end;
}
function documentSymbols(value) {
    if (value === null)
        return [];
    if (!Array.isArray(value))
        throw new Error("Invalid impact document-symbol response");
    const result = [];
    const visit = (values, inFunction) => {
        for (const value of values) {
            const item = object(value), range = item.range ?? object(item.location).range, selection = item.selectionRange ?? range;
            if (typeof item.name !== "string" || !validRange(range) || !validRange(selection) || !Number.isSafeInteger(item.kind) || comparePosition(range.start, selection.start) > 0 || comparePosition(selection.end, range.end) > 0)
                throw new Error("Invalid impact document symbol");
            const kind = Number(item.kind), callable = [6, 9, 12].includes(kind);
            if ([3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 23, 26].includes(kind) && !(inFunction && [13, 14].includes(kind)))
                result.push({ name: item.name, kind, range, selection });
            if (item.children !== undefined) {
                if (!Array.isArray(item.children))
                    throw new Error("Invalid impact symbol children");
                visit(item.children, inFunction || callable);
            }
        }
    };
    visit(value, false);
    return result;
}
export async function impactAnalysis(args, paths, acquire) {
    if (!args.changed || args.file || args.apply)
        throw new Error("impact is read-only; use impact --changed from the Git project directory");
    const root = gitRoot(args.cwd), deadline = Date.now() + args.timeout;
    const git = async (values) => (await promisify(childProcess.execFile)("git", ["-c", "diff.autoRefreshIndex=false", "-C", root, "--literal-pathspecs", ...values], {
        encoding: "utf8", maxBuffer: MAX_FILE_BYTES, timeout: Math.max(1, Math.min(5000, deadline - Date.now())), killSignal: "SIGKILL", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    })).stdout;
    let hasHead = true;
    try {
        await git(["rev-parse", "--verify", "--quiet", "HEAD"]);
    }
    catch (error) {
        const e = error;
        if (e.code === 1 && !e.killed && !e.signal)
            hasHead = false;
        else
            throw error;
    }
    const previousFiles = new Set(hasHead ? (await git(["ls-tree", "-r", "--name-only", "-z", "HEAD"])).split("\0").filter(Boolean) : []);
    const inventory = [...new Set((await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean))];
    const deleted = hasHead ? (await git(["diff", "--name-only", "--diff-filter=D", "-z", "HEAD"])).split("\0").filter(Boolean).filter(file => Object.hasOwn(LANGUAGES, extname(file))) : [];
    if (deleted.length > MAX_FILES)
        throw new Error("Impact deleted files exceed the 200-file limit");
    const symbols = [], errors = [], skipped = [], removed = [];
    const snapshots = new Map();
    let bounded = false;
    for (const file of paths) {
        if (Date.now() >= deadline) {
            bounded = true;
            errors.push({ file, error: "Impact analysis deadline exceeded; increase --timeout" });
            break;
        }
        try {
            const name = relative(root, file), diff = hasHead ? await git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=0", "HEAD", "--", name]) : "";
            const text = readText(file), hunks = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map(match => ({ oldStart: Number(match[1]), oldCount: Number(match[2] ?? 1), start: Number(match[3]), count: Number(match[4] ?? 1) }));
            if (!hunks.length) {
                if (previousFiles.has(name))
                    continue;
                hunks.push({ oldStart: 0, oldCount: 0, start: 1, count: text.split("\n").length });
            }
            snapshots.set(file, text);
            for (const hunk of hunks.filter(hunk => hunk.oldCount > 0 && hunk.count === 0)) {
                const before = await git(["cat-file", "blob", `HEAD:${name}`]);
                const lines = before.split("\n"), low = Math.max(0, hunk.oldStart - 1), high = Math.min(lines.length, low + hunk.oldCount);
                let snippet = lines.slice(low, high).join("\n"), provider = "git";
                if (syntaxLanguage(file) && syntaxTool(dirname(file), args.globalBinsOnly)) {
                    try {
                        snippet = (await syntaxSnippet(file, before, hunk.oldStart, 1, undefined, args.globalBinsOnly)).text;
                        provider = "ast-grep";
                    }
                    catch { /* Git hunk remains exact evidence when no declaration encloses its start. */ }
                }
                removed.push({ file, oldLine: hunk.oldStart, provider, snippet, hint: "Removed source from HEAD; current LSP references cannot establish the complete impact of removed declarations." });
            }
            const context = await acquire(file);
            if (!context.client.capabilities.documentSymbolProvider || !context.client.capabilities.referencesProvider)
                throw new Error(`${context.server.name} lacks documentSymbolProvider/referencesProvider`);
            const declarations = documentSymbols(await requestBefore(context.client, "textDocument/documentSymbol", { textDocument: { uri: context.uri } }, deadline));
            const selected = declarations.filter(symbol => hunks.some(hunk => changed(symbol.range, hunk)));
            const narrowed = selected.filter(symbol => hunks.some(hunk => changed(symbol.selection, hunk)) || !selected.some(child => child !== symbol && child.range.start.line >= symbol.range.start.line && child.range.end.line <= symbol.range.end.line && (child.range.start.line > symbol.range.start.line || child.range.end.line < symbol.range.end.line)));
            for (const symbol of narrowed) {
                if (symbols.length >= MAX_FILES) {
                    bounded = true;
                    break;
                }
                try {
                    const response = await requestBefore(context.client, "textDocument/references", { textDocument: { uri: context.uri }, position: symbol.selection.start, context: { includeDeclaration: false } }, deadline);
                    if (response !== null && !Array.isArray(response))
                        throw new Error("Invalid impact references response");
                    const references = (response ?? []).map(value => {
                        const loc = object(value);
                        if (typeof loc.uri !== "string" || !loc.uri.isWellFormed() || !validRange(loc.range))
                            throw new Error("Invalid impact reference location");
                        return { file: uriFile(loc.uri) ?? loc.uri, line: loc.range.start.line + 1, column: loc.range.start.character + 1 };
                    });
                    symbols.push({ id: String(symbols.length), file, name: symbol.name, kind: symbol.kind, line: symbol.selection.start.line + 1, column: symbol.selection.start.character + 1, referenceCount: references.length, references });
                }
                catch (error) {
                    errors.push({ file, symbol: symbol.name, ...failure(error, args.limit) });
                }
            }
        }
        catch (error) {
            if (!Object.hasOwn(LANGUAGES, extname(file)) && /No available language server/.test(String(error)))
                skipped.push({ file, reason: "No language server for this file type" });
            else
                errors.push({ file, ...failure(error, args.limit) });
        }
        if (bounded)
            break;
    }
    for (const [file, text] of snapshots) {
        try {
            if (readText(file) !== text)
                throw new Error("Changed source modified during impact analysis; rerun with current files");
        }
        catch (error) {
            errors.push({ file, ...failure(error, args.limit) });
            for (let index = symbols.length - 1; index >= 0; index--)
                if (symbols[index].file === file)
                    symbols.splice(index, 1);
        }
    }
    const affected = new Map(), tests = new Map(), sampledEvidence = new Set();
    const candidate = (file, evidence) => {
        if (!tests.has(file))
            tests.set(file, []);
        const entries = tests.get(file), existing = entries.find(entry => entry.kind === evidence.kind && entry.symbolId === evidence.symbolId && entry.changedFile === evidence.changedFile);
        if (existing)
            existing.occurrences = Number(existing.occurrences) + 1;
        else if (entries.length < 10)
            entries.push({ ...evidence, occurrences: 1 });
        else
            sampledEvidence.add(file);
    };
    for (const symbol of symbols)
        for (const ref of symbol.references) {
            if (!affected.has(ref.file))
                affected.set(ref.file, new Set());
            affected.get(ref.file).add(String(symbol.id));
            if (isAbsolute(ref.file) && insideWorkspace(root, ref.file) && testPath(relative(root, ref.file)))
                candidate(ref.file, { kind: "reference", symbol: symbol.name, symbolId: symbol.id, line: ref.line, column: ref.column });
        }
    for (const file of [...paths, ...deleted.map(name => join(root, name))]) {
        const stem = basename(file, extname(file)).toLowerCase();
        for (const name of inventory) {
            const absolute = join(root, name), base = basename(name).toLowerCase();
            if (testPath(name) && [stem + ".test.", stem + ".spec.", "test_" + stem + ".", stem + "_test."].some(prefix => base.startsWith(prefix)) && insideWorkspace(root, absolute))
                candidate(absolute, { kind: "filename-convention", changedFile: file });
        }
    }
    const inlineCache = new Map();
    let inlineScans = 0, inlineScanLimited = false;
    for (const symbol of symbols)
        for (const ref of symbol.references) {
            if (!isAbsolute(ref.file) || !insideWorkspace(root, ref.file) || testPath(relative(root, ref.file)) || !["Rust", "Python"].includes(syntaxLanguage(ref.file) ?? "") || !syntaxTool(dirname(ref.file), args.globalBinsOnly))
                continue;
            const previous = inlineCache.get(ref.file)?.find(entry => entry.start <= ref.line && ref.line <= entry.end);
            let isTest = previous?.test;
            if (isTest === undefined) {
                if (inlineScans >= 20 || Date.now() >= deadline) {
                    inlineScanLimited = true;
                    continue;
                }
                inlineScans++;
                try {
                    const snippet = await syntaxSnippet(ref.file, readText(ref.file), ref.line, ref.column, undefined, args.globalBinsOnly);
                    isTest = /^\s*#\[(?:(?:tokio|async_std)::)?test(?:\s*\(|\s*\])/m.test(snippet.text) || /^\s*(?:async )?def test_\w+/m.test(snippet.text);
                    if (!inlineCache.has(ref.file))
                        inlineCache.set(ref.file, []);
                    inlineCache.get(ref.file).push({ start: snippet.start.line + 1, end: snippet.end.line + 1, test: isTest });
                }
                catch { /* Filename and direct-reference evidence remains available without an enclosing declaration. */ }
            }
            if (isTest)
                candidate(ref.file, { kind: "enclosing-test", symbol: symbol.name, symbolId: symbol.id, line: ref.line, column: ref.column });
        }
    let stable = true;
    for (const [file, text] of snapshots) {
        try {
            if (readText(file) !== text)
                throw new Error("Source changed while collecting test evidence; retry impact");
        }
        catch (error) {
            stable = false;
            errors.push({ file, ...failure(error, args.limit) });
        }
    }
    if (!stable) {
        symbols.length = 0;
        affected.clear();
        tests.clear();
        removed.length = 0;
    }
    const limit = (values) => args.limit ? values.slice(0, args.limit) : values;
    const selected = limit(symbols).map(symbol => ({ ...symbol, references: limit(symbol.references) }));
    const { items: visibleSymbols, ...symbolPreview } = compactText(selected, ["name"], args.limit);
    const affectedFiles = limit([...affected].map(([file, reasons]) => ({ file, symbolIds: limit([...reasons]), symbolCount: reasons.size })));
    const candidateTests = limit([...tests].sort((a, b) => Number(b[1].some(e => e.kind === "reference")) - Number(a[1].some(e => e.kind === "reference")) || a[0].localeCompare(b[0])).map(([file, evidence]) => ({ file, evidence, ...(sampledEvidence.has(file) ? { evidenceSampled: true } : {}) })));
    const deletedFiles = deleted.map(name => ({ file: join(root, name), hint: "Deleted file; review removed API/imports and run project checks" }));
    const { items: removedContexts, ...removedPreview } = compactText(limit(removed), ["snippet"], args.limit);
    const truncated = bounded || selected.length < symbols.length || selected.some(symbol => symbol.references.length < Number(symbol.referenceCount)) || affectedFiles.length < affected.size || affectedFiles.some(file => file.symbolIds.length < file.symbolCount) || candidateTests.length < tests.size || sampledEvidence.size > 0 || removedContexts.length < removed.length || !!symbolPreview.truncated || !!removedPreview.truncated;
    const verified = !errors.length && !bounded && !deletedFiles.length && !removed.length;
    const hint = "Static reference and filename evidence yields candidate tests. Run relevant project checks; dynamic calls, excluded targets and removed APIs require review.";
    return { data: { success: !errors.length, verified, complete: !bounded, applied: false, root, truncated, bounded,
            counts: { changedFiles: paths.length, changedSymbols: symbols.length, references: symbols.reduce((n, s) => n + Number(s.referenceCount), 0), affectedFiles: affected.size, candidateTests: tests.size, deletedFiles: deletedFiles.length },
            changedSymbols: visibleSymbols, affectedFiles, candidateTests, deletedFiles, removedContexts, skipped, errors, inlineTestScan: { checked: inlineScans, limited: inlineScanLimited }, hint }, code: errors.length ? 1 : 0,
        human: [`Impact: ${symbols.length} changed symbol(s), ${affected.size} referenced file(s), ${tests.size} candidate test file(s)`,
            ...visibleSymbols.map(symbol => `${symbol.file}:${symbol.line} ${symbol.name}: ${symbol.referenceCount} reference(s)`),
            ...candidateTests.map(test => `TEST ${test.file}: ${test.evidence.map(e => e.kind).join(", ")}`),
            ...errors.map(error => `ERROR ${error.file}: ${error.error}`), ...deletedFiles.map(file => `DELETED ${file.file}`),
            ...removedContexts.map(item => `REMOVED ${item.file}:${item.oldLine}\n${args.limit ? textPrefix(String(item.snippet), 6000) : item.snippet}`), hint,
        ].join("\n") };
}
