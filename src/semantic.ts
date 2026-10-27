import { setTimeout as sleep } from "node:timers/promises";
import { object, uriFile, MAX_FILES, type ObjectValue } from "./config.ts";
import { compactText, failure } from "./output.ts";
import type { LspClient } from "./client.ts";
import type { Options, Result } from "./commands.ts";
import type { Position, Range } from "./omp/types.ts";

export function validPosition(value: unknown): value is Position {
  const p = object(value);
  return Number.isSafeInteger(p.line) && Number(p.line) >= 0 && Number.isSafeInteger(p.character) && Number(p.character) >= 0;
}
export function comparePosition(a: Position, b: Position) { return a.line - b.line || a.character - b.character; }
export function validRange(value: unknown): value is Range {
  const r = object(value);
  return validPosition(r.start) && validPosition(r.end) && comparePosition(r.start, r.end) <= 0;
}
export async function requestBefore(client: LspClient, method: string, params: unknown, deadline: number): Promise<unknown> {
  while (Date.now() < deadline) {
    try { return await client.request(method, params, Math.max(1, deadline - Date.now())); }
    catch (error) {
      if (!/Content\s*Modified|-32801/i.test(String(error))) throw error;
      await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
    }
  }
  throw new Error(`Timed out waiting for ${method}`);
}
function unsupported(client: LspClient, feature: string): Result {
  const hint = `${client.server.name} does not advertise ${feature}; check capabilities or select another configured server`;
  return { data: { success: false, supported: false, found: false, server: client.server.name, hint }, code: 1, human: hint };
}
function hierarchyItem(value: unknown): ObjectValue & { name: string; uri: string; range: Range; selectionRange: Range } {
  const item = object(value);
  if (typeof item.name !== "string" || !item.name.isWellFormed() || typeof item.uri !== "string" || !item.uri.isWellFormed() ||
      !Number.isSafeInteger(item.kind) || Number(item.kind) < 1 || !validRange(item.range) || !validRange(item.selectionRange) ||
      (comparePosition(item.range.start, item.selectionRange.start) > 0 && comparePosition(item.selectionRange.end, item.range.start) > 0) || comparePosition(item.selectionRange.end, item.range.end) > 0)
    throw new Error("Invalid call hierarchy item");
  return item as ReturnType<typeof hierarchyItem>;
}

