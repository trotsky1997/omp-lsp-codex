import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { LspClient } from "./client.ts";
import {
  availableServers,
  configPaths,
  expandHome,
  fileServers,
  fileUri,
  gitRoot,
  inside,
  languageId,
  loadConfig,
  matchesFile,
  MAX_FILES,
  MAX_FILE_BYTES,
  object,
  readOverrides,
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
  json: boolean;
  changed: boolean;
  workspace: boolean;
  apply: boolean;
  project: boolean;
  builtinsOnly: boolean;
  globalBinsOnly: boolean;
}
export interface Result {
  data: ObjectValue;
  human: string;
  code?: number;
}
const READ_ONLY = new Set([
  "textDocument/definition",
  "textDocument/declaration",
  "textDocument/typeDefinition",
  "textDocument/implementation",
  "textDocument/references",
  "textDocument/hover",
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
  "type-definition": "textDocument/typeDefinition",
  implementation: "textDocument/implementation",
};

interface FileContext {
  server: Server;
  path: string;
  client: LspClient;
  uri: string;
  text: string;
}
async function fileContext(args: Options, semantic = true): Promise<FileContext> {
  if (!args.file) throw new Error("--file is required");
  const path = resolveFile(args.file, args.cwd);
  const server = fileServers(
    availableServers(
      loadConfig(dirname(path), args.builtinsOnly),
      dirname(path),
      args.globalBinsOnly,
    ),
    path,
  )[0];
  if (!server)
    throw new Error(`No available language server matches ${path}; run codex-lsp setup <language>`);
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

async function navigate(args: Options): Promise<Result> {
  const { server, path, client, uri, text } = await fileContext(args);
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
      else
        locations = (Array.isArray(result) ? result : [result])
          .map(location)
          .filter((x): x is ObjectValue => !!x);
      if (
        content.trim() ||
        locations.length ||
        knownReady ||
        !symbolAt(text, pos.line, pos.character)
      )
        break;
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
      return {
        data: {
          success: true,
          found: !!content.trim(),
          server: server.name,
          provider,
          hover: content,
        },
        human: content || "No hover information",
      };
    }
    if (timedOut) throw new Error(`Timed out waiting for ${args.command} from ${server.name}`);
    return {
      data: { success: true, found: !!locations.length, server: server.name, locations },
      human: locations.length
        ? `Found ${locations.length} ${args.command}(s):\n` +
          locations.map((x) => `${x.file}:${x.line}:${x.column}`).join("\n")
        : `No ${args.command} found`,
    };
  } finally {
    await client.close();
  }
}

async function symbols(args: Options): Promise<Result> {
  if (!args.workspace) {
    const { server, client, uri } = await fileContext(args, false);
    try {
      let items = formatSymbols(
        await client.request("textDocument/documentSymbol", { textDocument: { uri } }),
        uri,
      );
      if (args.query)
        items = items.filter((x) =>
          String(x.name).toLowerCase().includes(args.query!.toLowerCase()),
        );
      return {
        data: { success: true, server: server.name, symbols: items },
        human: items.length
          ? items.map((x) => `${x.name} @ ${x.file}:${x.line}:${x.column}`).join("\n")
          : "No symbols found",
      };
    } finally {
      await client.close();
    }
  }
  if (!args.query) throw new Error("--query is required with --workspace");
  const path = args.file ? resolveFile(args.file, args.cwd) : undefined,
    cwd = path ? dirname(path) : args.cwd;
  let servers = availableServers(loadConfig(cwd, args.builtinsOnly), cwd, args.globalBinsOnly);
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
  const selected = items.slice(0, MAX_FILES);
  return {
    data: { success: !errors.length, servers: used, symbols: selected, errors },
    code: errors.length ? 1 : 0,
    human:
      [
        ...selected.map((x) => `${x.name} @ ${x.file}:${x.line}:${x.column}`),
        ...errors.map((x) => `ERROR ${x.server}: ${x.error}`),
      ].join("\n") || "No symbols found",
  };
}

async function rename(args: Options): Promise<Result> {
  if (!args.newName) throw new Error("--new-name is required");
  const { server, path, client, uri, text } = await fileContext(args);
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
    const edits = editSummary(edit);
    if (args.apply) await applyWorkspaceEdit(edit, server.root);
    return {
      data: {
        success: true,
        applied: args.apply,
        server: server.name,
        edits,
        ...(!args.apply ? { workspaceEdit: edit } : {}),
      },
      human: `${args.apply ? "Applied rename" : "Rename preview"}:\n${edits.join("\n")}`,
    };
  } finally {
    await client.close();
  }
}

