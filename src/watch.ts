import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { changedFiles, diagnostics, outputData, type Options, type Session } from "./commands.ts";
import { configPaths, expandHome, fileUri, MAX_FILES, MAX_FILE_BYTES, object, readText, resolveFile, uriFile, type ObjectValue } from "./config.ts";
import { compactText, failure } from "./output.ts";
import type { Diagnostic } from "./omp/types.ts";

interface Issue extends ObjectValue {
  id: string; file: string; line: number; column: number; endLine: number; endColumn: number;
  severity: number; code?: string | number; source?: string; message: string;
}
interface Tracked { issue: Issue; anchor: string; }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function snapshot(args: Options) {
  const paths = args.changed ? await changedFiles(args.cwd) : [resolve(args.cwd, expandHome(args.file!))];
  const texts = new Map<string, string>(), missing: string[] = [], configs = new Map<string, string>();
  let characters = 0;
  for (const requested of paths) {
    if (!existsSync(requested)) { missing.push(requested); continue; }
    const file = resolveFile(requested, args.cwd), text = readText(file);
    characters += text.length;
    if (characters > MAX_FILE_BYTES) throw new Error("Watch source text exceeds the 16M-character limit; narrow to --file");
    texts.set(file, text);
    for (const config of configPaths(dirname(file), args.globalConfigOnly)) configs.set(config, existsSync(config) ? readText(resolveFile(config, args.cwd)) : "");
  }
  for (const config of configPaths(args.cwd, args.globalConfigOnly)) configs.set(config, existsSync(config) ? readText(resolveFile(config, args.cwd)) : "");
  const configuration = hash(JSON.stringify([...configs].sort()));
  const signature = hash(JSON.stringify([[...texts].map(([file, text]) => [file, hash(text)]).sort(), missing, configuration]));
  return { texts, missing, configuration, signature };
}

function matchIssues(file: string, text: string, values: Diagnostic[], previous: Tracked[]): Tracked[] {
  const used = new Set<Tracked>(), lines = text.split("\n"), lineAnchors = new Map<number, string>(), occurrences = new Map<string, number>(), reserved = new Set(previous.map(row => row.issue.id));
  const anchors = new Map<string, Tracked[]>(), positions = new Map<string, Tracked[]>(), messages = new Map<string, Tracked[]>();
  const append = (index: Map<string, Tracked[]>, key: string, row: Tracked) => { if (!index.has(key)) index.set(key, []); index.get(key)!.push(row); };
  const key = (code: unknown, source: unknown, location: string | number, column: number) => JSON.stringify([code, source, location, column]);
  for (const row of previous) {
    const anchor = key(row.issue.code, row.issue.source, row.anchor, row.issue.column), position = key(row.issue.code, row.issue.source, row.issue.line, row.issue.column);
    append(anchors, anchor, row); append(positions, position, row); append(messages, `${anchor}:${JSON.stringify(row.issue.message)}`, row); append(messages, `${position}:${JSON.stringify(row.issue.message)}`, row);
  }
  const take = (index: Map<string, Tracked[]>, key: string) => { const rows = index.get(key); let row: Tracked | undefined; while ((row = rows?.pop())) if (!used.has(row)) return row; };
  const points = values.map(diagnostic => {
    const start = diagnostic.range.start, end = diagnostic.range.end;
    for (const point of [start, end]) {
      const line = lines[point.line]?.replace(/\r$/, ""), unit = line?.charCodeAt(point.character);
      if (line === undefined || point.character > line.length || unit !== undefined && unit >= 0xdc00 && unit <= 0xdfff)
        throw new Error(`Diagnostic range is outside the current source or splits Unicode: ${file}`);
    }
    if (!lineAnchors.has(start.line)) lineAnchors.set(start.line, hash(lines[start.line].trim()));
    const anchor = lineAnchors.get(start.line)!;
    const anchored = key(diagnostic.code, diagnostic.source, anchor, start.character + 1), positioned = key(diagnostic.code, diagnostic.source, start.line + 1, start.character + 1), message = JSON.stringify(diagnostic.message);
    return { anchor, anchored, positioned, message };
  });
  // Reserve unchanged messages before matching updates at the same position.
  const unchanged = points.map(point => {
    const old = take(messages, `${point.anchored}:${point.message}`) ?? take(messages, `${point.positioned}:${point.message}`);
    if (old) used.add(old); return old;
  });
  return values.map((diagnostic, index) => {
    const { anchor, anchored, positioned } = points[index], start = diagnostic.range.start, end = diagnostic.range.end;
    const old = unchanged[index] ?? take(anchors, anchored) ?? take(positions, positioned);
    if (old) used.add(old);
    const identity = JSON.stringify([file, diagnostic.code, diagnostic.source, anchor, start.character]);
    let occurrence = occurrences.get(identity) ?? 0, id = old?.issue.id;
    if (!id) { while (reserved.has(id = hash(`${identity}:${occurrence++}`).slice(0, 20))) { /* Duplicate diagnostics retain distinct IDs. */ } }
    reserved.add(id); occurrences.set(identity, occurrence);
    return { anchor, issue: { id, file,
      line: start.line + 1, column: start.character + 1, endLine: end.line + 1, endColumn: end.character + 1,
      severity: diagnostic.severity ?? 1, ...(diagnostic.code !== undefined ? { code: diagnostic.code } : {}),
      ...(diagnostic.source !== undefined ? { source: diagnostic.source } : {}), message: diagnostic.message } };
  });
}