export async function callHierarchy(args: Options, client: LspClient, uri: string, position: Position): Promise<Result> {
  if (!client.capabilities.callHierarchyProvider) return unsupported(client, "callHierarchyProvider");
  const deadline = Date.now() + args.timeout, depth = args.depth ?? 1, incoming = args.command === "callers";
  const method = `callHierarchy/${incoming ? "incomingCalls" : "outgoingCalls"}`;
  const initial = await requestBefore(client, "textDocument/prepareCallHierarchy", { textDocument: { uri }, position }, deadline);
  if (initial !== null && !Array.isArray(initial)) throw new Error("Invalid prepareCallHierarchy response");
  const nodes: ObjectValue[] = [], edges: ObjectValue[] = [], errors: ObjectValue[] = [], roots: string[] = [];
  const items = new Map<string, { item: ReturnType<typeof hierarchyItem>; id: string; depth: number }>();
  let bounded = false;
  const add = (value: unknown, level: number) => {
    const item = hierarchyItem(value), key = JSON.stringify([item.uri, item.selectionRange, item.name]);
    let entry = items.get(key);
    if (!entry && items.size < MAX_FILES) {
      entry = { item, id: String(items.size), depth: level }; items.set(key, entry);
      nodes.push({ id: entry.id, name: item.name, kind: item.kind, file: uriFile(item.uri) ?? item.uri,
        line: item.selectionRange.start.line + 1, column: item.selectionRange.start.character + 1,
        ...(comparePosition(item.selectionRange.start, item.range.start) < 0 ? { selectionBeforeRange: true } : {}),
        ...(typeof item.detail === "string" ? { detail: item.detail } : {}) });
    }
    if (!entry) bounded = true;
    return entry;
  };
  for (const value of initial ?? []) { const entry = add(value, 0); if (entry && !roots.includes(entry.id)) roots.push(entry.id); }
  const visited = new Set<string>();
  const seenEdges = new Set<string>();
  for (const entry of items.values()) {
    if (entry.depth >= depth || visited.has(entry.id)) continue;
    visited.add(entry.id);
    try {
      const response = await requestBefore(client, method, { item: entry.item }, deadline);
      if (response !== null && !Array.isArray(response)) throw new Error(`Invalid ${method} response`);
      for (const value of response ?? []) {
        const call = object(value);
        if (!Array.isArray(call.fromRanges) || !call.fromRanges.every(validRange)) throw new Error("Invalid call hierarchy call-site ranges");
        const target = add(incoming ? call.from : call.to, entry.depth + 1);
        if (!target) continue;
        if (edges.length >= MAX_FILES * 5) { bounded = true; break; }
        const source = incoming ? target : entry;
        const seenSites = new Set<string>(), ranges = call.fromRanges.filter(range => { const key = `${range.start.line}:${range.start.character}`; if (seenSites.has(key)) return false; seenSites.add(key); return true; });
        const edge = { from: source.id, to: incoming ? entry.id : target.id, totalLocations: ranges.length,
          ...(ranges.length < call.fromRanges.length ? { duplicateLocations: call.fromRanges.length - ranges.length } : {}),
          locations: (args.limit ? ranges.slice(0, args.limit) : ranges).map(range => ({ file: uriFile(source.item.uri) ?? source.item.uri, line: range.start.line + 1, column: range.start.character + 1 })) };
        const key = JSON.stringify(edge);
        if (!seenEdges.has(key)) { seenEdges.add(key); edges.push(edge); }
      }
    } catch (error) { errors.push({ node: entry.id, ...failure(error, args.limit) }); }
    if (Date.now() >= deadline || bounded) break;
  }
  const selected = args.limit ? nodes.slice(0, Math.max(roots.length, args.limit)) : nodes;
  const ids = new Set(selected.map(node => node.id)), shownEdges = edges.filter(edge => ids.has(edge.from) && ids.has(edge.to));
  const { items: visibleNodes, ...preview } = compactText(selected, ["name", "detail"], args.limit), truncated = bounded || selected.length < nodes.length || shownEdges.length < edges.length || shownEdges.some(edge => (edge.locations as unknown[]).length < Number(edge.totalLocations)) || !!preview.truncated;
  const hint = truncated ? "Call graph sampled or bounded (200 nodes, 1000 edges); --limit 0 removes display limits. --depth controls traversal." : undefined;
  return { data: { success: !errors.length, supported: true, found: !!roots.length, server: client.server.name, direction: incoming ? "incoming" : "outgoing", depth,
    roots, total: nodes.length, shown: selected.length, truncated, bounded, ...preview, ...(hint ? { hint } : {}), nodes: visibleNodes, edges: shownEdges, errors },
    code: errors.length ? 1 : 0, human: [
      `${args.command}: ${nodes.length} node(s), ${edges.length} edge(s), depth ${depth}`,
      ...visibleNodes.map(node => `[${node.id}] ${node.name} ${node.file}:${node.line}:${node.column}`),
      ...shownEdges.map(edge => `${edge.from} -> ${edge.to}`), ...errors.map(error => `ERROR [${error.node}]: ${error.error}`), hint,
    ].filter(Boolean).join("\n") };
}

