import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import childProcess from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { LspClient } from "./client.ts";
import {
  availableServers,
  configPaths,
  expandHome,
  fileServers,
  fileUri,
  gitRoot,
  inside,
  insideWorkspace,
  languageId,
  loadConfig,
  matchesFile,
  MAX_FILES,
  MAX_FILE_BYTES,
  object,
  readOverrides,
  readText,
  resolveCommand,
  resolveFile,
  serverForLanguage,
  serverRoot,
  uriFile,
  workspaceSource,
  type ObjectValue,
  type Server,
} from "./config.ts";
import {
  applyWorkspaceEdit,
  atomicWrite,
  editSummary,
  editTextLimit,
  moveNoReplace,
  remapEdit,
  textChanges,
} from "./edits.ts";
import { findReference, symbolAt } from "./devdocs.ts";
import { resolveSymbolColumn } from "./omp/symbol-column.ts";
import type { CodeAction, Command, Diagnostic, Position, WorkspaceEdit } from "./omp/types.ts";
import { version } from "./version.ts";
import { compactText, failure, selectFields, textPrefix } from "./output.ts";
import { syntaxLanguage, syntaxPosition, syntaxSnippet, syntaxTool } from "./syntax.ts";
import { batchQueries } from "./batch.ts";
import { inspectContext } from "./context.ts";

export interface Options {
  command: string;
  cwd: string;
  languages: string[];
  file?: string;
  line: number;
  column?: number;
  symbol?: string;
  query?: string;
  newName?: string;
  method?: string;
  payload?: string;
  input?: string;
  context?: boolean;
  fields?: string[];
  timeout: number;
  limit: number;
  json: boolean;
  changed: boolean;
  workspace: boolean;
  apply: boolean;
  project: boolean;
  globalConfigOnly: boolean;
  globalBinsOnly: boolean;
}
export interface Result {
  data: ObjectValue;
  human: string;
  code?: number;
}
function outputInfo(total: number, limit: number) {
  const shown = limit ? Math.min(total, limit) : total, truncated = shown < total;
  return { total, shown, truncated, ...(truncated ? { hint: `Showing ${shown} of ${total}. Use --limit 0 for the complete result; redirect --json output to a file for large results.` } : {}) };
}
function locationLines(items: ObjectValue[], root: string, named = false): string[] {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const file = typeof item.file === "string" ? item.file : "(location unavailable)";
    const path = isAbsolute(file) && inside(root, file) ? relative(root, file) || "." : file;
    const point = item.line === undefined ? "?" : `${item.line}:${item.column}`;
    if (!groups.has(path)) groups.set(path, []);
    groups.get(path)!.push(named ? `${item.name}@${point}` : point);
  }
  return [...groups].map(([file, points]) => `${file}:${points.join(", ")}`);
}
function signatureHelp(value: unknown, server: string, limit: number, cursor: { line: number; column: number; automatic: boolean }): Result {
  const response = object(value);
  if (value !== null && (!Array.isArray(response.signatures) || response.signatures.some(item => typeof object(item).label !== "string")))
    throw new Error(`Invalid signature help response from ${server}`);
  const signatures = (response.signatures ?? []) as ObjectValue[];
  const index = (value: unknown, count: number) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < count ? Number(value) : 0;
  const activeSignature = index(response.activeSignature, signatures.length), active = signatures[activeSignature];
  const parameters = Array.isArray(active?.parameters) ? active.parameters : [];
  const activeParameter = parameters.length ? index(active?.activeParameter ?? response.activeParameter, parameters.length) : null;
  const parameter = activeParameter === null ? undefined : object(parameters[activeParameter]).label;
  const activeLabel = String(active?.label ?? "");
  let activeParameterLabel: string | null = null;
  if (typeof parameter === "string") activeParameterLabel = parameter;
  else if (Array.isArray(parameter) && parameter.length === 2 && parameter.every(Number.isSafeInteger) && parameter[0] >= 0 && parameter[1] >= parameter[0] && parameter[1] <= activeLabel.length && parameter.every(offset => !(activeLabel.charCodeAt(offset) >= 0xdc00 && activeLabel.charCodeAt(offset) <= 0xdfff)))
    activeParameterLabel = activeLabel.slice(parameter[0], parameter[1]);
  const summary = outputInfo(signatures.length, limit);
  const indexes = signatures.map((_, index) => index);
  if (limit && signatures.length) indexes.unshift(...indexes.splice(activeSignature, 1));
  let remaining = limit ? 6000 : Infinity, textTruncated = false;
  const selected = indexes.slice(0, summary.shown).map(index => {
    const signature = signatures[index], original = String(signature.label), label = textPrefix(original, remaining);
    remaining -= label.length; textTruncated ||= label.length < original.length;
    return limit ? { index, label } : { ...signature, index, label };
  });
  if (limit && activeParameterLabel) {
    const preview = textPrefix(activeParameterLabel, 1000); textTruncated ||= preview.length < activeParameterLabel.length; activeParameterLabel = preview;
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
function editVerification(applied: boolean, hint?: string) {
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
  "textDocument/diagnostic",
  "textDocument/semanticTokens/full",
]);
const NAVIGATION: Record<string, string> = {
  definition: "textDocument/definition",
  references: "textDocument/references",
  hover: "textDocument/hover",
  "signature-help": "textDocument/signatureHelp",
  "type-definition": "textDocument/typeDefinition",
  implementation: "textDocument/implementation",
};
const POSITION_METHODS = new Set([...Object.values(NAVIGATION), "textDocument/declaration", "textDocument/signatureHelp"]);

interface FileContext {
  server: Server;
  path: string;
  client: LspClient;
  uri: string;
  text: string;
}
interface Session {
  clients: Map<string, LspClient>;
  diagnostics: boolean;
}
async function sessionClient(server: Server, args: Options, session?: Session) {
  const key = JSON.stringify([server, args.timeout]);
  let client = session?.clients.get(key);
  if (client && !client.reusable) { await client.close(); session!.clients.delete(key); client = undefined; }
  if (!client) {
    if (session && session.clients.size >= 8) {
      const [oldest, previous] = session.clients.entries().next().value!;
      await previous.close(); session.clients.delete(oldest);
    }
    client = await LspClient.start(server, args.timeout, args.apply);
  }
  if (session) { session.clients.delete(key); session.clients.set(key, client); }
  return client;
}
function compilerDiagnostics(server: Server): Server {
  return server.name === "rust-analyzer" ? {
    ...server, settings: { ...server.settings,
      "rust-analyzer": { ...object(server.settings?.["rust-analyzer"]), checkOnSave: true },
    },
  } : server;
}
async function fileContext(args: Options, semantic = true, session?: Session): Promise<FileContext> {
  if (!args.file) throw new Error("--file is required");
  const path = resolveFile(args.file, args.cwd);
  let server = fileServers(
    availableServers(
      loadConfig(dirname(path), args.globalConfigOnly),
      dirname(path),
      args.globalBinsOnly,
    ),
    path,
  )[0];
  if (!server)
    throw new Error(`No available language server matches ${path}; run codex-lsp setup <language> --project from the project root`);
  if (args.command === "inspect" || session?.diagnostics) server = compilerDiagnostics(server);
  const client = await sessionClient(server, args, session);
  try {
    const opened = await client.open(path);
    if (semantic || server.name !== "rust-analyzer") await client.ready(opened.uri);
    return { server, path, client, ...opened };
  } catch (error) {
    await client.close();
    throw error;
  }
}
export async function position(
  path: string,
  text: string,
  args: Pick<Options, "line" | "column" | "symbol"> & { command?: string; globalBinsOnly?: boolean },
): Promise<Position> {
  const lines = text.split("\n");
  if (!Number.isInteger(args.line) || args.line < 1 || args.line > lines.length)
    throw new Error(`Line ${args.line} is outside this file`);
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
    throw new Error("Column is outside this line");
  const unit = lines[targetLine].charCodeAt(character);
  if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error("Column splits a UTF-16 surrogate pair");
  return syntax ?? { line: args.line - 1, character };
}
async function snippet(args: Options): Promise<Result> {
  if (args.apply) throw new Error("snippet is read-only; omit --apply");
  if (!args.file) throw new Error("--file is required");
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
export function location(value: unknown): ObjectValue | undefined {
  const entry = object(value),
    uri = entry.uri ?? entry.targetUri;
  const range = object(entry.range ?? entry.targetSelectionRange ?? entry.targetRange),
    start = object(range.start);
  if (
    typeof uri !== "string" ||
    !Number.isInteger(start.line) || Number(start.line) < 0 ||
    !Number.isInteger(start.character) || Number(start.character) < 0
  )
    return;
  const path = uriFile(uri);
  return {
    file: path && existsSync(path) ? realpathSync(path) : (path ?? uri),
    line: Number(start.line) + 1,
    column: Number(start.character) + 1,
  };
}
export function formatSymbols(values: unknown, uri = "", container?: string): ObjectValue[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    const item = object(value),
      range = item.selectionRange ?? item.range;
    const point = location(item.location ?? { uri, range }) ?? {};
    const name = String(item.name ?? "");
    return [
      { name, kind: Number.isSafeInteger(item.kind) ? item.kind : undefined, container: typeof item.containerName === "string" ? item.containerName : container ?? null, ...point },
      ...formatSymbols(item.children, uri, name),
    ];
  });
}
function hoverText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(hoverText).filter(Boolean).join("\n\n");
  return typeof object(value).value === "string" ? String(object(value).value) : "";
}