async function write(output: Writable, value: ObjectValue) {
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { output.removeListener("error", failed); reject(error); };
    output.once("error", failed);
    output.write(JSON.stringify(value) + "\n", error => {
      if (error) reject(error);
      else { output.removeListener("error", failed); resolve(); }
    });
  });
}

export async function watchDiagnostics(args: Options, output: Writable = process.stdout, signal?: AbortSignal): Promise<number> {
  if (!!args.file === args.changed || args.apply || args.baseline || args.saveBaseline || args.input || args.stdio || args.newName || args.method || args.payload)
    throw new Error("Watch is read-only; choose diagnostics --file PATH or --changed with --watch --jsonl, without baseline/write options");
  const session: Session = { clients: new Map(), diagnostics: true }, known = new Map<string, Tracked[]>();
  const close = () => Promise.allSettled([...session.clients.values()].map(client => client.close()));
  const aborted = () => { void close(); };
  signal?.addEventListener("abort", aborted, { once: true });
  let signature = "", configuration = "", incoming = "", lastOutput = "", state = "", first = true, retry = false, sequence = 0, code = 0;
  const send = async (event: string, data: ObjectValue) => {
    const selected = outputData(data, { fields: ["starting", "closed"].includes(event) ? undefined : args.fields });
    await write(output, outputData({ ...selected, event, sequence: ++sequence }, { budget: args.budget }));
  };
  const preview = (issues: Issue[]) => {
    const { items, ...info } = compactText(args.limit ? issues.slice(0, args.limit) : issues, ["message"], args.limit);
    return { total: issues.length, shown: items.length, ...info, truncated: !!info.truncated || items.length < issues.length, diagnostics: items };
  };
  try {
    if (!signal?.aborted) await send("starting", { success: true, verified: false, code: 0, retained: false, file: args.file, changed: args.changed,
      hint: "Initializing language server and diagnostics; a verified snapshot follows. SIGINT closes this watch." });
    while (!signal?.aborted) {
      let event = "diagnostics", data: ObjectValue | undefined;
      try {
        const before = await snapshot(args);
        if (signal?.aborted) break;
        if (first && before.missing.length) throw new Error(`File not found: ${before.missing[0]}; watch will retry when it is created`);
        for (const client of session.clients.values()) for (const uri of client.diagnostics.keys()) if (!client.documents.has(uri)) client.diagnostics.delete(uri);
        const notifications = hash(JSON.stringify([...session.clients.values()].flatMap(client => [...client.diagnostics].filter(([uri]) => client.documents.has(uri)))));
        if (first || retry || before.signature !== signature || notifications !== incoming) {
          if (configuration && configuration !== before.configuration) { await close(); session.clients.clear(); }
          for (const [key, client] of session.clients) {
            if (!client.reusable) { await client.close(); session.clients.delete(key); continue; }
            for (const uri of client.documents.keys()) if (!before.texts.has(uriFile(uri)!)) {
              await client.notify("textDocument/didClose", { textDocument: { uri } }); client.documents.delete(uri); client.diagnostics.delete(uri);
            }
            for (const uri of client.diagnostics.keys()) if (!client.documents.has(uri)) client.diagnostics.delete(uri);
            await client.refresh();
          }
          const result = args.file && before.missing.length ? { data: { verified: true, checked: [], counts: {} } } : await diagnostics({ ...args, limit: 0, fields: undefined, budget: undefined }, undefined, session);
          if (signal?.aborted) break;
          const after = await snapshot(args);
          if (signal?.aborted) break;
          if (before.signature !== after.signature) throw new Error("Source or configuration changed during watch analysis; retaining the last verified diagnostics and retrying");
          const checked = object(result.data).checked as ObjectValue[], next = new Map(known), files: ObjectValue[] = [];
          const scoped = new Set(before.texts.keys()), removedFiles: ObjectValue[] = [];
          for (const file of known.keys()) if (!scoped.has(file)) {
            removedFiles.push({ file, reason: existsSync(file) ? "out-of-scope" : "deleted" }); next.delete(file);
          }
          let verified = result.data.verified === true;
          for (const record of checked) {
            const file = String(record.file), text = before.texts.get(file);
            const versions = [...new Set([...session.clients.values()].flatMap(client => {
              const document = client.documents.get(fileUri(file)); return document ? [document.version] : [];
            }))];
            files.push({ file, verified: record.verified, ...(text !== undefined ? { sha256: hash(text), versions } : {}), errors: record.errors });
            if (record.verified === true && text !== undefined && Array.isArray(record.diagnostics)) next.set(file, matchIssues(file, text, record.diagnostics as Diagnostic[], known.get(file) ?? []));
            else verified = false;
          }
          const oldIssues = [...known.values()].flat().map(row => row.issue), current = [...next.values()].flat().map(row => row.issue);
          if (next.size > MAX_FILES || JSON.stringify(current).length > MAX_FILE_BYTES) throw new Error("Watch diagnostic state exceeds its bounded 200-file/16M-character limit; narrow to --file");
          const oldById = new Map(oldIssues.map(issue => [issue.id, issue])), byId = new Map(current.map(issue => [issue.id, issue]));
          const added = current.filter(issue => !oldById.has(issue.id)), updated = current.filter(issue => oldById.has(issue.id) && JSON.stringify(issue) !== JSON.stringify(oldById.get(issue.id)));
          const excluded = new Set(removedFiles.filter(file => file.reason === "out-of-scope").map(file => file.file));
          const resolved = oldIssues.filter(issue => !byId.has(issue.id) && !excluded.has(issue.file));
          known.clear(); for (const [file, issues] of next) known.set(file, issues);
          const counts = { errors: 0, warnings: 0, information: 0, hints: 0 };
          for (const issue of current) counts[(["errors", "warnings", "information", "hints"] as const)[issue.severity - 1]]++;
          const errors = checked.flatMap(record => Array.isArray(record.errors) ? record.errors : []);
          code = verified && !counts.errors && !errors.length ? 0 : 1;
          event = first ? "snapshot" : "diagnostics";
          const nextState = JSON.stringify([verified, counts, files, removedFiles, errors, [...current].sort((a, b) => a.id.localeCompare(b.id))]);
          if (first || retry || nextState !== state) data = { success: code === 0, verified, hasErrors: counts.errors > 0, code, retained: !verified, total: current.length, counts, checkedFiles: checked.length,
              files, removedFiles, errors, changes: { counts: { new: added.length, resolved: resolved.length, updated: updated.length, existing: current.length - added.length - updated.length },
                new: preview(added), resolved: preview(resolved), updated: preview(updated) } };
          state = nextState;
          signature = before.signature; configuration = before.configuration;
          incoming = hash(JSON.stringify([...session.clients.values()].flatMap(client => [...client.diagnostics].filter(([uri]) => client.documents.has(uri)))));
          retry = !verified; first = false;
        }
      } catch (error) {
        if (signal?.aborted) break;
        code = 1; retry = true;
        event = "error"; data = { ...failure(error, args.limit), verified: false, code: 2, retained: true, total: [...known.values()].reduce((count, issues) => count + issues.length, 0) };
      }
      if (signal?.aborted) break;
      if (data) {
        const encoded = JSON.stringify(data);
        if (encoded !== lastOutput) { await send(event, data); lastOutput = encoded; }
      }
      try { await sleep(retry ? 1000 : 500, undefined, { signal }); }
      catch (error) { if (!signal?.aborted) throw error; }
    }
    await send("closed", { success: code === 0, code, closed: true, total: [...known.values()].reduce((count, issues) => count + issues.length, 0) });
    return code;
  } finally { signal?.removeEventListener("abort", aborted); await close(); }
}
