import { object, uriFile, MAX_FILES } from "./config.js";
import { compactText, failure } from "./output.js";
import { comparePosition, requestBefore, validPosition, validRange } from "./semantic.js";
export function unsupportedFeature(client, feature) {
    const candidates = feature === "inlayHintProvider" ? [["hover", "hoverProvider"], ["signature-help", "signatureHelpProvider"]]
        : [["definition", "definitionProvider"], ["implementation", "implementationProvider"], ["type-definition", "typeDefinitionProvider"]];
    const alternatives = candidates.filter(([, capability]) => capability !== feature && client.capabilities[capability]).map(([command]) => command);
    if (!alternatives.length)
        alternatives.push("snippet");
    const hint = `${feature} is unavailable from ${client.server.name} (${client.server.resolvedCommand}). Use ${alternatives.join("/")} for focused queries; check capabilities or select another configured server`;
    return { data: { success: false, supported: false, found: false, server: client.server.name, executable: client.server.resolvedCommand, alternatives, hint }, code: 1, human: hint };
}
function hierarchyItem(value) {
    const item = object(value);
    if (typeof item.name !== "string" || !item.name || !item.name.isWellFormed() || typeof item.uri !== "string" || !item.uri || !item.uri.isWellFormed() ||
        !Number.isSafeInteger(item.kind) || Number(item.kind) < 1 || !validRange(item.range) || !validRange(item.selectionRange) ||
        (comparePosition(item.range.start, item.selectionRange.start) > 0 && comparePosition(item.selectionRange.end, item.range.start) > 0) ||
        comparePosition(item.selectionRange.end, item.range.end) > 0 || item.detail !== undefined && (typeof item.detail !== "string" || !item.detail.isWellFormed()))
        throw new Error("Invalid type hierarchy item");
    return item;
}
export async function typeHierarchy(args, client, uri, position) {
    if (!client.capabilities.typeHierarchyProvider)
        return unsupportedFeature(client, "typeHierarchyProvider");
    if (!["supertypes", "subtypes"].includes(args.command))
        throw new Error("Type hierarchy requires supertypes or subtypes");
    const depth = args.depth ?? 1, deadline = Date.now() + args.timeout;
    if (!Number.isSafeInteger(depth) || depth < 1 || depth > 10)
        throw new Error("Type hierarchy depth must be 1-10");
    const initial = await requestBefore(client, "textDocument/prepareTypeHierarchy", { textDocument: { uri }, position }, deadline);
    if (initial !== null && !Array.isArray(initial))
        throw new Error("Invalid prepareTypeHierarchy response");
    const nodes = [], edges = [], errors = [], roots = [];
    const items = new Map();
    let bounded = false;
    const add = (value, level) => {
        const item = hierarchyItem(value), key = JSON.stringify([item.uri, item.selectionRange, item.name]);
        let entry = items.get(key);
        if (!entry && items.size < MAX_FILES) {
            entry = { item, id: String(items.size), depth: level };
            items.set(key, entry);
            nodes.push({ id: entry.id, name: item.name, kind: item.kind, file: uriFile(item.uri) ?? item.uri,
                line: item.selectionRange.start.line + 1, column: item.selectionRange.start.character + 1,
                ...(comparePosition(item.selectionRange.start, item.range.start) < 0 ? { selectionBeforeRange: true } : {}),
                ...(item.detail !== undefined ? { detail: item.detail } : {}) });
        }
        if (!entry)
            bounded = true;
        return entry;
    };
    for (const value of initial ?? []) {
        const entry = add(value, 0);
        if (!entry)
            break;
        if (!roots.includes(entry.id))
            roots.push(entry.id);
    }
    const visited = new Set(), seenEdges = new Set(), method = `typeHierarchy/${args.command}`;
    for (const entry of items.values()) {
        if (bounded)
            break;
        if (entry.depth >= depth || visited.has(entry.id))
            continue;
        visited.add(entry.id);
        try {
            const response = await requestBefore(client, method, { item: entry.item }, deadline);
            if (response !== null && !Array.isArray(response))
                throw new Error(`Invalid ${method} response`);
            for (const value of response ?? []) {
                const target = add(value, entry.depth + 1);
                if (!target)
                    break;
                const from = args.command === "supertypes" ? entry.id : target.id, to = args.command === "supertypes" ? target.id : entry.id, key = `${from}:${to}`;
                if (seenEdges.has(key))
                    continue;
                if (edges.length >= MAX_FILES * 5) {
                    bounded = true;
                    break;
                }
                seenEdges.add(key);
                edges.push({ from, to });
            }
        }
        catch (error) {
            errors.push({ node: entry.id, ...failure(error, args.limit) });
            if (/timed out|deadline/i.test(String(error)))
                bounded = true;
        }
        if (Date.now() >= deadline) {
            bounded = true;
            break;
        }
    }
    const selected = args.limit ? nodes.slice(0, Math.max(roots.length, args.limit)) : nodes, ids = new Set(selected.map(node => node.id));
    const shownEdges = edges.filter(edge => ids.has(edge.from) && ids.has(edge.to));
    const { items: previewItems, ...preview } = compactText([...selected, ...errors], ["name", "detail", "error", "hint"], args.limit);
    const visibleNodes = previewItems.slice(0, selected.length), visibleErrors = previewItems.slice(selected.length);
    const truncated = bounded || selected.length < nodes.length || shownEdges.length < edges.length || !!preview.truncated;
    const hint = truncated ? "Type graph sampled or bounded (200 nodes, 1000 edges); --limit 0 removes display limits. --depth controls traversal." : undefined;
    return { data: { success: !errors.length, supported: true, found: !!roots.length, server: client.server.name, direction: args.command,
            depth, roots, total: nodes.length, shown: selected.length, totalEdges: edges.length, shownEdges: shownEdges.length,
            complete: !bounded && !errors.length, bounded, ...preview, truncated, ...(hint ? { hint } : {}), nodes: visibleNodes, edges: shownEdges, errors: visibleErrors }, code: errors.length ? 1 : 0,
        human: [`${args.command}: ${nodes.length} node(s), ${edges.length} edge(s), depth ${depth} (subtype -> supertype)`,
            ...visibleNodes.map(node => `[${node.id}] ${node.name} ${node.file}:${node.line}:${node.column}`),
            ...shownEdges.map(edge => `${edge.from} -> ${edge.to}`), ...visibleErrors.map(error => `ERROR [${error.node}]: ${error.error}`), hint].filter(Boolean).join("\n") };
}
function markup(value) {
    if (value === undefined)
        return;
    if (typeof value === "string" && value.isWellFormed())
        return value;
    const item = object(value);
    if (item.kind !== "plaintext" && item.kind !== "markdown" || typeof item.value !== "string" || !item.value.isWellFormed())
        throw new Error("Invalid inlay hint tooltip");
    return item.value;
}
function hintItem(value) {
    const item = object(value);
    if (!validPosition(item.position) || item.kind !== undefined && item.kind !== 1 && item.kind !== 2 ||
        ["paddingLeft", "paddingRight"].some(key => item[key] !== undefined && typeof item[key] !== "boolean"))
        throw new Error("Invalid inlay hint");
    markup(item.tooltip);
    if (typeof item.label === "string") {
        if (!item.label || !item.label.isWellFormed())
            throw new Error("Invalid inlay hint label");
    }
    else {
        if (!Array.isArray(item.label) || !item.label.length)
            throw new Error("Invalid inlay hint label");
        for (const part of item.label) {
            const label = object(part);
            if (typeof label.value !== "string" || !label.value || !label.value.isWellFormed())
                throw new Error("Invalid inlay hint label part");
            markup(label.tooltip);
            if (label.location !== undefined && (typeof object(label.location).uri !== "string" || !object(label.location).uri.isWellFormed() || !validRange(object(label.location).range)))
                throw new Error("Invalid inlay hint label location");
        }
    }
    return item;
}
const labelText = (item) => typeof item.label === "string" ? item.label : item.label.map(part => part.value).join("");
export async function inlayHints(args, client, uri, range) {
    if (!client.capabilities.inlayHintProvider)
        return unsupportedFeature(client, "inlayHintProvider");
    if (!validRange(range))
        throw new Error("Invalid inlay hint request range");
    const deadline = Date.now() + args.timeout;
    const response = await requestBefore(client, "textDocument/inlayHint", { textDocument: { uri }, range }, deadline);
    if (response !== null && !Array.isArray(response))
        throw new Error("Invalid inlayHint response");
    const hints = (response ?? []).map(hintItem);
    const lines = client.documents.get(uri)?.text.split("\n").map(line => line.replace(/\r$/, ""));
    for (const hint of hints) {
        if (comparePosition(hint.position, range.start) < 0 || comparePosition(hint.position, range.end) > 0)
            throw new Error("Inlay hint position is outside the requested range");
        const line = lines?.[hint.position.line], unit = line?.charCodeAt(hint.position.character);
        if (lines && (line === undefined || hint.position.character > line.length || unit !== undefined && unit >= 0xdc00 && unit <= 0xdfff))
            throw new Error("Invalid inlay hint source position (UTF-16)");
    }
    const selected = args.limit ? hints.slice(0, args.limit) : hints, visible = [], errors = [];
    let resolvedCount = 0, resolveLimited = false, detailsOmitted = false;
    const resolveSupported = !!object(client.capabilities.inlayHintProvider).resolveProvider;
    for (const [index, original] of selected.entries()) {
        let hint = original;
        if (args.resolveCompletion && resolveSupported) {
            if (resolvedCount >= MAX_FILES || Date.now() >= deadline)
                resolveLimited = true;
            else
                try {
                    resolvedCount++;
                    const resolved = hintItem(await requestBefore(client, "inlayHint/resolve", original, deadline));
                    if (comparePosition(resolved.position, original.position) !== 0 || labelText(resolved) !== labelText(original) || resolved.kind !== undefined && resolved.kind !== original.kind)
                        throw new Error("Resolved inlay hint changed its anchor or label");
                    hint = { ...original, label: resolved.label, tooltip: resolved.tooltip ?? original.tooltip };
                }
                catch (error) {
                    errors.push({ index, ...failure(error, args.limit) });
                }
        }
        const tooltips = [markup(hint.tooltip), ...(Array.isArray(hint.label) ? hint.label.map(part => markup(part.tooltip)) : [])].filter((value) => value !== undefined);
        const tooltip = [...new Set(tooltips)].join("\n");
        detailsOmitted ||= !!args.limit && (hint.textEdits !== undefined || Array.isArray(hint.label) && hint.label.some(part => part.command !== undefined || part.location !== undefined));
        visible.push(args.limit ? { line: hint.position.line + 1, column: hint.position.character + 1, label: labelText(hint),
            ...(hint.kind !== undefined ? { kind: hint.kind } : {}), ...(tooltip ? { tooltip } : {}) } : { ...hint, line: hint.position.line + 1, column: hint.position.character + 1 });
    }
    const { items, ...preview } = compactText([...visible, ...errors], ["label", "tooltip", "error", "hint"], args.limit);
    const visibleHints = items.slice(0, visible.length), visibleErrors = items.slice(visible.length), truncated = selected.length < hints.length || !!preview.truncated || resolveLimited;
    const hint = !hints.length ? "No inlay hints in the requested range; check server hint settings or use hover for a focused type query." :
        resolveLimited ? "Inlay hint resolution reached its deadline/200-item budget; narrow --range or increase --timeout. Initial hints remain available." :
            args.resolveCompletion && !resolveSupported ? "The server does not advertise inlay hint resolution; initial hints remain available." :
                !args.resolveCompletion && resolveSupported ? "Add --resolve to retrieve hint tooltips without applying edits." : undefined;
    return { data: { success: !errors.length, supported: true, found: !!hints.length, server: client.server.name,
            range: { start: { line: range.start.line + 1, column: range.start.character + 1 }, end: { line: range.end.line + 1, column: range.end.character + 1 } },
            total: hints.length, shown: selected.length, ...preview, truncated, hints: visibleHints, errors: visibleErrors,
            ...(detailsOmitted ? { detailsOmitted: true } : {}), ...(args.resolveCompletion ? { resolution: { supported: resolveSupported, attempted: resolvedCount, limited: resolveLimited } } : {}), ...(hint ? { hint } : {}) }, code: errors.length ? 1 : 0,
        human: [`${hints.length} inlay hint(s)`, ...visibleHints.map(item => `${item.line}:${item.column}${item.kind === 1 ? " [type]" : item.kind === 2 ? " [parameter]" : ""} ${typeof item.label === "string" ? item.label : labelText(item)}${item.tooltip ? `\n${typeof item.tooltip === "string" ? item.tooltip : markup(item.tooltip)}` : ""}`),
            ...visibleErrors.map(error => `ERROR [${error.index}]: ${error.error}`), hint].filter(Boolean).join("\n") };
}