async function navigate(args: Options, shared?: FileContext, session?: Session): Promise<Result> {
  const { server, path, client, uri, text } = shared ?? await fileContext(args, true, session);
  try {
    const pos = await position(path, text, args),
      method = NAVIGATION[args.command];
    const params = {
      textDocument: { uri },
      position: pos,
      ...(args.command === "references" ? { context: { includeDeclaration: true } } : {}),
    };
    const deadline = Date.now() + args.timeout;
    const knownReady = ["rust-analyzer", "pyright", "basedpyright"].includes(server.name);
    let result: unknown,
      content = "",
      locations: ObjectValue[] = [],
      delay = 100;
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
      } catch (error) {
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
      if (args.command === "hover") content = hoverText(object(result).contents);
      else if (args.command !== "signature-help")
        locations = (Array.isArray(result) ? result : [result])
          .map(location)
          .filter((x): x is ObjectValue => !!x);
      if (
        content.trim() ||
        locations.length ||
        args.command === "signature-help" ||
        knownReady ||
        !symbolAt(text, pos.line, pos.character)
      )
        break;
      if (!checkedAnalysis) {
        checkedAnalysis = true;
        if ((await client.getDiagnostics(uri, Math.max(1, deadline - Date.now()))).verified) break;
      }
      await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
      delay = Math.min(delay * 2, 500);
    }
    if (args.command === "hover") {
      let provider = "lsp";
      if (!content.trim()) {
        const reference = await findReference(
          languageId(server, path),
          symbolAt(text, pos.line, pos.character) ?? "",
          Math.min(args.timeout, 3000),
        );
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
        summary.shown = content ? content.split("\n").length : 0; summary.truncated = true;
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
          ...(content.length < preview.length ? { characters: { total: originalCharacters, shown: content.length } } : {}),
        },
        human: [content.trim() ? content : found ? "Hover information found." : "No hover information", summary.hint].filter(Boolean).join("\n"),
      };
    }
    if (timedOut) throw new Error(`Timed out waiting for ${args.command} from ${server.name}`);
    if (args.command === "signature-help") return signatureHelp(result, server.name, args.limit, {
      line: pos.line + 1, column: pos.character + 1, automatic: args.column === undefined && !!syntaxLanguage(path),
    });
    const summary = outputInfo(locations.length, args.limit);
    locations = locations.slice(0, summary.shown);
    return {
      data: { success: true, found: !!summary.total, server: server.name, ...summary, locations },
      human: locations.length
        ? [`Found ${summary.total} ${args.command}(s):`,
          ...(!shared ? [`Root: ${gitRoot(server.root)}`] : []), ...locationLines(locations, gitRoot(server.root)), summary.hint].filter(Boolean).join("\n")
        : `No ${args.command} found`,
    };
  } finally {
    if (!shared && !session) await client.close();
  }
}

