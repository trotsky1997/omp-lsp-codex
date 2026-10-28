var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { MessageFramer, encodeMessageFrame } from "./omp/message-framing.js";
import { MAX_FILE_BYTES, object, uriFile } from "./config.js";
import { validRange } from "./semantic.js";
import { textPrefix } from "./output.js";
async function serve() {
    const [compilerPath, config] = process.argv.slice(2);
    const require = createRequire(compilerPath), legacy = require(compilerPath);
    let api = legacy, Native;
    if (typeof legacy.createLanguageService !== "function") {
        let path, astPath;
        for (const prefix of ["typescript", "typescript/unstable"]) {
            try {
                path = require.resolve(prefix + "/sync");
                astPath = require.resolve(prefix + "/ast");
                break;
            }
            catch (error) {
                if (!["MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED"].includes(String(object(error).code)))
                    throw error;
            }
        }
        if (!path || !astPath)
            throw new Error(`Unsupported TypeScript API at ${compilerPath}; install a compiler providing Compiler API 5/6 or TypeScript 7 sync/ast exports`);
        const native = await import(__rewriteRelativeImportExtension(pathToFileURL(path).href)), ast = await import(__rewriteRelativeImportExtension(pathToFileURL(astPath).href));
        Native = native.API;
        api = { ...ast, ...native, version: legacy.version, TypeFormatFlags: { NoTruncation: native.NodeBuilderFlags.NoTruncation },
            isParameter: ast.isParameterDeclaration,
            isPropertySignature: ast.isPropertySignatureDeclaration,
            forEachChild: (node, visit) => node.forEachChild(visit),
            sys: { readFile: (file) => { try {
                    return readFileSync(file, "utf8");
                }
                catch (error) {
                    if (["ENOENT", "ENOTDIR"].includes(String(object(error).code)))
                        return undefined;
                    throw error;
                } },
                fileExists: (file) => { try {
                    return statSync(file).isFile();
                }
                catch {
                    return false;
                } },
                directoryExists: (file) => { try {
                    return statSync(file).isDirectory();
                }
                catch {
                    return false;
                } } },
        };
    }
    const opened = new Map(), reads = new Map(), existence = new Map(), directories = new Map();
    let options = {}, files = [], references, configuration = "", revision = 0;
    const disk = (file) => {
        try {
            return readFileSync(file, "utf8");
        }
        catch (error) {
            if (["ENOENT", "ENOTDIR"].includes(String(object(error).code)))
                return undefined;
            throw error;
        }
    };
    const read = (file) => {
        file = resolve(file);
        if (!reads.has(file))
            reads.set(file, opened.get(file) ?? disk(file));
        return reads.get(file);
    };
    const host = {
        ...api.sys, readFile: read,
        fileExists: file => { const exists = api.sys.fileExists(file); existence.set(resolve(file), exists); return exists; },
        directoryExists: directory => { const exists = api.sys.directoryExists(directory); directories.set(resolve(directory), exists); return exists; },
        getCompilationSettings: () => options, getScriptFileNames: () => files,
        getProjectReferences: () => references, getProjectVersion: () => String(revision),
        getScriptVersion: file => createHash("sha256").update(read(file) ?? "missing").digest("hex"),
        getScriptSnapshot: file => { const text = read(file); return text === undefined ? undefined : api.ScriptSnapshot.fromString(text); },
        getCurrentDirectory: () => process.cwd(), getDefaultLibFileName: settings => api.getDefaultLibFilePath(settings),
        useCaseSensitiveFileNames: () => api.sys.useCaseSensitiveFileNames,
    };
    const service = Native ? undefined : api.createLanguageService(host);
    const native = Native ? new Native({ cwd: process.cwd(), fs: { readFile: (file) => read(file)?.replace(/^\uFEFF/, "") ?? null, fileExists: host.fileExists, directoryExists: host.directoryExists } }) : undefined;
    const nativeFiles = new Set();
    let snapshot;
    const close = () => { snapshot?.dispose(); native?.close(); service?.dispose(); };
    const diagnostic = (items) => items.map(item => api.flattenDiagnosticMessageText(item.messageText, "\n")).join("\n");
    const query = (params) => {
        const file = typeof params.uri === "string" ? uriFile(params.uri) : undefined;
        if (!file || !opened.has(file) || !validRange(params.range) || !["computed", "declared", "expected"].includes(String(params.view)) || !Number.isSafeInteger(params.limit) || Number(params.limit) < 0)
            throw new Error("Invalid TypeScript type query");
        const modified = [...reads].filter(([file, text]) => disk(file) !== text).map(([file]) => file);
        const created = [...existence].filter(([file, exists]) => !exists && api.sys.fileExists(file)).map(([file]) => file);
        const deleted = [...existence].filter(([file, exists]) => exists && !api.sys.fileExists(file)).map(([file]) => file);
        const directoryChanges = [...directories].filter(([file, exists]) => api.sys.directoryExists(file) !== exists).map(([file]) => file);
        const changed = !!(modified.length || created.length || deleted.length || directoryChanges.length);
        if (changed) {
            reads.clear();
            existence.clear();
            directories.clear();
        }
        if (!native && config) {
            const loaded = api.readConfigFile(config, read);
            if (loaded.error)
                throw new Error(`Invalid tsconfig ${config}: ${diagnostic([loaded.error])}`);
            const parsed = api.parseJsonConfigFileContent(loaded.config, { ...api.sys, readFile: read }, process.cwd(), undefined, config);
            const errors = parsed.errors.filter(error => error.code !== 18003);
            if (errors.length)
                throw new Error(`Invalid tsconfig ${config}: ${diagnostic(errors)}`);
            options = parsed.options;
            files = parsed.fileNames;
            references = parsed.projectReferences;
        }
        else if (!native) {
            options = { target: api.ScriptTarget.ESNext, module: api.ModuleKind.NodeNext, moduleResolution: api.ModuleResolutionKind.NodeNext, strict: true, allowJs: true, noEmit: true };
            files = [file];
        }
        const currentConfiguration = JSON.stringify([options, files, references]);
        // Invalidate semantic caches when imports/config change, including a previously missing dependency.
        if (configuration !== currentConfiguration || changed) {
            revision++;
            service?.cleanupSemanticCache();
        }
        configuration = currentConfiguration;
        let project;
        if (native) {
            const previous = snapshot;
            const introduced = previous ? [...opened.keys()].filter(file => !nativeFiles.has(file)) : [];
            const closed = [...nativeFiles].filter(file => !opened.has(file));
            snapshot = native.updateSnapshot({ ...(config ? { openProjects: [config] } : {}), openFiles: [file], closeFiles: closed,
                fileChanges: { changed: modified.filter(file => api.sys.fileExists(file)), created: [...new Set([...created, ...introduced, ...directoryChanges.filter(file => api.sys.directoryExists(file))])], deleted: [...new Set([...deleted, ...modified.filter(file => !api.sys.fileExists(file)), ...directoryChanges.filter(file => !api.sys.directoryExists(file))])] } });
            for (const file of closed)
                nativeFiles.delete(file);
            for (const file of opened.keys())
                nativeFiles.add(file);
            previous?.dispose();
            project = config ? snapshot.getProject(config) : snapshot.getDefaultProjectForFile(file);
        }
        const program = project?.program ?? service?.getProgram(), source = program?.getSourceFile(file);
        if (!program || !source)
            throw new Error(`File is outside the selected TypeScript project: ${file}; selected config: ${config || "inferred"}. Query a file included by this tsconfig or its imports.`);
        const offset = (point) => {
            const lines = source.text.split("\n").map(line => line.replace(/\r$/, ""));
            const character = point.character - (point.line === 0 && opened.get(file)?.startsWith("\uFEFF") && !source.text.startsWith("\uFEFF") ? 1 : 0);
            if (!lines[point.line] && lines[point.line] !== "" || character < 0 || character > lines[point.line].length || /[\uDC00-\uDFFF]/.test(lines[point.line][character] ?? ""))
                throw new Error("Invalid TypeScript UTF-16 range");
            return source.getPositionOfLineAndCharacter(point.line, character);
        };
        let start = offset(params.range.start), end = offset(params.range.end);
        if (end > start) {
            while (start < end && /\s/.test(source.text[start]))
                start++;
            while (end > start && /\s/.test(source.text[end - 1]))
                end--;
        }
        let node;
        const find = (current) => {
            if (current.getStart(source) > start || current.end < end || end === start && current.end <= start)
                return;
            node = current;
            api.forEachChild(current, find);
        };
        find(source);
        if (node === source)
            node = undefined;
        const checker = project?.checker ?? program.getTypeChecker();
        let type, declarationSource;
        if (node) {
            if (params.view === "computed") {
                if (api.isExpression(node) || api.isTypeNode(node) || object(node).name !== undefined)
                    type = checker.getTypeAtLocation(node);
            }
            else if (params.view === "expected") {
                if (api.isPropertyAccessExpression(node.parent) && node.parent.name === node)
                    node = node.parent;
                if (api.isExpression(node))
                    type = checker.getContextualType(node);
            }
            else {
                let symbol = checker.getSymbolAtLocation(node);
                if (symbol?.flags && (symbol.flags & api.SymbolFlags.Alias))
                    symbol = checker.getAliasedSymbol(symbol);
                const handle = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
                const declaration = handle && typeof object(handle).resolve === "function" ? object(handle).resolve.call(handle) : handle;
                if (symbol && declaration) {
                    if ((api.isVariableDeclaration(declaration) || api.isParameter(declaration) || api.isPropertyDeclaration(declaration) || api.isPropertySignature(declaration)) && declaration.type) {
                        type = checker.getTypeFromTypeNode(declaration.type);
                        declarationSource = "annotation";
                    }
                    else if (api.isTypeAliasDeclaration(declaration) || api.isInterfaceDeclaration(declaration) || api.isClassDeclaration(declaration)) {
                        type = checker.getDeclaredTypeOfSymbol(symbol);
                        declarationSource = "type-definition";
                    }
                    else {
                        type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
                        declarationSource = "inferred";
                    }
                }
            }
        }
        const limit = Number(params.limit), maximum = Math.min(limit || 200, 200);
        let clipped = false;
        const describe = (type) => {
            const text = checker.typeToString(type, node, api.TypeFormatFlags.NoTruncation);
            const shown = limit ? textPrefix(text, 6000) : text;
            clipped ||= shown.length < text.length;
            return shown;
        };
        const summary = type ? describe(type) : "No type returned";
        let detail = null;
        if (type) {
            const properties = checker.getPropertiesOfType(type), signatures = checker.getSignaturesOfType(type, api.SignatureKind.Call);
            const union = !!(type.flags & (api.TypeFlags.Union | api.TypeFlags.Intersection));
            const parts = union ? native ? object(type).getTypes.call(type) : type.types : [];
            detail = { text: summary, flags: type.flags,
                ...(union ? { [type.flags & api.TypeFlags.Union ? "union" : "intersection"]: parts.slice(0, maximum).map(describe), totalTypes: parts.length } : {}),
                properties: properties.slice(0, maximum).map(symbol => ({ name: symbol.name, type: describe(checker.getTypeOfSymbolAtLocation(symbol, node)), optional: !!(symbol.flags & api.SymbolFlags.Optional) })),
                signatures: signatures.slice(0, maximum).map(signature => ({ parameters: signature.getParameters().slice(0, maximum).map(symbol => ({ name: symbol.name, type: describe(checker.getTypeOfSymbolAtLocation(symbol, node)) })), parameterCount: signature.getParameters().length, returns: describe(checker.getReturnTypeOfSignature(signature)) })),
                totalProperties: properties.length, totalSignatures: signatures.length };
            clipped ||= properties.length > maximum || signatures.length > maximum || signatures.some(signature => signature.getParameters().length > maximum) || parts.length > maximum;
        }
        if ([...reads].some(([file, text]) => disk(file) !== text))
            throw Object.assign(new Error("Source or dependency changed during TypeScript query"), { code: -32801 });
        const call = node && api.isCallExpression(node) ? node : node && api.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : undefined;
        const ranges = !type && call ? call.arguments.slice(0, 3).map(argument => {
            const point = (offset) => { const p = source.getLineAndCharacterOfPosition(offset); return `${p.line + 1}:${p.character + 1 + (p.line === 0 && opened.get(file)?.startsWith("\uFEFF") && !source.text.startsWith("\uFEFF") ? 1 : 0)}`; };
            return `${point(argument.getStart(source))}-${point(argument.end)}`;
        }) : [];
        return { success: true, supported: true, found: !!type, provider: "typescript-api", server: "typescript-api", compilerVersion: api.version, compilerPath, tsconfig: config || null,
            view: params.view, snapshot: ++revision, cursor: { line: params.range.start.line + 1, column: params.range.start.character + 1 }, summary, type: detail,
            ...(declarationSource ? { declarationSource } : {}), ...(clipped ? { truncated: true, hint: "Type details sampled (at most 200 members); --limit 0 removes text clipping and --budget bounds the response." } : {}),
            ...(!type ? { hint: `No ${params.view} type for selected ${node ? api.SyntaxKind[node.kind] : "source position"}; select the argument/RHS expression for expected, or a symbol's declaration for declared.${ranges.length ? ` Argument ranges:\n${ranges.map(range => "--range " + range).join("\n")}` : ""}` } : {}) };
    };
    const send = (message) => new Promise((resolve, reject) => process.stdout.write(encodeMessageFrame(message), error => error ? reject(error) : resolve()));
    const framer = new MessageFramer(Buffer.alloc(0));
    for await (const chunk of process.stdin) {
        framer.push(chunk);
        for (const text of framer.drain(() => { })) {
            const message = object(JSON.parse(text)), params = object(message.params);
            try {
                let result = null;
                if (message.method === "initialize")
                    result = { capabilities: { textDocumentSync: 1 } };
                else if (message.method === "textDocument/didOpen" || message.method === "textDocument/didChange") {
                    const document = object(params.textDocument), file = typeof document.uri === "string" ? uriFile(document.uri) : undefined;
                    const content = message.method === "textDocument/didOpen" ? document.text : object(params.contentChanges?.[0]).text;
                    if (!file || typeof content !== "string" || !content.isWellFormed() || Buffer.byteLength(content) > MAX_FILE_BYTES)
                        throw new Error("Invalid TypeScript document");
                    opened.set(file, content);
                }
                else if (message.method === "textDocument/didClose") {
                    const file = uriFile(String(object(params.textDocument).uri));
                    if (file)
                        opened.delete(file);
                }
                else if (message.method === "codex/types")
                    result = query(params);
                else if (message.method === "shutdown")
                    close();
                else if (message.method === "exit")
                    return;
                else if (message.id !== undefined)
                    throw Object.assign(new Error(`Unsupported TypeScript backend request: ${message.method}`), { code: -32601 });
                if (message.id !== undefined) {
                    if (Buffer.byteLength(JSON.stringify(result)) > MAX_FILE_BYTES)
                        throw new Error("TypeScript response exceeds 16 MiB; use --limit to narrow details");
                    await send({ jsonrpc: "2.0", id: message.id, result });
                }
            }
            catch (error) {
                if (message.id !== undefined)
                    await send({ jsonrpc: "2.0", id: message.id, error: { code: Number.isSafeInteger(object(error).code) ? object(error).code : -32603, message: error instanceof Error ? error.message : String(error) } });
            }
        }
    }
    close();
}
if (import.meta.main)
    serve().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