async function codeActions(args: Options): Promise<Result> {
  const { server, path, client, uri, text } = await fileContext(args);
  try {
    const pos = await position(path, text, args);
    let diagnostics = client.diagnostics.get(uri) ?? [];
    if (client.capabilities.diagnosticProvider && server.name !== "rust-analyzer")
      diagnostics = (await client.getDiagnostics(uri)).diagnostics;
    const actions =
      (await client.request<(CodeAction | Command)[]>("textDocument/codeAction", {
        textDocument: { uri },
        range: { start: pos, end: pos },
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
      return {
        data: { success: true, server: server.name, actions: items },
        human:
          `${items.length} code action(s):\n` +
          items.map((x) => `${x.index}: ${x.title}`).join("\n"),
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
    client.applyEdit = (edit) => applyWorkspaceEdit(edit, server.root);
    if ("edit" in chosen && chosen.edit) await applyWorkspaceEdit(chosen.edit, server.root);
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
    return {
      data: { success: true, applied: true, server: server.name, title: chosen.title },
      human: `Applied ${chosen.title}`,
    };
  } finally {
    await client.close();
  }
}

export function status(args: Options): Result {
  const servers = availableServers(
    loadConfig(args.cwd, args.builtinsOnly),
    args.cwd,
    args.globalBinsOnly,
  ).map((x) => ({
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
  let configs = loadConfig(cwd);
  if (path)
    configs = Object.fromEntries(
      Object.entries(configs).filter(([, config]) => matchesFile(config, path)),
    );
  const servers: ObjectValue[] = [],
    issues: ObjectValue[] = [];
  for (const server of availableServers(configs, cwd)) {
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
  for (const file of configPaths(cwd))
    for (const name of Object.keys(readOverrides(file))) {
      const config = configs[name];
      if (!config || config.disabled) continue;
      const root = serverRoot(cwd, config.rootMarkers);
      if (!root || resolveCommand(config.command, root)) continue;
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
      configFiles: configPaths(cwd).filter(existsSync),
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
  const configs = loadConfig(args.cwd),
    languages = args.languages
      .flatMap((x) => x.split(/[,，]/))
      .map((x) => x.trim())
      .filter(Boolean);
  if (!languages.length) throw new Error("Provide languages, such as codex-lsp setup rust python");
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
  const path = args.project ? join(gitRoot(args.cwd), ".codex/lsp.json") : configPaths(args.cwd)[0];
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
    (entries as ObjectValue)[name] = { ...object(previous), command };
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
      stderr: "ignore",
      timeout: 5000,
    });
    const output = await new Response(proc.stdout).text();
    if (await proc.exited) {
      if (args.at(-1) === "HEAD") {
        const head = Bun.spawn(["git", "-C", root, "rev-parse", "--verify", "--quiet", "HEAD"], {
          stdout: "ignore", stderr: "ignore", timeout: 5000,
        });
        // Only an unborn HEAD may fail; other Git failures must remain visible.
        if (await head.exited === 1) continue;
      }
      throw new Error("Git could not enumerate changed files; inspect the repository or use --file");
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

export async function diagnostics(args: Options): Promise<Result> {
  if (!!args.file === args.changed) throw new Error("Choose exactly one of --file or --changed");
  const paths = args.changed ? await changedFiles(args.cwd) : [resolveFile(args.file!, args.cwd)];
  const groups = new Map<string, { server: Server; files: string[] }>();
  const records = new Map<
    string,
    { file: string; diagnostics: Diagnostic[]; verified: boolean; errors: string[] }
  >();
  for (const path of paths) {
    const servers = fileServers(
      availableServers(
        loadConfig(dirname(path), args.builtinsOnly),
        dirname(path),
        args.globalBinsOnly,
      ),
      path,
    );
    records.set(path, { file: path, diagnostics: [], verified: !!servers.length, errors: [] });
    for (const server of servers) {
      const key = `${server.name}\0${server.root}`;
      if (!groups.has(key)) groups.set(key, { server, files: [] });
      groups.get(key)!.files.push(path);
    }
  }
  for (let { server, files } of groups.values()) {
    if (server.name === "rust-analyzer")
      server = {
        ...server,
        settings: {
          ...server.settings,
          "rust-analyzer": { ...object(server.settings?.["rust-analyzer"]), checkOnSave: true },
        },
      };
    let client: LspClient | undefined;
    try {
      client = await LspClient.start(server, args.timeout);
      for (const file of files) await client.open(file);
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
      await client?.close();
    }
  }
  const checked = [...records.values()],
    verified = checked.every((x) => x.verified),
    hasErrors = checked.some((x) => x.diagnostics.some((d) => (d.severity ?? 1) === 1));
  const success = verified && !hasErrors && checked.every((x) => !x.errors.length);
  return {
    data: { success, verified, checked, hasErrors },
    code: success ? 0 : 1,
    human: checked.length
      ? checked
          .flatMap((x) => [
            `${x.file}: ${x.verified ? "verified" : "unverified"}, ${x.diagnostics.length} diagnostic(s)`,
            ...x.diagnostics.map(
              (d) =>
                `  ${d.range.start.line + 1}:${d.range.start.character + 1} [${d.severity ?? 1}] ${d.message}`,
            ),
            ...x.errors.map((e) => `  ERROR: ${e}`),
          ])
          .join("\n")
      : "No changed source files to check",
  };
}

async function renameFile(args: Options): Promise<Result> {
  if (!args.file || !args.newName) throw new Error("--file and --new-name are required");
  const source = resolveFile(args.file, args.cwd),
    desired = resolve(dirname(source), expandHome(args.newName));
  const destination = join(realpathSync(dirname(desired)), basename(desired));
  if (source === destination || existsSync(destination))
    throw new Error(`Destination already exists or matches source: ${destination}`);
  const servers = fileServers(
    availableServers(loadConfig(dirname(source), args.builtinsOnly), dirname(source)),
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
      const root = servers[0]?.root ?? gitRoot(dirname(source));
      if (!inside(realpathSync(root), source) || !inside(realpathSync(root), destination))
        throw new Error("File rename must stay inside the workspace");
      moveNoReplace(source, destination);
      try {
        const combined: WorkspaceEdit = { changes: {} };
        for (const { edit } of clients)
          for (const [uri, edits] of textChanges(
            remapEdit(edit, fileUri(source), fileUri(destination)),
          ))
            combined.changes![uri] = [...(combined.changes![uri] ?? []), ...edits];
        await applyWorkspaceEdit(combined, root);
      } catch (error) {
        moveNoReplace(destination, source);
        throw error;
      }
      for (const { client } of clients) await client.notify("workspace/didRenameFiles", pairs);
    }
    const edits = clients.map((x) => editSummary(x.edit));
    return {
      data: {
        success: true,
        applied: args.apply,
        source,
        destination,
        edits,
        ...(!args.apply
          ? { workspaceEdits: clients.map((x) => ({ server: x.server.name, edit: x.edit })) }
          : {}),
      },
      human: `${args.apply ? "Renamed" : "Rename preview"}: ${source} → ${destination}\n${edits.flat().join("\n")}`,
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
  try {
    if (args.file) {
      const context = await fileContext(args);
      ({ client, server } = context);
      if (!args.payload) {
        params = { textDocument: { uri: context.uri } };
        if (
          Object.values(NAVIGATION).includes(args.method) ||
          args.method === "textDocument/declaration"
        )
          params = {
            ...object(params),
            position: await position(context.path, context.text, args),
            ...(args.method === "textDocument/references"
              ? { context: { includeDeclaration: true } }
              : {}),
          };
      }
    } else {
      const servers = availableServers(loadConfig(args.cwd, args.builtinsOnly), args.cwd);
      server = servers.find((x) => !x.isLinter) ?? servers[0];
      if (!server) throw new Error("No available language server for this workspace");
      client = await LspClient.start(server, args.timeout, args.apply);
    }
    let applied = false;
    if (args.apply)
      client.applyEdit = async (edit) => {
        await applyWorkspaceEdit(edit, server.root);
        applied = true;
      };
    const result = await client.request(args.method, params);
    if (args.apply && (object(result).changes || object(result).documentChanges)) {
      await applyWorkspaceEdit(result as WorkspaceEdit, server.root);
      applied = true;
    }
    return {
      data: { success: true, server: server.name, method: args.method, applied, result },
      human: JSON.stringify(result, null, 2),
    };
  } finally {
    await client?.close();
  }
}

export async function run(args: Options): Promise<Result> {
  if (NAVIGATION[args.command]) return navigate(args);
  switch (args.command) {
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
      const all = availableServers(loadConfig(cwd, args.builtinsOnly), cwd),
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