function prioritizeSymbols(items: ObjectValue[], query?: string) {
  if (!query) return;
  const lower = query.toLowerCase(), rank = (item: ObjectValue) => item.name === query ? 0 : String(item.name).toLowerCase() === lower ? 1 : 2;
  items.sort((a, b) => rank(a) - rank(b));
}
async function symbols(args: Options, shared?: FileContext, session?: Session): Promise<Result> {
  if (!args.workspace) {
    const { server, client, uri } = shared ?? await fileContext(args, false, session);
    try {
      let items = formatSymbols(
        await client.request("textDocument/documentSymbol", { textDocument: { uri } }),
        uri,
      );
      if (args.query)
        items = items.filter((x) =>
          String(x.name).toLowerCase().includes(args.query!.toLowerCase()),
        );
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
    } finally {
      if (!shared && !session) await client.close();
    }
  }
  if (!args.query) throw new Error("--query is required with --workspace");
  const path = args.file ? resolveFile(args.file, args.cwd) : undefined,
    cwd = path ? dirname(path) : args.cwd;
  let servers = availableServers(loadConfig(cwd, args.globalConfigOnly), cwd, args.globalBinsOnly);
  if (path) servers = fileServers(servers, path);
  const items: ObjectValue[] = [],
    used: string[] = [],
    errors: ObjectValue[] = [];
  for (const server of servers.filter((x) => !x.isLinter)) {
    let client: LspClient | undefined;
    try {
      client = await sessionClient(session?.diagnostics ? compilerDiagnostics(server) : server, args, session);
      if (!client.capabilities.workspaceSymbolProvider) continue;
      // shortcut: one seed loads one project; discover more roots for cross-project searches.
      const source = path ?? workspaceSource(server);
      if (source) {
        const { uri } = await client.open(source);
        await client.ready(uri);
      } else if (server.name === "rust-analyzer") await client.waitWorkspace();
      items.push(...formatSymbols(await client.request("workspace/symbol", { query: args.query })));
      used.push(server.name);
    } catch (error) {
      errors.push({ server: server.name, ...failure(error, args.limit) });
    } finally {
      if (!session) await client?.close();
    }
  }
  if (!used.length && !errors.length)
    throw new Error(
      "No available server supports workspace symbols; use --file to select a project",
    );
  prioritizeSymbols(items, args.query);
  const summary = outputInfo(items.length, args.limit), { items: selected, ...preview } = compactText(items.slice(0, summary.shown), ["name", "container"], args.limit);
  return {
    data: { success: !errors.length, servers: used, ...summary, ...preview, symbols: selected, errors },
    code: errors.length ? 1 : 0,
    human:
      [
        ...(selected.length ? [`Root: ${gitRoot(cwd)}`, ...locationLines(selected, gitRoot(cwd), true)] : []),
        ...errors.map((x) => [`ERROR ${x.server}: ${x.error}`, x.hint].filter(Boolean).join("\n")),
        summary.hint,
        preview.hint,
      ].filter(Boolean).join("\n") || "No symbols found",
  };
}

async function rename(args: Options, shared?: FileContext): Promise<Result> {
  if (!args.newName) throw new Error("--new-name is required");
  const { server, path, client, uri, text } = shared ?? await fileContext(args);
  try {
    const edit =
      (await client.request<WorkspaceEdit | null>("textDocument/rename", {
        textDocument: { uri },
        position: await position(path, text, args),
        newName: args.newName,
      })) ?? {};
    if (![...textChanges(edit).values()].some((x) => x.length))
      throw new Error(
        "The language server returned no rename edits; try the symbol's declaration or check rename support",
      );
    const summary = outputInfo([...textChanges(edit).values()].reduce((n, items) => n + items.length, 0), args.limit);
    const preview = editSummary(edit, summary.shown, editTextLimit([edit], summary.shown, !!args.limit)), edits = preview.lines;
    if (preview.textTruncated) { summary.truncated = true; summary.hint = [summary.hint, "Replacement text clipped; use --limit 0 --json for complete edits."].filter(Boolean).join(" "); }
    if (args.apply) await client.edit(edit);
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
  } catch (error) {
    if (server.name === "rust-analyzer" && object(error).code === -32602 && /No references found/i.test(String(error)))
      throw new Error(`${error instanceof Error ? error.message : String(error)}. Check Cargo target membership with cargo metadata --no-deps --format-version 1; confirm the file is in a target with the required features, then retry at the symbol declaration.`, { cause: error });
    throw error;
  } finally {
    if (!shared) await client.close();
  }
}