function completionItem(value: unknown): ObjectValue & { label: string } {
  const item = object(value);
  const details = item.labelDetails;
  if (typeof item.label !== "string" || !item.label.isWellFormed() || ["sortText", "filterText", "detail"].some(key => item[key] !== undefined && (typeof item[key] !== "string" || !(item[key] as string).isWellFormed())) ||
      item.kind !== undefined && (!Number.isSafeInteger(item.kind) || Number(item.kind) < 1) ||
      details !== undefined && (!details || typeof details !== "object" || Array.isArray(details) || ["detail", "description"].some(key => object(details)[key] !== undefined && (typeof object(details)[key] !== "string" || !(object(details)[key] as string).isWellFormed()))))
    throw new Error("Invalid completion item");
  return item as ObjectValue & { label: string };
}
function documentation(value: unknown): string | undefined {
  if (value === undefined) return;
  if (typeof value === "string" && value.isWellFormed()) return value;
  const item = object(value);
  if (!["plaintext", "markdown"].includes(String(item.kind)) || typeof item.value !== "string" || !item.value.isWellFormed()) throw new Error("Invalid completion documentation");
  return item.value;
}
export async function complete(args: Options, client: LspClient, uri: string, position: Position): Promise<Result> {
  if (!client.capabilities.completionProvider) return unsupported(client, "completionProvider");
  const deadline = Date.now() + args.timeout;
  const response = await requestBefore(client, "textDocument/completion", { textDocument: { uri }, position, context: { triggerKind: 1 } }, deadline);
  const list = object(response), values = response === null ? [] : Array.isArray(response) ? response : list.items;
  if (!Array.isArray(values) || !Array.isArray(response) && response !== null && typeof list.isIncomplete !== "boolean") throw new Error("Invalid completion response");
  let items = values.map(completionItem);
  if (args.query) {
    const query = args.query.toLowerCase();
    items = items.filter(item => String(item.filterText ?? item.label).toLowerCase().includes(query) || item.label.toLowerCase().includes(query));
    const rank = (item: typeof items[number]) => item.label === args.query ? 0 : item.label.toLowerCase() === query ? 1 : item.label.toLowerCase().startsWith(query) ? 2 : 3;
    items.sort((a, b) => rank(a) - rank(b) || String(a.sortText ?? a.label).localeCompare(String(b.sortText ?? b.label)));
  } else items.sort((a, b) => String(a.sortText ?? a.label).localeCompare(String(b.sortText ?? b.label)));
  const total = items.length, selected = args.limit ? items.slice(0, args.limit) : items, errors: ObjectValue[] = [];
  const visible: ObjectValue[] = [];
  let resolvedCount = 0, resolveLimited = false;
  for (const original of selected) {
    let item = original;
    if (args.resolveCompletion && object(client.capabilities.completionProvider).resolveProvider) {
      if (resolvedCount >= MAX_FILES || Date.now() >= deadline) resolveLimited = true;
      else try {
        resolvedCount++;
        const resolved = completionItem(await requestBefore(client, "completionItem/resolve", original, deadline));
        if (resolved.label !== original.label) throw new Error("Resolved completion changed its label");
        item = { ...original, detail: resolved.detail ?? original.detail, documentation: resolved.documentation ?? original.documentation };
      } catch (error) { errors.push({ label: original.label, ...failure(error, args.limit) }); }
    }
    const doc = documentation(item.documentation);
    visible.push(args.limit ? { label: item.label, ...(item.kind !== undefined ? { kind: item.kind } : {}),
      ...(item.detail !== undefined ? { detail: item.detail } : {}), ...(doc !== undefined ? { documentation: doc } : {}),
      ...(object(item.labelDetails).detail !== undefined ? { labelDetail: object(item.labelDetails).detail } : {}),
      ...(object(item.labelDetails).description !== undefined ? { description: object(item.labelDetails).description } : {}) } : { ...item });
  }
  const preview = compactText(visible, ["label", "detail", "documentation", "labelDetail", "description"], args.limit), truncated = visible.length < total || !!preview.truncated || resolveLimited;
  const hint = !total ? values.length ? `The server returned ${values.length} candidates at ${position.line + 1}:${position.character + 1}, but --query matched none; check the receiver/cursor and query.` : `The server returned no candidates at ${position.line + 1}:${position.character + 1}; place the cursor after '.' or within a member prefix, then retry.` :
    resolveLimited ? "Completion resolution reached its deadline/200-item budget; narrow --query or increase --timeout. Initial candidates remain available." :
    !args.resolveCompletion && object(client.capabilities.completionProvider).resolveProvider ? "Add --resolve to retrieve candidate details/documentation without applying edits." : undefined;
  return { data: { success: !errors.length, supported: true, found: !!total, server: client.server.name, total, shown: visible.length, ...preview, truncated,
    incomplete: !!list.isIncomplete, providerCount: values.length, cursor: { line: position.line + 1, column: position.character + 1 }, items: preview.items, errors,
    ...(args.resolveCompletion ? { resolution: { supported: !!object(client.capabilities.completionProvider).resolveProvider, attempted: resolvedCount, limited: resolveLimited } } : {}),
    ...(!args.limit && list.itemDefaults ? { itemDefaults: list.itemDefaults } : {}), ...(hint ? { hint } : {}) }, code: errors.length ? 1 : 0,
    human: [`${total} completion candidate(s)${list.isIncomplete ? " (server list incomplete)" : ""}`,
      ...preview.items.map(item => [item.label, item.detail, item.documentation].filter(Boolean).join("\n")),
      ...errors.map(error => `ERROR ${error.label}: ${error.error}`), hint].filter(Boolean).join("\n\n") };
}
