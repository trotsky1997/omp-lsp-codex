import { existsSync } from "node:fs";
import { isAbsolute, resolve, extname } from "node:path";
import { createHash } from "node:crypto";
import { atomicWrite } from "./edits.ts";
import { inside, MAX_FILE_BYTES, object, readText, type ObjectValue, type Server } from "./config.ts";
import { validRange } from "./semantic.ts";
import { compactText } from "./output.ts";
import type { Diagnostic } from "./omp/types.ts";

export interface DiagnosticRecord { file: string; diagnostics: Diagnostic[]; verified: boolean; errors: string[]; }
interface BaselineIssue { diagnostic: Diagnostic; anchor: string; }
export interface Baseline {
  schema: 1;
  root: string;
  servers: string[];
  files: { file: string; issues: BaselineIssue[] }[];
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function serverFingerprint(server: Server) { return hash(JSON.stringify(server)); }
export function loadBaseline(path: string): Baseline {
  const value = object(JSON.parse(readText(path)));
  if (value.schema !== 1 || typeof value.root !== "string" || !isAbsolute(value.root) ||
      !Array.isArray(value.servers) || !value.servers.every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v)) || !Array.isArray(value.files))
    throw new Error("Invalid diagnostics baseline; capture one with diagnostics --file PATH --save-baseline before.json");
  const seen = new Set<string>();
  for (const raw of value.files) {
    const file = object(raw);
    if (typeof file.file !== "string" || !isAbsolute(file.file) || !inside(value.root, file.file) || seen.has(file.file) || !Array.isArray(file.issues)) throw new Error("Invalid baseline file scope");
    seen.add(file.file);
    for (const rawIssue of file.issues) {
      const issue = object(rawIssue), diagnostic = object(issue.diagnostic);
      if (typeof issue.anchor !== "string" || !/^[a-f0-9]{64}$/.test(issue.anchor) || !validRange(diagnostic.range) || typeof diagnostic.message !== "string" ||
          diagnostic.severity !== undefined && (![1, 2, 3, 4].includes(Number(diagnostic.severity)) || typeof diagnostic.severity !== "number")) throw new Error("Invalid baseline diagnostic");
    }
  }
  return value as unknown as Baseline;
}
export function captureBaseline(records: DiagnosticRecord[], root: string, servers: string[], expected?: ReadonlyMap<string, string>): Baseline {
  if (records.some(record => !record.verified || record.errors.length)) throw new Error("Cannot save an unverified diagnostics baseline");
  return { schema: 1, root, servers: [...new Set(servers)].sort(), files: records.map(record => {
    const text = readText(record.file), lines = text.split("\n");
    if (expected?.has(record.file) && expected.get(record.file) !== text) throw new Error("Source changed while capturing diagnostics baseline; retry");
    return { file: record.file, issues: record.diagnostics.map(diagnostic => {
      if (!validRange(diagnostic.range) || [diagnostic.range.start, diagnostic.range.end].some(point => lines[point.line] === undefined || point.character > lines[point.line].length || lines[point.line].charCodeAt(point.character) >= 0xdc00 && lines[point.line].charCodeAt(point.character) <= 0xdfff)) throw new Error("Diagnostic range is outside the baseline source");
      return { diagnostic, anchor: hash(lines[diagnostic.range.start.line].trim()) };
    }) };
  }) };
}
export function saveBaseline(path: string, baseline: Baseline) {
  if (extname(path).toLowerCase() !== ".json") throw new Error("--save-baseline requires a .json artifact path");
  const target = resolve(path);
  if (baseline.files.some(file => resolve(file.file) === target)) throw new Error("Baseline output cannot overwrite analyzed source");
  if (existsSync(target)) loadBaseline(target);
  const bytes = Buffer.from(JSON.stringify(baseline, null, 2) + "\n");
  if (bytes.length > MAX_FILE_BYTES) throw new Error("Baseline exceeds 16 MiB; narrow the diagnostic file scope");
  atomicWrite(target, bytes);
}
export function compareBaseline(before: Baseline, current: Baseline | undefined, files: string[], servers: string[], limit: number): ObjectValue {
  const selected = new Set(files), known = new Set(before.files.map(file => file.file));
  const unbaselinedFiles = files.filter(file => !known.has(file));
  const compatible = [...new Set(servers)].sort().join() === before.servers.join();
  if (!current || unbaselinedFiles.length || !compatible) return { verified: false, unbaselinedFiles, configurationMatches: compatible,
    hint: "Baseline comparison unverified: current diagnostics, file scope or server configuration differ. Capture a complete baseline for the selected files before editing; no resolved issues are claimed." };
  const key = (file: string, issue: BaselineIssue) => JSON.stringify([file, issue.anchor, issue.diagnostic.severity ?? 1, issue.diagnostic.code, issue.diagnostic.source, issue.diagnostic.message]);
  const previous = new Map<string, { file: string; issue: BaselineIssue }[]>();
  for (const file of before.files.filter(file => selected.has(file.file))) for (const issue of file.issues) {
    const id = key(file.file, issue); if (!previous.has(id)) previous.set(id, []); previous.get(id)!.push({ file: file.file, issue });
  }
  const describe = (file: string, issue: BaselineIssue) => ({ file, line: issue.diagnostic.range.start.line + 1, column: issue.diagnostic.range.start.character + 1,
    severity: issue.diagnostic.severity ?? 1, code: issue.diagnostic.code, source: issue.diagnostic.source, message: issue.diagnostic.message });
  const added: ObjectValue[] = [], existing: ObjectValue[] = [];
  for (const file of current.files) for (const issue of file.issues) {
    const old = previous.get(key(file.file, issue))?.shift();
    if (old) existing.push({ ...describe(file.file, issue), previousLine: old.issue.diagnostic.range.start.line + 1 });
    else added.push(describe(file.file, issue));
  }
  const resolved = [...previous.values()].flat().map(entry => describe(entry.file, entry.issue));
  const preview = (values: ObjectValue[]) => {
    const { items, ...meta } = compactText(limit ? values.slice(0, limit) : values, ["message"], limit);
    return { total: values.length, shown: items.length, truncated: items.length < values.length || !!meta.truncated, ...meta, issues: items };
  };
  return { verified: true, matching: "file, trimmed source line, severity, code, source and message (multiset)",
    counts: { new: added.length, resolved: resolved.length, existing: existing.length }, newErrors: added.filter(issue => issue.severity === 1).length,
    new: preview(added), resolved: preview(resolved), existing: preview(existing) };
}
