import { object, MAX_FILES } from "./config.js";
import { textPrefix } from "./output.js";
import { validRange } from "./semantic.js";
import { isDeepStrictEqual } from "node:util";
const versions = new WeakMap();
const methods = { computed: "typeServer/getComputedType", declared: "typeServer/getDeclaredType", expected: "typeServer/getExpectedType" };
const integer = (value) => Number.isSafeInteger(value) && Number(value) >= 0;
const string = (value) => typeof value === "string" && value.isWellFormed();
const uri = (value) => {
    if (!string(value) || /[\x00-\x20\x7f]/.test(value))
        return false;
    try {
        return !!new URL(value).protocol;
    }
    catch {
        return false;
    }
};
export function typeServerVersion(client, deadline) {
    let version = versions.get(client);
    if (!version) {
        version = client.request("typeServer/getSupportedProtocolVersion", undefined, Math.max(1, deadline - Date.now())).then(value => {
            if (!string(value) || !/^0\.4\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value))
                throw Object.assign(new Error(`Unsupported TSP protocol version ${JSON.stringify(value)}; this client supports stable 0.4.x`), { supported: false });
            return value;
        }).catch(error => {
            if (object(error).code === -32601) {
                const types = client.server.fileTypes ?? [];
                const hint = types.some(type => /^\.pyi?$/.test(type)) ? 'Pyrefly requires "pyrefly tsp". Run codex-lsp setup pyrefly-tsp and use --server pyrefly-tsp'
                    : types.includes(".rs") ? "For Rust, use types --server rust-analyzer-api or hover/type-definition" : "Choose a TSP provider matching this file type, or use hover/type-definition";
                throw Object.assign(new Error(`${client.server.name} does not serve TSP; ${hint}`), { supported: false });
            }
            if (object(error).supported !== false)
                versions.delete(client);
            throw error;
        });
        versions.set(client, version);
    }
    return version;
}
// Validate the response-local graph before exposing handles or rendering Python stub text.
export function typeGraph(value) {
    const definitions = new Map(), references = [];
    let count = 0;
    const require = (valid, field = "type") => { if (!valid)
        throw new Error(`Invalid TSP type graph: ${field}`); };
    const node = (value) => { const row = object(value); require(uri(row.uri) && validRange(row.range)); };
    const declaration = (value) => {
        const row = object(value);
        if (row.kind === 0) {
            require(integer(row.category) && Number(row.category) <= 7 && (row.name == null || string(row.name)));
            node(row.node);
        }
        // Pyrefly leaves the URI empty for generated Callables without a source declaration.
        else
            require(row.kind === 1 && (row.uri === "" || uri(row.uri)), "synthesized declaration URI");
    };
    const types = (value, depth, nullable = false) => {
        require(Array.isArray(value));
        for (const item of value)
            if (item != null || !nullable)
                visit(item, depth + 1);
    };
    const visit = (value, depth) => {
        require(++count <= MAX_FILES * 10 && depth <= 64, "exceeds 2000 nodes or 64 levels");
        const row = object(value);
        require(integer(row.id) && integer(row.kind) && Number(row.kind) <= 10 && integer(row.flags), "id/kind/flags");
        if (row.kind === 9) {
            require(integer(row.typeReferenceId));
            references.push(Number(row.typeReferenceId));
        }
        else {
            const previous = definitions.get(Number(row.id));
            if (previous) {
                require(isDeepStrictEqual(previous, row), `conflicting definitions for type ID ${row.id}`);
                return;
            }
            definitions.set(Number(row.id), row);
        }
        if (row.typeAliasInfo != null) {
            const alias = object(row.typeAliasInfo);
            require(["name", "fullName", "moduleName", "scopeId"].every(key => string(alias[key])) && uri(alias.fileUri) && typeof alias.isTypeAliasType === "boolean");
            for (const key of ["typeParams", "typeArgs"])
                if (alias[key] != null)
                    types(alias[key], depth);
            if (alias.computedVariance != null)
                require(Array.isArray(alias.computedVariance) && alias.computedVariance.every(value => integer(value) && Number(value) <= 4));
        }
        if ([1, 2, 3, 6].includes(Number(row.kind)) || row.declaration != null)
            declaration(row.declaration);
        for (const key of ["possibleType", "returnType", "boundToType", "implementation"])
            if (row[key] != null)
                visit(row[key], depth + 1);
        if (row.kind === 0)
            require(string(row.name) && ["unknown", "any", "unbound", "ellipsis", "never", "noreturn"].includes(row.name));
        if (row.kind === 2 && row.specializedTypes != null) {
            const specialized = object(row.specializedTypes);
            types(specialized.parameterTypes, depth);
            if (specialized.parameterDefaultTypes != null)
                types(specialized.parameterDefaultTypes, depth, true);
            if (specialized.returnType != null)
                visit(specialized.returnType, depth + 1);
        }
        if (row.kind === 3) {
            if (row.typeArgs != null)
                types(row.typeArgs, depth);
            const literal = row.literalValue;
            if (literal != null && !string(literal) && typeof literal !== "boolean" && !(typeof literal === "number" && Number.isFinite(literal))) {
                const item = object(literal);
                require(string(item.className));
                if (item.itemType !== undefined) {
                    require(string(item.itemName));
                    visit(item.itemType, depth + 1);
                }
                else {
                    require(string(item.moduleName));
                    node(item.classNode);
                }
            }
        }
        if (row.kind === 4)
            types(row.subTypes, depth);
        if (row.kind === 5)
            require(string(row.moduleName) && uri(row.uri));
        if (row.kind === 7)
            types(row.overloads, depth);
        if (row.kind === 8) {
            const metadata = object(row.metadata);
            require(string(row.stubContent) && integer(metadata.primaryDefinitionOffset) && Number(metadata.primaryDefinitionOffset) <= row.stubContent.length && object(metadata.module).kind === 5);
            visit(metadata.module, depth + 1);
        }
        if (row.kind === 10) {
            require(["any", "unknown"].includes(String(row.uncertaintyKind)));
            types(row.candidates, depth);
            visit(row.baselineType, depth + 1);
        }
    };
    visit(value, 0);
    require(references.every(id => definitions.has(id)), "dangling type reference");
    const seen = new Set();
    const describe = (value, depth = 0) => {
        const row = object(value), id = Number(row.id);
        if (depth >= 12 || seen.has(id))
            return `#${id}`;
        seen.add(id);
        let text;
        if (row.kind === 9)
            text = describe(definitions.get(Number(row.typeReferenceId)), depth + 1);
        else if (string(object(row.typeAliasInfo).name))
            text = String(object(row.typeAliasInfo).name);
        else if (row.kind === 0)
            text = { any: "Any", unknown: "Unknown", unbound: "Unbound", ellipsis: "...", never: "Never", noreturn: "NoReturn" }[String(row.name)];
        else if (row.kind === 4) {
            const parts = row.subTypes.slice(0, 20).map(item => describe(item, depth + 1)), unique = [...new Set(parts)];
            text = unique.join(" | ") + (unique.length < parts.length ? ` (${parts.length} variants)` : "") + (row.subTypes.length > 20 ? " | …" : "");
        }
        else if (row.kind === 5)
            text = String(row.moduleName);
        else if (row.kind === 8)
            text = textPrefix(String(row.stubContent), 1000);
        else if (row.kind === 7 || row.kind === 10)
            text = row.kind === 7 ? `overload (${row.overloads.length})` : `overload result (${row.uncertaintyKind})`;
        else {
            text = String(object(row.declaration).name ?? "synthesized declaration");
            if (row.kind === 3 && row.typeArgs != null)
                text += `[${row.typeArgs.slice(0, 20).map(item => describe(item, depth + 1)).join(", ")}]`;
            if (row.kind === 3 && row.literalValue != null && typeof row.literalValue !== "object")
                text += ` (${JSON.stringify(row.literalValue)})`;
            if (row.kind === 3 && object(row.literalValue).itemName !== undefined)
                text = `${object(row.literalValue).className}.${object(row.literalValue).itemName}`;
            if (row.kind === 3 && (Number(row.flags) & 8) && row.literalValue == null)
                text += " (literal value unavailable)";
            if (row.kind === 2) {
                const specialized = object(row.specializedTypes), result = specialized.returnType ?? row.returnType;
                const parameters = Array.isArray(specialized.parameterTypes) ? specialized.parameterTypes.slice(0, 20).map(item => describe(item, depth + 1)).join(", ") : "...";
                text = object(row.declaration).kind === 1 ? `Callable[${Array.isArray(specialized.parameterTypes) ? `[${parameters}]` : parameters}, ${result ? describe(result, depth + 1) : "Unknown"}]`
                    : `${text}(${parameters})${result ? ` -> ${describe(result, depth + 1)}` : ""}`;
            }
        }
        seen.delete(id);
        return textPrefix(text, 1000);
    };
    return { type: value, summary: describe(value) };
}
export async function queryType(args, client, uri, range) {
    const view = args.view ?? "computed", method = methods[view], deadline = Date.now() + args.timeout;
    if (!Object.hasOwn(methods, view))
        throw new Error("types --view must be computed, declared or expected");
    const state = { provider: "tsp", server: client.server.name, view, cursor: { line: range.start.line + 1, column: range.start.character + 1 } };
    let protocolVersion;
    try {
        protocolVersion = await typeServerVersion(client, deadline);
    }
    catch (error) {
        if (object(error).supported !== false)
            throw error;
        const hint = error instanceof Error ? error.message : String(error);
        return { code: 1, data: { success: false, supported: false, found: false, ...state, hint }, human: hint };
    }
    const request = (method, params) => {
        if (Date.now() >= deadline)
            throw new Error("TSP query timed out; retry after analysis settles");
        if (client.typeServer.error)
            throw client.typeServer.error;
        return client.request(method, params, Math.max(1, deadline - Date.now()));
    };
    for (let attempt = 0; attempt < 3; attempt++) {
        const generation = client.typeServer.generation;
        try {
            const snapshot = await request("typeServer/getSnapshot");
            if (!integer(snapshot))
                throw new Error("Invalid TSP snapshot identifier");
            if (Number(snapshot) < client.typeServer.snapshot) {
                if (generation !== client.typeServer.generation)
                    continue;
                throw new Error("TSP snapshot regressed; start a fresh session");
            }
            client.typeServer.snapshot = Number(snapshot);
            const current = client.typeServer.generation;
            const value = await request(method, { arg: { uri, range }, snapshot });
            if (client.typeServer.error)
                throw client.typeServer.error;
            if (current !== client.typeServer.generation || snapshot !== client.typeServer.snapshot)
                continue;
            const found = value != null, graph = found ? typeGraph(value) : { type: null, summary: "No type returned" };
            const data = { success: true, supported: true, found, ...state, protocolVersion, snapshot, ...graph,
                ...(attempt ? { retries: attempt } : {}),
                ...(!found ? { hint: `No ${view} type at this node. Try an expression/argument with --range, or inspect its declaration with hover.` } : {}) };
            return { data, human: `${client.server.name} TSP ${protocolVersion} (${view}, snapshot ${snapshot})\n${graph.summary}${!found ? `\n${data.hint}` : ""}` };
        }
        catch (error) {
            if (object(error).code === -32601) {
                const hint = `${client.server.name} does not implement ${method}; select another TSP provider or use hover for a separate LSP query`;
                return { code: 1, data: { success: false, supported: false, found: false, ...state, protocolVersion, hint }, human: hint };
            }
            if (![-32801, -32802].includes(Number(object(error).code)))
                throw error;
        }
    }
    throw new Error("TSP snapshot kept changing after 3 attempts; retry after analysis settles");
}