async function codeActions(args: Options): Promise<Result> {
  const { server, path, client, uri, text } = await fileContext(args);
  let edited = false;
  let editFailure: unknown;
  try {
    const pos = await position(path, text, args);
    let diagnostics = client.diagnostics.get(uri) ?? [];
    if (client.capabilities.diagnosticProvider && server.name !== "rust-analyzer")
      diagnostics = (await client.getDiagnostics(uri)).diagnostics;
    else if (server.name !== "rust-analyzer" && !client.diagnostics.has(uri)) {
      try { diagnostics = await client.waitDiagnostics(uri, Math.min(args.timeout, 1000)); }
      catch { /* Actions can be available without published diagnostics. */ }
    }
    const actionRange = args.column === undefined && !args.symbol
      ? { start: { line: pos.line, character: 0 }, end: { line: pos.line, character: text.split("\n")[pos.line].replace(/\r$/, "").length } }
      : { start: pos, end: pos };
    const actions =
      (await client.request<(CodeAction | Command)[]>("textDocument/codeAction", {
        textDocument: { uri },
        range: actionRange,
        context: { diagnostics },
      })) ?? [];
    const invalidAction = (item: unknown) => {
      const row = object(item);
      return typeof row.title !== "string" || (row.kind !== undefined && typeof row.kind !== "string") || (row.disabled != null && typeof object(row.disabled).reason !== "string");
    };
    if (!Array.isArray(actions) || actions.some(invalidAction)) throw new Error(`Invalid code action response from ${server.name}`);
    const matches = actions.map((action, index) => ({ action, index })).filter(({ action, index }) => !args.query || (/^\d+$/.test(args.query) ? index === Number(args.query) : action.title.toLowerCase().includes(args.query.toLowerCase())));
    if (args.apply && matches.length > 1) throw new Error("Multiple code actions match; choose the original index with --query INDEX");
    let chosen = args.query && matches.length === 1 ? matches[0].action : undefined;
    if (chosen && !("disabled" in chosen && chosen.disabled) && !("edit" in chosen) && !("command" in chosen) && object(client.capabilities.codeActionProvider).resolveProvider === true) {
      chosen = await client.request<CodeAction>("codeAction/resolve", chosen);
      if (invalidAction(chosen)) throw new Error(`Invalid resolved code action from ${server.name}`);
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
      let editPreview: ObjectValue | undefined;
      if (chosen && "edit" in chosen && chosen.edit) {
        const changes = textChanges(chosen.edit), total = [...changes.values()].reduce((sum, edits) => sum + edits.length, 0), info = outputInfo(total, args.limit);
        const details = editSummary(chosen.edit, info.shown, editTextLimit([chosen.edit], info.shown, !!args.limit));
        editPreview = { fileCount: changes.size, files: [...changes.keys()].slice(0, args.limit || Infinity).map(uri => uriFile(uri) ?? uri), ...info, truncated: info.truncated || details.textTruncated, edits: details.lines, ...(details.textTruncated ? { textTruncated: true, hint: "Replacement text clipped. Use --limit 0 --json for complete edits." } : {}), ...(args.limit ? { workspaceEditOmitted: true } : { workspaceEdit: chosen.edit }) };
      }
      const executesCommand = chosen ? !!chosen.command : undefined;
      const hint = [preview.hint ?? summary.hint, !items.length ? "No applicable actions for this range; check diagnostics and server capabilities, or select a different line/position." : chosen
        ? "disabled" in chosen && chosen.disabled ? `Selected action is disabled: ${selected[0].disabledReason}` : "Use --apply to execute this action."
        : "Use --query INDEX to preview edit scope, then add --apply to execute.", executesCommand ? "This action executes a server command; its file scope can extend beyond the edit preview." : "", editPreview?.hint].filter(Boolean).join(" ");
      return {
        data: { success: true, applied: false, server: server.name, ...summary, ...preview, ...(executesCommand !== undefined ? { executesCommand } : {}), ...(editPreview ? { editPreview } : {}), hint, actions: selected },
        human:
          [`${items.length} code action(s):`, ...selected.map((x) => `${x.index}: ${x.title}${x.disabledReason !== undefined ? ` [disabled: ${x.disabledReason}]` : ""}`), ...(editPreview?.edits as string[] ?? []), hint].filter(Boolean).join("\n"),
      };
    }
    if (!args.query) throw new Error("--query must select an action when using --apply");
    if (!chosen) throw new Error(`No code action matches ${args.query}`);
    if ("disabled" in chosen && chosen.disabled) throw new Error(chosen.disabled.reason);
    client.applyEdit = async (edit) => {
      try {
        edited = (await client.edit(edit)) || edited;
        editFailure = undefined;
      } catch (error) {
        editFailure = error;
        throw error;
      }
    };
    if ("edit" in chosen && chosen.edit) await client.applyEdit(chosen.edit);
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
    if (editFailure !== undefined) throw editFailure;
    const { items: selected, ...preview } = compactText([{ title: chosen.title }], ["title"], args.limit);
    return {
      data: { success: true, applied: true, server: server.name, ...preview, title: selected[0].title, ...editVerification(true, preview.hint) },
      human: [`Applied ${selected[0].title}`, preview.hint, VERIFY_EDITS].filter(Boolean).join("\n"),
    };
  } catch (error) {
    if (edited) throw new Error(`Code action failed after applying edits: ${error}`);
    throw error;
  } finally {
    await client.close();
  }
}

export function status(args: Options): Result {
  const path = args.file ? resolveFile(args.file, args.cwd) : undefined,
    cwd = path ? dirname(path) : args.cwd;
  const available = availableServers(
    loadConfig(cwd, args.globalConfigOnly),
    cwd,
    args.globalBinsOnly,
  );
  const servers = (path ? fileServers(available, path) : available).map((x) => ({
    name: x.name,
    command: x.resolvedCommand,
    args: x.args ?? [],
    root: x.root,
    fileTypes: x.fileTypes ?? [],
    isLinter: !!x.isLinter,
  }));
  return {
    data: { success: true, servers },
    human: servers.length
      ? servers.map((x) => `${x.name}: ${x.command} (root: ${x.root})`).join("\n")
      : "No configured language servers are available for this workspace",
  };
}

