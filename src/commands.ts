import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  moveNoReplace,
  remapEdit,
  textChanges,
} from "./edits.ts";
import { findReference, symbolAt } from "./devdocs.ts";
import { resolveSymbolColumn } from "./omp/symbol-column.ts";
import type { CodeAction, Command, Diagnostic, Position, WorkspaceEdit } from "./omp/types.ts";
import { version } from "../package.json";

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
function textPrefix(text: string, maximum: number): string {
  let end = Math.min(text.length, maximum);
  if (end < text.length && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
  return text.slice(0, Math.max(0, end));
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
function signatureHelp(value: unknown, server: string, limit: number): Result {
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
  const hint = !signatures.length ? "Place the cursor inside a call's arguments." : summary.truncated || documentationOmitted || textTruncated
    ? [documentationOmitted ? "Documentation omitted." : "", textTruncated ? "Signature text clipped." : "", "Use --limit 0 --json for complete signature information."].filter(Boolean).join(" ") : "";
  return {
    data: { success: true, found: !!signatures.length, server, ...summary, truncated: summary.truncated || textTruncated, activeSignature: signatures.length ? activeSignature : null, activeParameter, activeParameterLabel, signatures: selected, ...(documentationOmitted ? { documentationOmitted: true } : {}), ...(textTruncated ? { textTruncated: true } : {}), ...(hint ? { hint } : {}) },
    human: [signatures.length ? `${signatures.length} signature(s); active ${activeSignature + 1}${activeParameterLabel ? `; parameter: ${activeParameterLabel}` : ""}` : "No signature help", ...selected.map(signature => `${signature.index === activeSignature ? "*" : ""}[${signature.index + 1}] ${signature.label}`), hint].filter(Boolean).join("\n"),
  };
}
const VERIFY_EDITS = "Project verification pending. Run relevant build/tests; use code-actions for missing imports or re-exports if checks fail.";
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
function compilerDiagnostics(server: Server): Server {
  return server.name === "rust-analyzer" ? {
    ...server, settings: { ...server.settings,
      "rust-analyzer": { ...object(server.settings?.["rust-analyzer"]), checkOnSave: true },
    },
  } : server;
}
async function fileContext(args: Options, semantic = true): Promise<FileContext> {
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
  if (args.command === "inspect") server = compilerDiagnostics(server);
  const client = await LspClient.start(server, args.timeout, args.apply);
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
  args: Pick<Options, "line" | "column" | "symbol">,
): Promise<Position> {
  const lines = text.split("\n");
  if (!Number.isInteger(args.line) || args.line < 1 || args.line > lines.length)
    throw new Error(`Line ${args.line} is outside this file`);
  const character = args.symbol
    ? await resolveSymbolColumn(path, args.line, args.symbol)
    : args.column === undefined
      ? lines[args.line - 1].search(/\S/) < 0
        ? 0
        : lines[args.line - 1].search(/\S/)
      : args.column - 1;
  if (!Number.isInteger(character) || character < 0 || character > lines[args.line - 1].length)
    throw new Error("Column is outside this line");
  const unit = lines[args.line - 1].charCodeAt(character);
  if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error("Column splits a UTF-16 surrogate pair");
  return { line: args.line - 1, character };
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
      { name, kind: item.kind, container: item.containerName ?? container ?? null, ...point },
      ...formatSymbols(item.children, uri, name),
    ];
  });
}
function hoverText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(hoverText).filter(Boolean).join("\n\n");
  return typeof object(value).value === "string" ? String(object(value).value) : "";
}

async function navigate(args: Options, shared?: FileContext): Promise<Result> {
  const { server, path, client, uri, text } = shared ?? await fileContext(args);
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
        if (/Content\s*Modified|-32801/i.test(String(error))) {
          await Bun.sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
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
      await Bun.sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
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
    if (args.command === "signature-help") return signatureHelp(result, server.name, args.limit);
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
    if (!shared) await client.close();
  }
}

