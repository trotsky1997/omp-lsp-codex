import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { availableServers, ancestors, configPaths, fileServers, fileUri, gitRoot, loadConfig, matchesFile, MAX_FILE_BYTES, MAX_FILES, object, readText, resolveFile, type ObjectValue, type Server } from "./config.ts";
import { changedFiles, sessionClient, type Options, type Result, type Session } from "./commands.ts";
import { LspClient } from "./client.ts";
import { captureBaseline, compareBaseline, serverFingerprint, type Baseline, type DiagnosticRecord } from "./baseline.ts";
import { saveEditPlan, validateEdits, normalizedEdits } from "./fixes.ts";
import { normalizeCodeAction, requestBefore, requestedActionKinds, validRange } from "./semantic.ts";
import { compactText, failure, textPrefix } from "./output.ts";
import { resolveToolCommand, runToolProcess, toolConfigCandidates, type ToolName, type ToolProcessResult } from "./tool-process.ts";
import type { CodeAction, Diagnostic, TextEdit } from "./omp/types.ts";

const tools: ToolName[] = ["ruff", "eslint", "biome", "prettier", "rustfmt", "clippy", "oxlint", "oxfmt"];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
interface Provider { file: string; kind: "cli" | "lsp"; name: string; fingerprint?: string; }
interface FileResult extends DiagnosticRecord { original: string; updated: string; providers: ObjectValue[]; skipped: ObjectValue[]; errorTruncated?: boolean; }
interface Collection { files: FileResult[]; providers: Provider[]; guards: Map<string, string | null>; fingerprints: string[]; skipped: ObjectValue[]; }
const jsExtensions = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte"];
function toolSupports(name: string, file: string) {
  const extension = extname(file).toLowerCase();
  return name === "ruff" ? [".py", ".pyi"].includes(extension) : name === "rustfmt" || name === "clippy" ? extension === ".rs" : name === "oxlint" ? [...jsExtensions, ".astro"].includes(extension) : name === "eslint" ? jsExtensions.includes(extension) : name === "biome" ? [...jsExtensions, ".json", ".jsonc", ".css", ".graphql", ".gql", ".html"].includes(extension) : name === "oxfmt" ? [...jsExtensions, ".astro", ".json", ".jsonc", ".json5", ".css", ".scss", ".less", ".md", ".mdx", ".html", ".yaml", ".yml", ".graphql", ".gql"].includes(extension) : name === "prettier" ? [...jsExtensions, ".json", ".jsonc", ".css", ".scss", ".less", ".md", ".mdx", ".html", ".yaml", ".yml", ".graphql", ".gql", ".xml", ".svg"].includes(extension) : true;
}