async function doctor(args: Options): Promise<Result> {
  const path = args.file ? resolveFile(args.file, args.cwd) : undefined,
    cwd = path ? dirname(path) : args.cwd;
  const syntax = syntaxTool(cwd, args.globalBinsOnly);
  let configs = loadConfig(cwd, args.globalConfigOnly);
  if (path)
    configs = Object.fromEntries(
      Object.entries(configs).filter(([, config]) => matchesFile(config, path)),
    );
  const servers: ObjectValue[] = [],
    issues: ObjectValue[] = [];
  for (const server of availableServers(configs, cwd, args.globalBinsOnly)) {
    let client: LspClient | undefined;
    const row: ObjectValue = {
      name: server.name,
      command: server.resolvedCommand,
      root: server.root,
    };
    const pythonPath = object(server.settings?.python).pythonPath;
    if (pythonPath) row.pythonPath = pythonPath;
    try {
      client = await LspClient.start(server, args.timeout);
      if (server.name === "rust-analyzer") await client.waitWorkspace();
      Object.assign(row, {
        status: "ok",
        capabilities: Object.keys(client.capabilities)
          .filter((key) => client!.capabilities[key])
          .sort(),
      });
    } catch (error) {
      const result = failure(error, args.limit), preview = result.hint ? { errorTruncated: true, hint: result.hint } : {};
      Object.assign(row, { status: "error", error: result.error, ...preview });
      issues.push({ severity: "error", server: server.name, message: result.error, ...preview });
    } finally {
      await client?.close();
    }
    servers.push(row);
  }
  for (const file of configPaths(cwd, args.globalConfigOnly))
    for (const name of Object.keys(readOverrides(file))) {
      const config = configs[name];
      if (!config || config.disabled) continue;
      const root = serverRoot(cwd, config.rootMarkers);
      if (!root || resolveCommand(config.command, root, args.globalBinsOnly)) continue;
      const message = `Executable ${config.command} is missing; run codex-lsp setup ${name} for install guidance`;
      if (servers.some((row) => row.name === name)) continue;
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
      ...servers.map(
        (row) =>
          `${row.status === "ok" ? "OK" : "ERROR"} ${row.name}: ${row.error ?? row.message ?? row.command} (root: ${row.root})${row.pythonPath ? `\n  Analysis Python: ${row.pythonPath}` : ""}${row.hint ? `\n  ${row.hint}` : ""}`,
      ),
      ...issues.filter((x) => x.severity === "warning").map((x) => `WARNING: ${x.message}`),
      success ? "Doctor result: OK" : "Doctor result: needs attention",
    ].join("\n"),
  };
}

function setup(args: Options): Result {
  const configs = loadConfig(args.cwd, args.globalConfigOnly),
    languages = args.languages
      .flatMap((x) => x.split(/[,，]/))
      .map((x) => x.trim())
      .filter(Boolean);
  if (!languages.length) throw new Error("Provide languages, such as codex-lsp setup rust python");
  if (args.project && languages.some((name) => name === "." || name === ".." || /[\\/]/.test(name) && !Object.hasOwn(configs, name)))
    throw new Error("--project takes no path; select the project with --cwd PATH, for example: codex-lsp --cwd PATH setup python --project");
  const selected: Record<string, string> = {},
    missing: string[] = [];
  for (const language of languages) {
    const name = serverForLanguage(language, configs),
      config = configs[name],
      command = resolveCommand(config.command, args.cwd);
    if (command) {
      selected[name] = command;
      continue;
    }
    const guide = config.setup;
    const install =
      typeof guide?.install === "string" || Array.isArray(guide?.install)
        ? guide.install
        : (guide?.install?.[process.platform] ?? guide?.install?.default);
    missing.push(
      `- ${language}: ${name} (executable: ${config.command})\n  Install commands (${process.platform}):\n${(Array.isArray(install) ? install : [install ?? "Use the official documentation for your platform."]).map((x) => `    ${x}`).join("\n")}\n  Official documentation: ${guide?.docs ?? "Consult the language server upstream documentation."}`,
    );
  }
  if (missing.length)
    throw new Error(
      `Missing language servers:\n${missing.join("\n")}\nAfter installation, rerun: codex-lsp setup ${languages.join(" ")}${args.project ? " --project" : ""}`,
    );
  const path = configPaths(args.cwd)[args.project ? 1 : 0];
  const doc = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as ObjectValue)
    : { servers: {} };
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    throw new Error(`Invalid LSP config: ${path}`);
  const entries = "servers" in doc ? doc.servers : doc;
  if (!entries || typeof entries !== "object" || Array.isArray(entries))
    throw new Error(`Invalid servers object: ${path}`);
  for (const [name, command] of Object.entries(selected)) {
    const previous = (entries as ObjectValue)[name];
    if (
      previous !== undefined &&
      (!previous || typeof previous !== "object" || Array.isArray(previous))
    )
      throw new Error(`Invalid server entry ${name}`);
    (entries as ObjectValue)[name] = {
      ...object(previous), command, disabled: false,
      ...(args.project ? { rootMarkers: [...new Set([...(configs[name].rootMarkers ?? []), ".codex/lsp.json"])] } : {}),
    };
  }
  atomicWrite(path, Buffer.from(JSON.stringify(doc, null, 2) + "\n"));
  return {
    data: { success: true, path, servers: selected },
    human:
      `Configured language servers in ${path}:\n` +
      Object.entries(selected)
        .map(([name, command]) => `- ${name}: ${command}`)
        .join("\n"),
  };
}