async function symbols(args: Options, shared?: FileContext): Promise<Result> {
  if (!args.workspace) {
    const { server, client, uri } = shared ?? await fileContext(args, false);
    try {
      let items = formatSymbols(
        await client.request("textDocument/documentSymbol", { textDocument: { uri } }),
        uri,
      );
      if (args.query)
        items = items.filter((x) =>
          String(x.name).toLowerCase().includes(args.query!.toLowerCase()),
        );
      const summary = outputInfo(items.length, args.limit);
      items = items.slice(0, summary.shown);
      const hint = !items.length && args.query ? "Use symbols --workspace --file <path> --query <name> to search the project." : undefined;
      return {
        data: { success: true, server: server.name, ...summary, ...(hint ? { hint } : {}), symbols: items },
        human: [items.length
          ? [...(!shared ? [`Root: ${gitRoot(server.root)}`] : []), ...locationLines(items, gitRoot(server.root), true)].join("\n")
          : "No symbols found", summary.hint ?? hint].filter(Boolean).join("\n"),
      };
    } finally {
      if (!shared) await client.close();
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
      client = await LspClient.start(server, args.timeout);
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
      errors.push({ server: server.name, error: String(error) });
    } finally {
      await client?.close();
    }
  }
  if (!used.length && !errors.length)
    throw new Error(
      "No available server supports workspace symbols; use --file to select a project",
    );
  const summary = outputInfo(items.length, args.limit), selected = items.slice(0, summary.shown);
  return {
    data: { success: !errors.length, servers: used, ...summary, symbols: selected, errors },
    code: errors.length ? 1 : 0,
    human:
      [
        ...(selected.length ? [`Root: ${gitRoot(cwd)}`, ...locationLines(selected, gitRoot(cwd), true)] : []),
        ...errors.map((x) => `ERROR ${x.server}: ${x.error}`),
        summary.hint,
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
    const edits = editSummary(edit, summary.shown);
    if (args.apply) await client.edit(edit);
    return {
      data: {
        success: true,
        applied: args.apply,
        server: server.name,
        ...summary,
        edits,
        ...(!args.apply ? summary.truncated ? { workspaceEditOmitted: true } : { workspaceEdit: edit } : {}),
        ...editVerification(args.apply, summary.hint),
      },
      human: [`${args.apply ? "Applied rename" : "Rename preview"}:\n${edits.join("\n")}`, summary.hint, args.apply ? VERIFY_EDITS : undefined].filter(Boolean).join("\n"),
    };
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
    if (!args.apply) {
      const items = actions
        .map((item, index) => ({
          index,
          title: item.title,
          kind: "kind" in item ? item.kind : undefined,
        }))
        .filter((x) => !args.query || x.title.toLowerCase().includes(args.query.toLowerCase()));
      const summary = outputInfo(items.length, args.limit), selected = items.slice(0, summary.shown);
      const hint = summary.hint ?? (!items.length ? "No applicable actions for this range; check diagnostics and server capabilities, or select a different line/position." : undefined);
      return {
        data: { success: true, server: server.name, ...summary, ...(hint ? { hint } : {}), actions: selected },
        human:
          [`${items.length} code action(s):`, ...selected.map((x) => `${x.index}: ${x.title}`), hint].filter(Boolean).join("\n"),
      };
    }
    if (!args.query) throw new Error("--query must select an action when using --apply");
    let chosen = /^\d+$/.test(args.query)
      ? actions[Number(args.query)]
      : actions.find((x) => x.title.toLowerCase().includes(args.query!.toLowerCase()));
    if (!chosen) throw new Error(`No code action matches ${args.query}`);
    if ("disabled" in chosen && chosen.disabled) throw new Error(chosen.disabled.reason);
    if (!("edit" in chosen) && !("command" in chosen) && client.capabilities.codeActionProvider)
      chosen = await client.request<CodeAction>("codeAction/resolve", chosen);
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
    return {
      data: { success: true, applied: true, server: server.name, title: chosen.title, ...editVerification(true) },
      human: `Applied ${chosen.title}\n${VERIFY_EDITS}`,
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
      Object.assign(row, { status: "error", error: String(error) });
      issues.push({ severity: "error", server: server.name, message: String(error) });
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
      runtime: { version, bun: Bun.version, executable: process.execPath },
      configFiles: configPaths(cwd, args.globalConfigOnly).filter(existsSync),
      servers,
      issues,
    },
    code: success ? 0 : 1,
    human: [
      `codex-lsp doctor (${version}, Bun ${Bun.version})`,
      ...servers.map(
        (row) =>
          `${row.status === "ok" ? "OK" : "ERROR"} ${row.name}: ${row.error ?? row.message ?? row.command} (root: ${row.root})${row.pythonPath ? `\n  Analysis Python: ${row.pythonPath}` : ""}`,
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
    const proc = Bun.spawn(["git", "-C", root, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    const [output, stderr] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(),
    ]);
    if (await proc.exited) {
      if (args.at(-1) === "HEAD") {
        const head = Bun.spawn(["git", "-C", root, "rev-parse", "--verify", "--quiet", "HEAD"], {
          stdout: "ignore", stderr: "ignore", timeout: 5000,
        });
        // Only an unborn HEAD may fail; other Git failures must remain visible.
        if (await head.exited === 1) continue;
      }
      throw new Error(`Git ${args.join(" ")} failed in ${root}${stderr.trim() ? `: ${stderr.trim().slice(-1000)}` : ""}. Select the project with --cwd <project-root> diagnostics --changed, or use diagnostics --file <source-file>`);
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

export async function diagnostics(args: Options, shared?: FileContext): Promise<Result> {
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
      client = reuse ? shared.client : await LspClient.start(server, args.timeout);
      for (const file of files) if (!client.documents.has(fileUri(file))) await client.open(file);
      for (const file of files) {
        const result = await client.getDiagnostics(fileUri(file)),
          record = records.get(file)!;
        record.verified &&= result.verified;
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
      if (!reuse) await client?.close();
    }
  }
  const checked = [...records.values()],
    verified = checked.every((x) => x.verified),
    hasErrors = checked.some((x) => x.diagnostics.some((d) => (d.severity ?? 1) === 1));
  const success = verified && !hasErrors && checked.every((x) => !x.errors.length);
  const all = checked.flatMap((record) => record.diagnostics), summary = outputInfo(all.length, args.limit);
  const counts = { errors: 0, warnings: 0, information: 0, hints: 0 };
  for (const diagnostic of all) counts[(["errors", "warnings", "information", "hints"] as const)[(diagnostic.severity ?? 1) - 1]]++;
  let remaining = summary.shown;
  const visible = checked.map((record) => {
    const diagnostics = record.diagnostics.slice(0, remaining); remaining -= diagnostics.length;
    return { ...record, diagnosticCount: record.diagnostics.length, diagnostics };
  });
  return {
    data: { success, verified, hasErrors, ...summary, counts, checked: visible, ...(configurationChecks.length ? { configurationChecks } : {}) },
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

async function inspect(args: Options): Promise<Result> {
  if (args.apply || args.workspace || args.changed)
    throw new Error("inspect is read-only and checks one file; omit --apply, --workspace and --changed");
  const context = await fileContext(args);
  const results: ObjectValue = {}, human: string[] = [], failedSections: string[] = [];
  try {
    const pos = await position(context.path, context.text, args);
    const queries: [string, string | undefined][] = [
      ["hover", "hoverProvider"], ["definition", "definitionProvider"],
      ["references", "referencesProvider"], ["symbols", "documentSymbolProvider"],
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
          : command === "diagnostics" ? await diagnostics(query, context)
          : command === "rename" ? await rename(query, context) : await navigate(query, context);
        results[command] = result.data;
        if (result.data.success === false) failedSections.push(command);
        human.push(`${command}:\n${result.human}`);
      } catch (error) {
        failedSections.push(command);
        const message = error instanceof Error ? error.message : String(error);
        results[command] = { success: false, error: message };
        human.push(`${command}: ERROR ${message}`);
      }
    }
    const success = !failedSections.length;
    const diagnostic = object(results.diagnostics);
    const hint = diagnostic.verified === true && diagnostic.hasErrors === true
      ? `Diagnostics verified: ${object(diagnostic.counts).errors} project code error(s). Navigation results remain available; see results.diagnostics.checked for locations.` : undefined;
    if (hint) human.unshift(hint);
    if (!success) human.unshift(`Inspection has issues in: ${failedSections.join(", ")}. See each section below.`);
    return { data: { success, applied: false, server: context.server.name, failedSections, ...(hint ? { hint } : {}), results }, human: [`Root: ${gitRoot(context.server.root)}`, ...human].join("\n\n"), code: success ? 0 : 1 };
  } finally { await context.client.close(); }
}

async function renameFile(args: Options): Promise<Result> {
  if (!args.file || !args.newName) throw new Error("--file and --new-name are required");
  const source = resolveFile(args.file, args.cwd),
    desired = resolve(dirname(source), expandHome(args.newName));
  const destination = join(realpathSync(dirname(desired)), basename(desired));
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
        if (!/-32601|method.*not.*found|unsupported.*method/i.test(String(error))) throw error;
      }
    }
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
    const total = clients.reduce((n, x) => n + [...textChanges(x.edit).values()].reduce((n, items) => n + items.length, 0), 0);
    const summary = outputInfo(total, args.limit);
    let remaining = summary.shown;
    const edits = clients.map((x) => {
      const count = [...textChanges(x.edit).values()].reduce((n, items) => n + items.length, 0);
      const lines = editSummary(x.edit, remaining); remaining -= Math.min(remaining, count); return lines;
    });
    return {
      data: {
        success: true,
        applied: args.apply,
        source,
        destination,
        ...summary,
        edits,
        ...(!args.apply
          ? summary.truncated ? { workspaceEditOmitted: true } : { workspaceEdits: clients.map((x) => ({ server: x.server.name, edit: x.edit })) }
          : {}),
        ...editVerification(args.apply, summary.hint),
      },
      human: [`${args.apply ? "Renamed" : "Rename preview"}: ${source} → ${destination}\n${edits.flat().join("\n")}`, summary.hint, args.apply ? VERIFY_EDITS : undefined].filter(Boolean).join("\n"),
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
  let applied = false;
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
        applied = (await client!.edit(edit)) || applied;
      };
    const result = await client.request(args.method, params);
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

export async function run(args: Options): Promise<Result> {
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
  if (navigation) return navigate(args);
  switch (args.command) {
    case "inspect":
      return inspect(args);
    case "status":
      return status(args);
    case "setup":
      return setup(args);
    case "doctor":
      return doctor(args);
    case "diagnostics":
      return diagnostics(args);
    case "symbols":
      return symbols(args);
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
      throw new Error(`Unknown command: ${args.command}`);
  }
}