function projectDirectories(file: string) {
  const roots = ancestors(dirname(file)), root = gitRoot(dirname(file)), end = roots.indexOf(root);
  return end < 0 ? roots : roots.slice(0, end + 1);
}
export function declaredTools(file: string, format: boolean): string[] {
  const dirs = projectDirectories(file), ext = extname(file).toLowerCase(), candidates = new Set<string>();
  const has = (...names: string[]) => dirs.some(dir => names.some(name => existsSync(join(dir, name))));
  if ([".py", ".pyi"].includes(ext)) return has("ruff.toml", ".ruff.toml") || dirs.some(dir => existsSync(join(dir, "pyproject.toml")) && /^\s*\[tool\.ruff(?:\.|\])/m.test(readText(join(dir, "pyproject.toml")))) ? ["ruff"] : [];
  if (ext === ".rs") return has("Cargo.toml") ? [format ? "rustfmt" : "clippy"] : [];
  const packages = dirs.filter(dir => existsSync(join(dir, "package.json"))).map(dir => object(JSON.parse(readText(join(dir, "package.json")))));
  const dependency = (name: string) => packages.some(pkg => name in object(pkg.dependencies) || name in object(pkg.devDependencies));
  const js = jsExtensions.includes(ext);
  if (!format && toolSupports("oxlint", file) && (has(".oxlintrc.json", ".oxlintrc.jsonc", "oxlint.config.ts", "oxlint.config.mts", "oxlint.config.cts", "oxlint.config.js", "oxlint.config.mjs", "oxlint.config.cjs") || dependency("oxlint"))) candidates.add("oxlint");
  if (format && toolSupports("oxfmt", file) && (has(".oxfmtrc.json", ".oxfmtrc.jsonc", "oxfmt.config.ts", "oxfmt.config.mts", "oxfmt.config.cts", "oxfmt.config.js", "oxfmt.config.mjs", "oxfmt.config.cjs") || dependency("oxfmt"))) candidates.add("oxfmt");
  if ((js || [".json", ".jsonc", ".css", ".graphql", ".gql"].includes(ext)) && (has("biome.json", "biome.jsonc") || dependency("@biomejs/biome"))) candidates.add("biome");
  if (!format && js && (has(".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml", "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts", "eslint.config.cts") || dependency("eslint") || packages.some(pkg => pkg.eslintConfig !== undefined))) candidates.add("eslint");
  if (format && (js || [".json", ".jsonc", ".css", ".scss", ".less", ".md", ".mdx", ".html", ".yaml", ".yml", ".graphql", ".gql"].includes(ext)) && (has(".prettierrc", ".prettierrc.json", ".prettierrc.yml", ".prettierrc.yaml", ".prettierrc.json5", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs", ".prettierrc.toml", "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs", "prettier.config.ts") || dependency("prettier") || packages.some(pkg => pkg.prettier !== undefined))) candidates.add("prettier");
  return [...candidates];
}
function matchingServers(args: Options, file: string) {
  return fileServers(availableServers(loadConfigFor(args, file), dirname(file), args.globalBinsOnly), file);
}
function loadConfigFor(args: Options, file: string) { return loadConfig(dirname(file), args.globalConfigOnly); }
function missingProvider(file: string, format: boolean) {
  const tool = [".py", ".pyi"].includes(extname(file)) ? "ruff" : extname(file) === ".rs" ? format ? "rustfmt" : "clippy" : format ? "prettier" : "eslint";
  const guide: Record<string, string> = {
    ruff: "uv tool install ruff; https://docs.astral.sh/ruff/installation/",
    rustfmt: "rustup component add rustfmt; https://rust-lang.github.io/rustfmt/",
    clippy: "rustup component add clippy; https://doc.rust-lang.org/clippy/installation.html",
    prettier: "npm install --save-dev prettier; https://prettier.io/docs/install",
    eslint: "npm install --save-dev eslint; https://eslint.org/docs/latest/use/getting-started",
  };
  return `No ${format ? "formatter" : "linter"} is configured for ${file}. Choose --tool ${tool} or --server NAME; ${guide[tool]}`;
}
function toolFingerprint(name: string, command: string) {
  const path = realpathSync(command), info = statSync(path);
  return hash(JSON.stringify([name, path, info.size, info.mtimeMs]));
}
function lspFingerprint(server: Server) { return hash(JSON.stringify([serverFingerprint(server), toolFingerprint(server.name, server.resolvedCommand)])); }
function displayDiagnostics(records: FileResult[], args: Options) {
  const diagnostics = records.flatMap(record => record.diagnostics.map(diagnostic => ({ file: record.file, line: diagnostic.range.start.line + 1, column: diagnostic.range.start.character + 1, severity: diagnostic.severity ?? 1, code: diagnostic.code, source: diagnostic.source, message: diagnostic.message })));
  const selected = args.limit ? diagnostics.slice(0, args.limit) : diagnostics;
  const { items, ...preview } = compactText(selected, ["message"], args.limit);
  return { total: diagnostics.length, shown: items.length, truncated: items.length < diagnostics.length || !!preview.truncated, ...preview, diagnostics: items };
}
function pureActionEdits(value: unknown, uri: string, text: string, version: number): TextEdit[] {
  const action = normalizeCodeAction(object(value) as unknown as CodeAction, uri, text);
  if (action.command !== undefined || action.disabled !== undefined) throw new Error("Action requires a server command or is disabled; use code-actions for individual review");
  const changes = normalizedEdits(action.edit);
  if ([...changes.keys()].some(target => target !== uri)) throw new Error("Lint action edits another file; use fix --server NAME for a multi-file review");
  for (const change of object(action.edit).documentChanges as ObjectValue[] ?? []) {
    const document = object(change.textDocument);
    if (document.version != null && document.version !== version) throw new Error("Lint edit document version is stale");
  }
  const edits = changes.get(uri) ?? [];
  validateEdits(text, edits); return edits;
}

async function lintFixes(client: LspClient, uri: string, text: string, diagnostics: Diagnostic[], row: FileResult, args: Options, deadline: number): Promise<string> {
  const file = row.file, server = client.server;
  if (!client.capabilities.codeActionProvider) row.skipped.push({ file, server: server.name, reason: "No codeActionProvider; lint diagnostics remain available" });
  else {
    const lines = text.split("\n"), end = { line: lines.length - 1, character: lines.at(-1)!.replace(/\r$/, "").length };
    const response = await requestBefore(client, "textDocument/codeAction", { textDocument: { uri }, range: { start: { line: 0, character: 0 }, end }, context: { diagnostics, only: requestedActionKinds(client, args.kind ?? "source.fixAll"), triggerKind: 1 } }, deadline);
    if (response !== null && !Array.isArray(response)) throw new Error("Invalid LSP code-action response");
    if ((response?.length ?? 0) > MAX_FILES) throw new Error("Lint code actions exceed 200; narrow the source scope");
    const edits: TextEdit[] = [];
    for (const raw of response ?? []) {
      let action = object(raw);
      if (typeof action.title !== "string") throw new Error("Invalid lint code action");
      if (typeof action.kind !== "string" || !(action.kind === (args.kind ?? "source.fixAll") || action.kind.startsWith(`${args.kind ?? "source.fixAll"}.`))) { row.skipped.push({ file, server: server.name, title: action.title, reason: "Action is outside the requested source.fixAll kind; review code-actions individually" }); continue; }
      if (!action.edit && !action.command && !action.disabled && object(client.capabilities.codeActionProvider).resolveProvider) {
        action = object(await requestBefore(client, "codeAction/resolve", raw, deadline));
        if (typeof action.title !== "string" || typeof action.kind !== "string" || !(action.kind === (args.kind ?? "source.fixAll") || action.kind.startsWith(`${args.kind ?? "source.fixAll"}.`))) throw new Error("Invalid resolved lint action");
      }
      try { edits.push(...pureActionEdits(action, uri, text, client.documents.get(uri)!.version)); }
      catch (error) { row.skipped.push({ file, server: server.name, title: action.title, reason: error instanceof Error ? error.message : String(error) }); }
      if (edits.length > 10000) throw new Error("Lint fixes exceed 10000 edits; narrow the source scope");
    }
    const seen = new Set<string>(), unique = edits.filter(edit => { const key = JSON.stringify(edit); if (seen.has(key)) return false; seen.add(key); return true; });
    if (unique.some((edit, index) => edit.range.start.line === edit.range.end.line && edit.range.start.character === edit.range.end.character && unique.slice(0, index).some(other => JSON.stringify(other.range) === JSON.stringify(edit.range) && other.newText !== edit.newText))) throw new Error("Conflicting lint insertions; review code-actions individually");
    return validateEdits(text, unique);
  }
  return text;
}

async function collect(args: Options, paths: string[], format: boolean, fixes: boolean, session?: Session, pinned?: Provider[]): Promise<Collection> {
  const pool = session ?? { clients: new Map<string, LspClient>(), diagnostics: false };
  const cache = new Map<string, Promise<ToolProcessResult>>(), guards = new Map<string, string | null>(), providers: Provider[] = [], fingerprints = new Set<string>(), files: FileResult[] = [], skipped: ObjectValue[] = [];
  const deadline = Date.now() + args.timeout; let bytes = 0, diagnosticBytes = 0;
  const guard = (path: string) => {
    const key = existsSync(path) ? realpathSync(path) : resolve(path);
    const current = existsSync(path) ? hash(readText(path)) : null;
    if (guards.has(key) && guards.get(key) !== current) throw new Error(`Tool configuration changed during analysis: ${key}`);
    guards.set(key, current);
    if (guards.size > MAX_FILES * 16) throw new Error("Tool configuration scope exceeds 3200 paths; narrow the file scope");
  };
  const clientFor = async (server: Server, file: string) => {
    const client = await sessionClient(server, { ...args, apply: false }, pool);
    const opened = await client.open(file); await client.ready(opened.uri);
    return { client, ...opened };
  };
  try {
    for (const file of paths) {
      if (Date.now() >= deadline) throw new Error("Tool analysis deadline exceeded; narrow scope or increase --timeout");
      const requested = pinned?.filter(provider => provider.file === file), declarations = args.tool || args.server || pinned ? [] : declaredTools(file, format);
      const servers = args.server || requested?.some(provider => provider.kind === "lsp") || !args.tool && !requested && !declarations.length ? matchingServers(args, file) : [];
      const requestedServer = args.server ? loadConfigFor(args, file)[args.server] : undefined;
      if (args.changed && !pinned && (args.tool && !toolSupports(args.tool, file) || args.server && requestedServer && !matchesFile(requestedServer, file) || !args.tool && !args.server && !declarations.length && !servers.some(server => format || server.isLinter) && ![".py", ".pyi", ".rs", ...jsExtensions].includes(extname(file).toLowerCase()))) {
        skipped.push({ file, reason: `No configured ${format ? "formatter" : "linter"} matches this changed file` }); continue;
      }
      const original = readText(file); bytes += Buffer.byteLength(original);
      if (bytes > MAX_FILE_BYTES) throw new Error("Tool source scope exceeds 16 MiB; narrow the file scope");
      const row: FileResult = { file, original, updated: original, providers: [], diagnostics: [], verified: true, errors: [], skipped: [] }; files.push(row);
      let selected: Provider[] = requested ?? (args.tool ? [{ file, kind: "cli", name: args.tool }] : args.server ? [{ file, kind: "lsp", name: args.server }] : declarations.map(name => ({ file, kind: "cli" as const, name })));
      if (!selected.length) {
        const candidates = servers.filter(server => format || server.isLinter);
        if (format) {
          // Prefer a project's linter formatter before a semantic server's generic formatter.
          candidates.sort((a, b) => Number(!!b.isLinter) - Number(!!a.isLinter));
          for (const server of candidates) {
            const { client } = await clientFor(server, file);
            if (args.range ? client.capabilities.documentRangeFormattingProvider : client.capabilities.documentFormattingProvider) { selected = [{ file, kind: "lsp", name: server.name }]; break; }
          }
        } else selected = candidates.map(server => ({ file, kind: "lsp", name: server.name }));
      }
      if (!selected.length) { row.verified = false; row.errors.push(missingProvider(file, format)); continue; }
      if (format && selected.length > 1) { row.verified = false; row.errors.push(`Multiple project formatters (${selected.map(provider => provider.name).join(", ")}); choose one with --tool NAME or --server NAME`); continue; }
      const updates: string[] = [];
      for (const provider of selected) {
        try {
          let fingerprint: string, updated = original, diagnostics: Diagnostic[] = [], verified = true, ignored = false;
          const beforeGuards = [...guards.keys()];
          if (provider.kind === "cli") {
            if (!tools.includes(provider.name as ToolName)) throw new Error(`Unknown tool ${provider.name}; choose ${tools.join(", ")}`);
            if (args.range) throw new Error("CLI formatting does not support --range; select --server NAME with documentRangeFormattingProvider");
            for (const path of toolConfigCandidates(provider.name as ToolName, file, args.globalConfigOnly)) guard(path);
            const result = await runToolProcess({ ...args, timeout: Math.max(1, deadline - Date.now()) }, file, provider.name as ToolName, format ? "format" : fixes ? "fix" : "lint", cache);
            if (result.original !== original) throw new Error("Source changed during tool analysis; retry");
            fingerprint = toolFingerprint(provider.name, result.command); verified = result.verified && !result.errors?.length; ignored = !!result.ignored;
            diagnostics = result.diagnostics; updated = result.updated ?? original;
            if (provider.name === "oxlint" && fixes && verified && !ignored && diagnostics.length) {
              const root = gitRoot(dirname(file));
              const server: Server = { name: "oxlint", command: result.command, resolvedCommand: result.command, args: ["--lsp"], fileTypes: jsExtensions, root,
                initOptions: [{ workspaceUri: fileUri(root), options: { fixKind: "safe_fix" } }],
              };
              const { client, uri, text } = await clientFor(server, file);
              if (text !== original) throw new Error("Source changed while opening Oxlint fix preview; retry");
              const report = await client.getDiagnostics(uri, Math.max(1, deadline - Date.now()));
              const signature = (items: Diagnostic[]) => [...new Set(items.map(item => JSON.stringify([item.code, item.severity ?? 1, item.range.start.line, item.range.start.character, item.range.end.line, item.range.end.character, item.message.split("\nhelp: ")[0]])))].sort().join("\n");
              if (!report.verified || signature(report.diagnostics) !== signature(diagnostics)) throw new Error("Oxlint CLI and fix-provider diagnostics differ or are unverified; retry after project configuration and analysis settle");
              updated = await lintFixes(client, uri, text, report.diagnostics, row, args, deadline);
            }
            row.errors.push(...result.errors ?? []);
            for (const path of result.configFiles) guard(path);
            // Bind discovery inputs as well as the tool's effective configuration.
            for (const path of toolConfigCandidates(provider.name as ToolName, file, args.globalConfigOnly)) guard(path);
            row.providers.push({ kind: provider.kind, name: provider.name, command: result.command, verified, ...(ignored ? { ignored: true } : {}), ...(result.cargo ? { cargo: result.cargo } : {}) });
          } else {
            const server = servers.find(server => server.name === provider.name);
            if (!server) throw new Error(`Configured server ${provider.name} is unavailable for ${file}; run codex-lsp status --file PATH and setup <language> --project`);
            fingerprint = lspFingerprint(server);
            for (const path of configPaths(dirname(file), args.globalConfigOnly)) guard(path);
            for (const marker of server.rootMarkers ?? []) if (!/[*?\[]/.test(marker) && existsSync(join(server.root, marker)) && statSync(join(server.root, marker)).isFile()) guard(join(server.root, marker));
            let ignoreStatus: string | undefined;
            if (server.name === "biome") {
              ignoreStatus = "unknown";
              const command = resolveToolCommand("biome", file, args.globalBinsOnly);
              if (!Object.keys(server.settings ?? {}).length && !Object.keys(server.initOptions ?? {}).length && JSON.stringify(server.args ?? []) === JSON.stringify(["lsp-proxy"]) && command && realpathSync(command) === realpathSync(server.resolvedCommand)) {
                for (const path of toolConfigCandidates("biome", file)) guard(path);
                const probe = await runToolProcess({ ...args, timeout: Math.max(1, deadline - Date.now()) }, file, "biome", format ? "format" : "lint", cache);
                if (probe.original !== original) throw new Error("Source changed during Biome ignore preflight; retry");
                if (!probe.verified || probe.errors?.length) throw new Error(`Biome ignore preflight is unverified: ${probe.errors?.join("; ") ?? "check project configuration"}`);
                for (const path of probe.configFiles) guard(path);
                ignoreStatus = probe.ignored ? "ignored" : "included";
                if (probe.ignored) {
                  if (provider.fingerprint && provider.fingerprint !== fingerprint) throw new Error(`Tool provider changed since planning: ${provider.name}`);
                  row.providers.push({ kind: provider.kind, name: provider.name, verified: true, ignored: true, ignoreStatus, ignoredBy: { kind: "cli", name: "biome", command: probe.command } });
                  providers.push({ file, kind: provider.kind, name: provider.name, fingerprint }); fingerprints.add(fingerprint);
                  continue;
                }
              }
            }
            const { client, uri, text } = await clientFor(server, file);
            if (text !== original) throw new Error("Source changed while opening the LSP document; retry");
            let hint: string | undefined;
            if (format) {
              const capability = args.range ? "documentRangeFormattingProvider" : "documentFormattingProvider";
              if (!client.capabilities[capability]) throw new Error(`${server.name} does not advertise ${capability}; choose another --server or --tool`);
              if (args.range) validateEdits(text, [{ range: args.range, newText: "" }]);
              const response = await requestBefore(client, args.range ? "textDocument/rangeFormatting" : "textDocument/formatting", { textDocument: { uri }, ...(args.range ? { range: args.range } : {}), options: { tabSize: 4, insertSpaces: true } }, deadline);
              if (response !== null && !Array.isArray(response)) throw new Error("Invalid LSP formatting response; expected TextEdit[] or null");
              updated = validateEdits(text, response ?? []);
              if (ignoreStatus === "unknown" && updated === text) hint = "Biome returned no formatting edits; ignore status is unknown with these LSP settings or executable. Check excludes with --tool biome when needed.";
            } else {
              const report = await client.getDiagnostics(uri, Math.max(1, deadline - Date.now())); diagnostics = report.diagnostics; verified = report.verified;
              if (!verified) row.errors.push(server.name === "biome" ? "Biome did not publish verified diagnostics; check project excludes or compare codex-lsp lint --file PATH --tool biome." : `${server.name} diagnostics are unverified; run doctor --file PATH and retry after analysis settles`);
              if (fixes && verified) {
                updated = await lintFixes(client, uri, text, diagnostics, row, args, deadline);
              }
            }
            row.providers.push({ kind: provider.kind, name: provider.name, verified, ...(ignoreStatus ? { ignoreStatus } : {}), ...(hint ? { hint } : {}) });
          }
          if (provider.fingerprint && provider.fingerprint !== fingerprint) throw new Error(`Tool provider changed since planning: ${provider.name}`);
          providers.push({ file, kind: provider.kind, name: provider.name, fingerprint }); fingerprints.add(fingerprint);
          row.verified &&= verified;
          for (const diagnostic of diagnostics) validateEdits(original, [{ range: diagnostic.range, newText: "" }]);
          diagnosticBytes += Buffer.byteLength(JSON.stringify(diagnostics));
          if (diagnosticBytes > MAX_FILE_BYTES) throw new Error("Aggregate lint diagnostics exceed 16 MiB; narrow the source scope");
          row.diagnostics.push(...diagnostics);
          if (updated !== original && !ignored) updates.push(updated);
          if (readText(file) !== original) throw new Error("Source changed during tool analysis; retry");
          for (const path of beforeGuards) if ((existsSync(path) ? hash(readText(path)) : null) !== guards.get(path)) throw new Error(`Tool configuration changed during analysis: ${path}`);
        } catch (error) {
          row.verified = false;
          const raw = String(failure(error, args.limit).error), message = args.limit ? textPrefix(raw, 2000) : raw;
          diagnosticBytes += Buffer.byteLength(message);
          if (diagnosticBytes > MAX_FILE_BYTES) throw new Error("Aggregate tool output exceeds 16 MiB; narrow the source scope");
          row.errorTruncated ||= message.length < raw.length;
          row.errors.push(message);
        }
      }
      const distinct = [...new Set(updates)];
      if (distinct.length > 1) { row.verified = false; row.errors.push("Multiple linters proposed different fixes for this file; choose one with --tool NAME or --server NAME"); }
      else row.updated = distinct[0] ?? original;
      if (row.updated !== original) bytes += Buffer.byteLength(row.updated);
      if (bytes > MAX_FILE_BYTES) throw new Error("Tool source snapshots exceed 16 MiB; narrow the source scope");
      const seen = new Set<string>(); row.diagnostics = row.diagnostics.filter(diagnostic => { const key = JSON.stringify(diagnostic); if (seen.has(key)) return false; seen.add(key); return true; });
    }
    for (const [file, expected] of guards) if ((existsSync(file) ? hash(readText(file)) : null) !== expected) throw new Error(`Tool configuration changed during analysis: ${file}`);
    for (const file of files) if (readText(file.file) !== file.original) { file.verified = false; if (!file.errors.some(error => /Source changed/.test(error))) file.errors.push(`Source changed during tool analysis: ${file.file}; retry`); }
    return { files, providers, guards, fingerprints: [...fingerprints], skipped };
  } finally { if (!session) await Promise.allSettled([...pool.clients.values()].map(client => client.close())); }
}

export async function runTooling(args: Options, session?: Session): Promise<Result> {
  const format = args.command === "format";
  if (args.query !== undefined || args.symbol !== undefined || args.column !== undefined || args.line !== 1 && !args.range || args.workspace || args.newName !== undefined)
    throw new Error("lint/format operate on files; omit --query and position/workspace/rename options. Use code-actions or fix --server NAME --query INDEX for a selected LSP action");
  if (args.apply || !!args.file === args.changed || args.tool && args.server || args.check && !format || args.range && !format || args.plan && args.check || session && args.plan)
    throw new Error(`Use ${format ? "format" : "lint"} --file PATH or --changed; choose --tool NAME or --server NAME. Save changes with --plan PATH.json and apply the reviewed plan separately`);
  if (args.kind && !(args.kind === "source.fixAll" || args.kind.startsWith("source.fixAll."))) throw new Error("lint plans support source.fixAll kinds; use fix for quickfix selection");
  const root = realpathSync(gitRoot(args.cwd));
  const paths = args.file ? [resolveFile(args.file, args.cwd)] : (await changedFiles(args.cwd)).filter(file => !args.plan || file !== resolve(args.cwd, args.plan));
  if (paths.length > MAX_FILES) throw new Error("Tool scope exceeds 200 files; narrow the changed file set");
  const result = await collect(args, paths, format, !!args.plan, session);
  const verified = result.files.every(file => file.verified && !file.errors.length), hasErrors = result.files.some(file => file.diagnostics.some(diagnostic => (diagnostic.severity ?? 1) === 1));
  const changed = result.files.filter(file => file.updated !== file.original), errors = result.files.flatMap(file => file.errors.map(error => ({ file: file.file, error, ...(file.errorTruncated ? { errorTruncated: true } : {}) })));
  const summary = displayDiagnostics(result.files, args);
  const ignoredFiles = result.files.filter(file => file.providers.length > 0 && file.providers.every(provider => provider.ignored)).length;
  const providerHints = [...new Set(result.files.flatMap(file => file.providers.flatMap(provider => typeof provider.hint === "string" ? [provider.hint] : [])))];
  const scopeNote = [ignoredFiles ? `${ignoredFiles} ignored` : "", result.skipped.length ? `${result.skipped.length} unsupported changed file(s) skipped` : "", ...providerHints].filter(Boolean).join(", ");
  const checked = result.files.map(file => ({ file: file.file, verified: file.verified, diagnosticCount: file.diagnostics.length, changed: file.updated !== file.original, providers: file.providers }));
  const errorHint = result.files.some(file => file.errorTruncated) ? "Tool error text clipped; use --limit 0 --json for complete output." : undefined;
  const base = { command: args.command, success: verified, applied: false, verified, hasErrors, checked, checkedFiles: checked.length, skipped: result.skipped, skippedCount: result.skipped.length, ignoredFiles, changedFiles: changed.length, diagnosticCount: summary.total, ...(format ? { needsFormatting: !!changed.length } : {}), errors, ...summary, ...(providerHints.length ? { hint: providerHints.join(" ") } : {}), ...(errorHint ? { errorTruncated: true, hint: errorHint } : {}) };
  if (!verified) return { data: base, code: 1, human: [`${args.command}: ${errors.length} tool error(s)`, ...errors.map(row => `${row.file}: ${row.error}`), errorHint].filter(Boolean).join("\n") };
  if (args.check) return { data: { ...base, check: true, files: changed.map(file => ({ file: file.file })), total: changed.length, shown: changed.length, truncated: false }, code: changed.length ? 1 : 0, human: [`format: ${result.files.length} file(s), ${changed.length} would change`, ...changed.map(file => file.file), scopeNote].filter(Boolean).join("\n") };
  if (format || args.plan) {
    const records = result.files.map(({ file, diagnostics, verified, errors }) => ({ file, diagnostics, verified, errors }));
    const baseline = !format ? captureBaseline(records, root, result.fingerprints, new Map(result.files.map(file => [file.file, file.original]))) : undefined;
    const verification = { schema: 1, command: format ? "format" : "lint", providers: result.providers, ...(args.range ? { range: args.range } : {}), ...(baseline ? { baseline } : {}) };
    const plan = await saveEditPlan(args, { kind: format ? "format" : "lint", files: changed, actions: changed.map(file => ({ file: file.file, tools: file.providers.map(provider => provider.name) })), skipped: [...result.skipped, ...result.files.flatMap(file => file.skipped)], verification, guards: [...result.guards].map(([file, sha256]) => ({ file, sha256 })) });
    return { data: { ...base, ...plan.data, success: true, verified, hasErrors, check: !!args.check }, code: args.check ? changed.length ? 1 : 0 : !format && args.plan && !changed.length && hasErrors ? 1 : 0,
      human: [`${args.command}: ${result.files.length} file(s), ${changed.length} would change${summary.total ? `, ${summary.total} diagnostic(s)` : ""}`, scopeNote, plan.human].filter(Boolean).join("\n") };
  }
  return { data: base, code: hasErrors ? 1 : 0, human: [`lint: ${result.files.length} file(s), ${summary.total} diagnostic(s)`, scopeNote, ...summary.diagnostics.map(diagnostic => `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} [${diagnostic.source ?? "lint"}${diagnostic.code === undefined ? "" : `:${diagnostic.code}`}] ${diagnostic.message}`), summary.truncated ? `Showing ${summary.shown}; use --limit 0 --json for all diagnostics` : undefined].filter(Boolean).join("\n") };
}

export async function verifyToolPlan(files: string[], verification: ObjectValue, args: Options): Promise<Result> {
  const providers = toolPlanProviders(files, verification, args), paths = [...new Set(providers.map(provider => provider.file))];
  const format = verification.command === "format";
  const result = await collect({ ...args, command: String(verification.command), apply: false, file: undefined, changed: false, plan: undefined, tool: undefined, server: undefined, range: verification.range as Options["range"] }, paths, format, false, undefined, providers);
  const complete = result.files.every(file => file.verified && !file.errors.length), records = result.files.map(({ file, diagnostics, verified, errors }) => ({ file, diagnostics, verified, errors }));
  const comparison = !format && complete ? compareBaseline(verification.baseline as Baseline, captureBaseline(records, realpathSync(gitRoot(args.cwd)), result.fingerprints), paths, result.fingerprints, args.limit) : undefined;
  const changed = result.files.filter(file => file.updated !== file.original).map(file => file.file);
  const verified = complete && (format || comparison?.verified === true), hasErrors = format ? !!changed.length : !verified || Number(comparison?.newErrors) > 0;
  return { data: { success: verified && !hasErrors, verified, hasErrors, ...(comparison ? { comparison } : {}), ...(format ? { needsFormatting: !!changed.length, stillNeedsFormatting: changed } : {}), errors: result.files.flatMap(file => file.errors.map(error => ({ file: file.file, error, ...(file.errorTruncated ? { errorTruncated: true } : {}) }))), checked: result.files.map(file => ({ file: file.file, verified: file.verified, providers: file.providers, diagnosticCount: file.diagnostics.length })) }, code: verified && !hasErrors ? 0 : 1, human: format ? changed.length ? `${changed.length} file(s) still need formatting` : "Formatting is idempotent" : "Lint diagnostics compared with the plan baseline" };
}

function toolPlanProviders(files: string[], verification: ObjectValue, args: Options): Provider[] {
  if (verification.schema !== 1 || !["lint", "format"].includes(String(verification.command)) || !Array.isArray(verification.providers) || verification.providers.length > MAX_FILES * 8) throw new Error("Invalid tool-plan verification descriptor");
  const providers = verification.providers.map(raw => {
    const provider = object(raw);
    if (typeof provider.file !== "string" || !["cli", "lsp"].includes(String(provider.kind)) || typeof provider.name !== "string" || typeof provider.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(provider.fingerprint)) throw new Error("Invalid tool-plan provider");
    return provider as unknown as Provider;
  });
  const paths = [...new Set(providers.map(provider => provider.file))];
  if (paths.some(file => resolveFile(file, args.cwd) !== file) || files.some(file => !paths.includes(file)) || verification.range !== undefined && !validRange(verification.range)) throw new Error("Invalid tool-plan file scope or range");
  return providers;
}
export async function validateToolPlan(files: string[], verification: ObjectValue, args: Options): Promise<void> {
  for (const provider of toolPlanProviders(files, verification, args)) {
    const command = provider.kind === "cli" && tools.includes(provider.name as ToolName) ? resolveToolCommand(provider.name as ToolName, provider.file, args.globalBinsOnly) : undefined;
    const server = provider.kind === "lsp" ? matchingServers(args, provider.file).find(server => server.name === provider.name) : undefined;
    const fingerprint = command ? toolFingerprint(provider.name, command) : server ? lspFingerprint(server) : undefined;
    if (fingerprint !== provider.fingerprint) throw new Error(`Tool provider changed since planning: ${provider.name}; generate a fresh plan`);
  }
}