export async function changedFiles(cwd: string): Promise<string[]> {
  const root = gitRoot(cwd),
    found = new Set<string>();
  for (const args of [
    ["diff", "--name-only", "-z", "--diff-filter=ACMRTUXB", "HEAD"],
    ["diff", "--name-only", "-z", "--diff-filter=ACMRTUXB"],
    ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRTUXB"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ]) {
    let output: string;
    const options = { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 } as const;
    try {
      ({ stdout: output } = await promisify(childProcess.execFile)("git", ["-C", root, ...args], options));
    } catch (error) {
      const failure = error as childProcess.ExecFileException & { stderr?: string };
      if (args.at(-1) === "HEAD" && failure.code === 128 && !failure.killed && !failure.signal) {
        try {
          await promisify(childProcess.execFile)("git", ["-C", root, "rev-parse", "--verify", "--quiet", "HEAD"], options);
        } catch (headError) {
          const head = headError as childProcess.ExecFileException;
          // Only an unborn HEAD may fail; timeouts and other Git failures stay visible.
          if (head.code === 1 && !head.killed && !head.signal) continue;
        }
      }
      const reason = failure.stderr?.trim() || failure.message;
      throw new Error(`Git ${args.join(" ")} failed in ${root}${reason ? `: ${reason.slice(-1000)}` : ""}. Select the project with --cwd <project-root> diagnostics --changed, or use diagnostics --file <source-file>`);
    }
    for (const name of output.split("\0").filter(Boolean)) {
      let path: string, info: ReturnType<typeof statSync>;
      try {
        path = realpathSync(join(root, name));
        info = statSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!info.isFile()) continue;
      if (!inside(root, path)) throw new Error(`Changed file is outside the workspace: ${path}`);
      if (info.size > MAX_FILE_BYTES) throw new Error(`Changed file exceeds the 16 MiB LSP limit: ${path}`);
      found.add(path);
    }
  }
  if (found.size > MAX_FILES)
    throw new Error(`Changed files exceed the ${MAX_FILES} file limit; use --file to check individual files`);
  return [...found].sort();
}

export async function diagnostics(args: Options, shared?: FileContext, session?: Session): Promise<Result> {
  if (!!args.file === args.changed) throw new Error("Choose exactly one of --file or --changed");
  const paths = args.changed ? await changedFiles(args.cwd) : [resolveFile(args.file!, args.cwd)];
  const configurationPaths = args.changed ? configPaths(args.cwd).filter(existsSync).map(file => realpathSync(file)) : [];
  const scopedConfigurationPaths = args.changed ? configPaths(args.cwd, args.globalConfigOnly).filter(existsSync).map(file => realpathSync(file)) : [];
  const configurationChecks: { file: string; status: "validated" | "ignored" }[] = [];
  const groups = new Map<string, { server: Server; files: string[] }>();
  const records = new Map<
    string,
    { file: string; diagnostics: Diagnostic[]; verified: boolean; errors: string[] }
  >();
  for (const path of paths) {
    const configs = loadConfig(dirname(path), args.globalConfigOnly);
    if (configurationPaths.includes(path)) {
      configurationChecks.push({ file: path, status: scopedConfigurationPaths.includes(path) ? "validated" : "ignored" });
      continue;
    }
    const servers = fileServers(
      availableServers(
        configs,
        dirname(path),
        args.globalBinsOnly,
      ),
      path,
    );
    records.set(path, {
      file: path, diagnostics: [], verified: !!servers.length,
      errors: servers.length ? [] : ["No available language server matches this file. Run codex-lsp status --file <path>, then codex-lsp setup <language> for installation and configuration guidance; use diagnostics --file <source-file> to check an individual supported file."],
    });
    for (const server of servers) {
      const key = `${server.name}\0${server.root}`;
      if (!groups.has(key)) groups.set(key, { server, files: [] });
      groups.get(key)!.files.push(path);
    }
  }
  for (let { server, files } of groups.values()) {
    server = compilerDiagnostics(server);
    const reuse = shared?.server.name === server.name && shared.server.root === server.root;
    let client: LspClient | undefined;
    try {
      client = reuse ? shared.client : await sessionClient(server, args, session);
      for (const file of files) if (!client.documents.has(fileUri(file))) await client.open(file);
      for (const file of files) {
        const result = await client.getDiagnostics(fileUri(file)),
          record = records.get(file)!;
        record.verified &&= result.verified;
        if (!result.verified) record.errors.push(`${server.name}: ${UNVERIFIED_DIAGNOSTICS}`);
        const seen = new Set(record.diagnostics.map((x) => JSON.stringify([x.range, x.message, x.severity ?? 1])));
        for (const diagnostic of result.diagnostics) {
          const key = JSON.stringify([diagnostic.range, diagnostic.message, diagnostic.severity ?? 1]);
          if (!seen.has(key)) {
            record.diagnostics.push(diagnostic);
            seen.add(key);
          }
        }
      }
    } catch (error) {
      for (const file of files) {
        records.get(file)!.verified = false;
        records.get(file)!.errors.push(`${server.name}: ${error}`);
      }
    } finally {
      if (!reuse && !session) await client?.close();
    }
  }
  const checked = [...records.values()],
    verified = checked.every((x) => x.verified),
    hasErrors = checked.some((x) => x.diagnostics.some((d) => (d.severity ?? 1) === 1));
  const success = verified && !hasErrors && checked.every((x) => !x.errors.length);
  const all = checked.flatMap((record) => record.diagnostics), summary = outputInfo(all.length, args.limit);
  const counts = { errors: 0, warnings: 0, information: 0, hints: 0 };
  for (const diagnostic of all) counts[(["errors", "warnings", "information", "hints"] as const)[(diagnostic.severity ?? 1) - 1]]++;
  const selected = new Map<typeof checked[number], Diagnostic[]>();
  if (args.limit) {
    const ranked = checked.flatMap(record => record.diagnostics.map(diagnostic => ({ record, diagnostic })))
      .sort((a, b) => (a.diagnostic.severity ?? 1) - (b.diagnostic.severity ?? 1));
    for (const { record, diagnostic } of ranked.slice(0, summary.shown)) {
      if (!selected.has(record)) selected.set(record, []);
      selected.get(record)!.push(diagnostic);
    }
  }
  const content = args.limit ? [...[...selected.values()].flat().map(diagnostic => JSON.stringify(diagnostic)), ...checked.flatMap(record => record.errors)] : [];
  const maximum = content.reduce((sum, text) => sum + text.length, 0) > 6000 ? Math.floor(6000 / content.length) : Infinity;
  let textTruncated = false, detailsOmitted = false;
  const preview = (text: string) => { const shown = textPrefix(text, maximum); textTruncated ||= shown.length < text.length; return shown; };
  const visible = checked.map((record) => {
    const diagnostics = (args.limit ? selected.get(record) ?? [] : record.diagnostics).map(diagnostic => {
      if (!Number.isFinite(maximum)) return diagnostic;
      const message = preview(diagnostic.message);
      if (JSON.stringify(diagnostic).length - JSON.stringify(diagnostic.message).length <= 512) return { ...diagnostic, message };
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
  if (!verified) summary.hint = [summary.hint, UNVERIFIED_DIAGNOSTICS].filter(Boolean).join(" ");
  return {
    data: { success, verified, hasErrors, ...summary, counts, checked: visible, ...(textTruncated ? { textTruncated: true } : {}), ...(detailsOmitted ? { detailsOmitted: true } : {}), ...(configurationChecks.length ? { configurationChecks } : {}) },
    code: success ? 0 : 1,
    human: [checked.length
      ? [`${all.length} diagnostic(s): ${counts.errors} error(s), ${counts.warnings} warning(s), ${counts.information} information, ${counts.hints} hint(s)`, ...visible
          .flatMap((x) => [
            `${x.file}: ${x.verified ? "verified" : "unverified"}, ${x.diagnosticCount} diagnostic(s)`,
            ...x.diagnostics.map(
              (d) =>
                `  ${d.range.start.line + 1}:${d.range.start.character + 1} [${d.severity ?? 1}] ${d.message}`,
            ),
            ...x.errors.map((e) => `  ERROR: ${e}`),
          ]), summary.hint].filter(Boolean).join("\n")
      : "No changed source files to check",
      ...configurationChecks.map(row => `${row.status === "validated" ? "Validated CLI configuration" : "Ignored project LSP configuration (global-config-only)"}: ${row.file}`),
    ].join("\n"),
  };
}

async function inspect(args: Options, session?: Session): Promise<Result> {
  if (args.apply || args.workspace || args.changed)
    throw new Error("inspect is read-only and checks one file; omit --apply, --workspace and --changed");
  const context = await fileContext(args, true, session);
  const results: ObjectValue = {}, human: string[] = [], failedSections: string[] = [];
  try {
    const pos = await position(context.path, context.text, args);
    const queries: [string, string | undefined][] = [
      ["hover", "hoverProvider"], ["definition", "definitionProvider"],
      ["references", "referencesProvider"], ["symbols", "documentSymbolProvider"],
      ...(args.context ? [["type-definition", "typeDefinitionProvider"] as [string, string]] : []),
      ["diagnostics", undefined], ...(args.newName ? [["rename", "renameProvider"] as [string, string]] : []),
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
        if (result.data.success === false) failedSections.push(command);
        human.push(`${command}:\n${result.human}`);
      } catch (error) {
        failedSections.push(command);
        const result = failure(error, args.limit);
        results[command] = result;
        human.push([`${command}: ERROR ${result.error}`, result.hint].filter(Boolean).join("\n"));
      }
    }
    if (args.context) {
      const result = await inspectContext(args, context, pos, results);
      results.context = result.data; human.push(`context:\n${result.human}`);
      if (result.data.success === false) failedSections.push("context");
    }
    const success = !failedSections.length;
    const diagnostic = object(results.diagnostics);
    const hint = diagnostic.verified === true && diagnostic.hasErrors === true
      ? `Diagnostics verified: ${object(diagnostic.counts).errors} project code error(s). Navigation results remain available; see results.diagnostics.checked for locations.` : undefined;
    if (hint) human.unshift(hint);
    if (!success) human.unshift(`Inspection has issues in: ${failedSections.join(", ")}. See each section below.`);
    return { data: { success, applied: false, server: context.server.name, failedSections, ...(hint ? { hint } : {}), results }, human: [`Root: ${gitRoot(context.server.root)}`, ...human].join("\n\n"), code: success ? 0 : 1 };
  } finally { if (!session) await context.client.close(); }
}

async function batch(args: Options): Promise<Result> {
  const queries = await batchQueries(args), results: ObjectValue[] = [], human: string[] = [];
  const session: Session = { clients: new Map(), diagnostics: queries.some(query => ["inspect", "diagnostics"].includes(query.options.command)) };
  try {
    for (const { line, options } of queries) {
      let result: Result;
      try { result = await run(options, session); }
      catch (error) { const data = failure(error, options.limit); result = { data, human: [data.error, data.hint].filter(Boolean).join("\n"), code: 2 }; }
      const code = result.code ?? 0;
      const data = options.fields ? selectFields(result.data, options.fields) : result.data;
      results.push({ index: results.length, inputLine: line, command: options.command, file: options.file, line: options.line,
        ...(options.symbol ? { symbol: options.symbol } : {}), code, ...data });
      human.push(`[${results.length}] ${options.command} ${options.file} (exit ${code})\n${options.fields ? JSON.stringify(data) : result.human}`);
    }
    const failedQueries = results.filter(row => row.code !== 0).map(row => ({ index: row.index, inputLine: row.inputLine, code: row.code, ...(row.failedSections ? { failedSections: row.failedSections } : {}) })), failed = failedQueries.length;
    const hint = failed ? `${failed}/${results.length} queries failed. Successful results remain available; failedQueries maps each results[index] to its inputLine and failedSections.` : undefined;
    return { data: { success: !failed, applied: false, total: results.length, succeeded: results.length - failed, failed, failedQueries, ...(hint ? { hint } : {}), results }, code: failed ? 1 : 0,
      human: [`Batch: ${results.length - failed}/${results.length} queries succeeded`, ...human].join("\n\n") };
  } finally { await Promise.allSettled([...session.clients.values()].map(client => client.close())); }
}

async function renameFile(args: Options): Promise<Result> {
  if (!args.file || !args.newName) throw new Error("--file and --new-name are required");
  const source = resolveFile(args.file, args.cwd),
    desired = resolve(dirname(source), expandHome(args.newName));
  const pathHint = `--new-name resolves relative to the source file directory (${dirname(source)}); use a basename or absolute path and create the destination directory first.`;
  let parent: string;
  try { parent = realpathSync(dirname(desired)); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(String(object(error).code))) throw new Error(`Destination directory is missing: ${dirname(desired)}. ${pathHint}`);
    throw error;
  }
  if (!statSync(parent).isDirectory()) throw new Error(`Destination parent is not a directory: ${parent}. ${pathHint}`);
  const destination = join(parent, basename(desired));
  if (source === destination || existsSync(destination))
    throw new Error(`Destination already exists or matches source: ${destination}`);
  const servers = fileServers(
    availableServers(loadConfig(dirname(source), args.globalConfigOnly), dirname(source), args.globalBinsOnly),
    source,
  ).filter((x) => !x.isLinter);
  const pairs = { files: [{ oldUri: fileUri(source), newUri: fileUri(destination) }] };
  const clients: { server: Server; client: LspClient; edit: WorkspaceEdit }[] = [];
  try {
    for (const server of servers) {
      const client = await LspClient.start(server, args.timeout);
      try {
        const { uri } = await client.open(source);
        await client.ready(uri);
        const edit =
          (await client.request<WorkspaceEdit | null>("workspace/willRenameFiles", pairs)) ?? {};
        clients.push({ server, client, edit });
      } catch (error) {
        await client.close();
        if (object(error).code !== -32601) throw error;
      }
    }
    const total = clients.reduce((n, x) => n + [...textChanges(x.edit).values()].reduce((n, items) => n + items.length, 0), 0);
    const summary = outputInfo(total, args.limit), maximumText = editTextLimit(clients.map(x => x.edit), summary.shown, !!args.limit);
    let remaining = summary.shown, textTruncated = false;
    const edits = clients.map(x => {
      const count = [...textChanges(x.edit).values()].reduce((n, items) => n + items.length, 0);
      const preview = editSummary(x.edit, remaining, maximumText); remaining -= Math.min(remaining, count); textTruncated ||= preview.textTruncated; return preview.lines;
    });
    if (textTruncated) { summary.truncated = true; summary.hint = [summary.hint, "Replacement text clipped; use --limit 0 --json for complete edits."].filter(Boolean).join(" "); }
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
        const combined: WorkspaceEdit = { changes: {}, documentChanges: [] };
        const documents = new Map<string, { text: string; version: number }>();
        for (const { client, edit } of clients) {
          const remapped = remapEdit(edit, fileUri(source), fileUri(destination));
          for (const [uri, edits] of Object.entries(remapped.changes ?? {}))
            combined.changes![uri] = [...(combined.changes![uri] ?? []), ...edits];
          combined.documentChanges!.push(...(remapped.documentChanges ?? []));
          for (const [uri, document] of client.documents) {
            const target = uri === fileUri(source) ? fileUri(destination) : uri;
            if (documents.has(target) && documents.get(target)!.text !== document.text)
              throw new Error(`File changed since LSP analysis: ${source}`);
            documents.set(target, document);
          }
        }
        await applyWorkspaceEdit(combined, root, documents);
      } catch (error) {
        try {
          moveNoReplace(destination, source);
        } catch (rollbackError) {
          throw new Error(`${error}; file rename rollback failed (${destination} → ${source}): ${rollbackError}`);
        }
        throw error;
      }
      try {
        for (const { client } of clients) await client.notify("workspace/didRenameFiles", pairs);
      } catch (error) {
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
  } finally {
    for (const { client } of clients) await client.close();
  }
}

async function request(args: Options): Promise<Result> {
  if (!args.method) throw new Error("--method is required");
  if (!READ_ONLY.has(args.method) && !args.apply)
    throw new Error("Raw request methods require --apply unless listed as read-only");
  let client: LspClient | undefined,
    server: Server,
    params: unknown = args.payload ? JSON.parse(args.payload) : {};
  let applied = false, editFailure: unknown;
  if (args.file && args.payload && args.method.startsWith("textDocument/") &&
      (params === null || typeof params !== "object" || Array.isArray(params)))
    throw new Error("--payload with --file must contain an object for textDocument requests");
  try {
    if (args.file) {
      const context = await fileContext(args);
      ({ client, server } = context);
      if (!args.payload || args.method.startsWith("textDocument/")) {
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
    } else {
      const servers = availableServers(loadConfig(args.cwd, args.globalConfigOnly), args.cwd, args.globalBinsOnly);
      server = servers.find((x) => !x.isLinter) ?? servers[0];
      if (!server) throw new Error("No available language server for this workspace");
      client = await LspClient.start(server, args.timeout, args.apply);
    }
    if (args.apply)
      client.applyEdit = async (edit) => {
        try { applied = (await client!.edit(edit)) || applied; }
        catch (error) { editFailure = error; throw error; }
      };
    const result = await client.request(args.method, params);
    if (editFailure !== undefined) throw editFailure;
    if (args.apply && (object(result).changes || object(result).documentChanges)) {
      applied = (await client.edit(result as WorkspaceEdit)) || applied;
    }
    return {
      data: { success: true, server: server.name, method: args.method, applied, result, ...editVerification(applied) },
      human: [JSON.stringify(result, null, 2), applied ? VERIFY_EDITS : undefined].filter(Boolean).join("\n"),
    };
  } catch (error) {
    if (applied) throw new Error(`Raw request failed after applying edits: ${error}`);
    throw error;
  } finally {
    await client?.close();
  }
}

export async function run(args: Options, session?: Session): Promise<Result> {
  const navigation = Object.hasOwn(NAVIGATION, args.command);
  if (navigation && args.apply) throw new Error(`${args.command} is read-only; omit --apply`);
  let requestPosition = false;
  if (args.command === "request" && POSITION_METHODS.has(args.method ?? "")) {
    const payload: unknown = args.payload ? JSON.parse(args.payload) : {};
    requestPosition = !!payload && typeof payload === "object" && !Array.isArray(payload) && !("position" in payload);
  }
  if (args.file && (navigation || ["inspect", "rename", "code-actions"].includes(args.command) ||
      requestPosition)) {
    const path = resolveFile(args.file, args.cwd);
    await position(path, readText(path), args);
  }
  if (navigation) return navigate(args, undefined, session);
  switch (args.command) {
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
      return codeActions(args);
    case "request":
      return request(args);
    case "capabilities": {
      const path = args.file ? resolveFile(args.file, args.cwd) : undefined,
        cwd = path ? dirname(path) : args.cwd;
      const all = availableServers(loadConfig(cwd, args.globalConfigOnly), cwd, args.globalBinsOnly),
        servers = path ? fileServers(all, path) : all;
      if (!servers.length) throw new Error("No available language server");
      const results: ObjectValue[] = [];
      for (const server of servers) {
        const client = await LspClient.start(server, args.timeout);
        try {
          results.push({ name: server.name, capabilities: client.capabilities });
        } finally {
          await client.close();
        }
      }
      return { data: { success: true, servers: results }, human: JSON.stringify(results, null, 2) };
    }
    default:
      throw new Error(`Unknown command: ${args.command}; use codex-lsp ${args.command === "version" ? "--version" : "--help"}`);
  }
}
