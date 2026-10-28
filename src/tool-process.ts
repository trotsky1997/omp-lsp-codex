import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { ancestors, configPaths, gitRoot, inside, loadConfig, MAX_FILE_BYTES, object, readText, resolveCommand, type ObjectValue } from "./config.ts";
import { windowsCommand } from "./windows-command.ts";
import type { Options } from "./commands.ts";
import type { Diagnostic, Position } from "./omp/types.ts";

export type ToolName = "ruff" | "eslint" | "biome" | "prettier" | "rustfmt" | "clippy" | "oxlint" | "oxfmt";
export interface ToolProcessResult {
  tool: ToolName; command: string; configFiles: string[]; diagnostics: Diagnostic[]; original: string;
  updated?: string; verified: boolean; errors?: string[]; ignored?: boolean; cargo?: ObjectValue;
}
type Operation = "lint" | "fix" | "format";
interface Output { stdout: string; stderr: string; code: number; }
const INSTALL: Record<ToolName, string> = {
  ruff: "uv tool install ruff; https://docs.astral.sh/ruff/installation/",
  eslint: "npm install --save-dev eslint; https://eslint.org/docs/latest/use/getting-started",
  biome: "npm install --save-dev --save-exact @biomejs/biome; https://biomejs.dev/guides/getting-started/",
  prettier: "npm install --save-dev --save-exact prettier; https://prettier.io/docs/install",
  rustfmt: "rustup component add rustfmt; https://github.com/rust-lang/rustfmt",
  clippy: "rustup component add clippy; https://doc.rust-lang.org/clippy/installation.html",
  oxlint: "npm install --save-dev --save-exact oxlint; https://oxc.rs/docs/guide/usage/linter/quickstart",
  oxfmt: "npm install --save-dev --save-exact oxfmt; https://oxc.rs/docs/guide/usage/formatter/quickstart",
};
const CONFIGS: Record<ToolName, string[]> = {
  ruff: ["ruff.toml", ".ruff.toml", "pyproject.toml", ".gitignore", ".ignore"],
  eslint: ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts", "eslint.config.cts", ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yaml", ".eslintrc.yml", ".eslintignore", "package.json", "tsconfig.json"],
  biome: ["biome.json", "biome.jsonc", "package.json", ".editorconfig", ".gitignore", ".ignore"],
  prettier: [".prettierrc", ".prettierrc.json", ".prettierrc.json5", ".prettierrc.yaml", ".prettierrc.yml", ".prettierrc.toml", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs", ".prettierrc.ts", ".prettierrc.cts", ".prettierrc.mts", "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs", "prettier.config.ts", "prettier.config.cts", "prettier.config.mts", ".prettierignore", ".editorconfig", "package.json", ".gitignore"],
  rustfmt: ["rustfmt.toml", ".rustfmt.toml", "Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml", ".cargo/config", ".cargo/config.toml"],
  clippy: ["clippy.toml", ".clippy.toml", "Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml", ".cargo/config", ".cargo/config.toml"],
  oxlint: [".oxlintrc.json", ".oxlintrc.jsonc", "oxlint.config.ts", "oxlint.config.mts", "oxlint.config.cts", "oxlint.config.js", "oxlint.config.mjs", "oxlint.config.cjs", ".eslintignore", ".gitignore", "package.json", "tsconfig.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
  oxfmt: [".oxfmtrc.json", ".oxfmtrc.jsonc", "oxfmt.config.ts", "oxfmt.config.mts", "oxfmt.config.cts", "oxfmt.config.js", "oxfmt.config.mjs", "oxfmt.config.cjs", ".prettierignore", ".gitignore", ".editorconfig", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
};
function roots(file: string) {
  const root = gitRoot(dirname(file));
  return ancestors(dirname(file)).filter(path => inside(root, path));
}
export function toolConfigCandidates(tool: ToolName, file: string, globalConfigOnly = false): string[] {
  return [...new Set([...roots(file).flatMap(root => CONFIGS[tool].map(name => join(root, name))), ...(tool === "clippy" ? configPaths(dirname(file), globalConfigOnly) : [])])];
}
export function toolConfigFiles(tool: ToolName, file: string, globalConfigOnly = false): string[] {
  return [...new Set(toolConfigCandidates(tool, file, globalConfigOnly).filter(existsSync).map(path => realpathSync(path)))];
}
export function resolveToolCommand(tool: ToolName, file: string, globalOnly = false): string | undefined {
  const name = tool === "clippy" ? "cargo" : tool;
  if (!globalOnly) for (const root of roots(file)) for (const directory of ["node_modules/.bin", ".venv/bin", ".venv/Scripts", "venv/bin", "venv/Scripts", "bin"]) {
    const local = resolveCommand(join(root, directory, name), root);
    if (local) return local;
  }
  return resolveCommand(name, gitRoot(dirname(file)), globalOnly);
}
async function processOutput(command: string, argv: string[], cwd: string, input: string, deadline: number): Promise<Output> {
  if (Date.now() >= deadline) throw new Error("Tool deadline exceeded; narrow scope or increase --timeout");
  const invocation = process.platform === "win32" && /\.(cmd|bat)$/i.test(command) ? windowsCommand(command, argv) : { command, args: argv, windowsVerbatimArguments: false };
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", CARGO_TERM_COLOR: "never", GIT_OPTIONAL_LOCKS: "0", RUSTUP_AUTO_INSTALL: "0" };
  delete env.RUFF_OUTPUT_FILE;
  return new Promise((accept, reject) => {
    const child = spawn(invocation.command, invocation.args, { cwd, detached: process.platform !== "win32", windowsVerbatimArguments: invocation.windowsVerbatimArguments, stdio: ["pipe", "pipe", "pipe"], env });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    const timer = setTimeout(() => stop(new Error("Tool deadline exceeded; narrow scope or increase --timeout")), deadline - Date.now());
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]] as const) stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_FILE_BYTES) stop(new Error("Tool output exceeds 16 MiB; narrow scope")); else chunks.push(chunk);
    });
    child.on("error", error => { failure ??= error; });
    child.stdin.on("error", error => { if (object(error).code !== "EPIPE") stop(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code === null) return reject(new Error(`Tool terminated by ${signal ?? "unknown signal"}`));
      try {
        const decode = (chunks: Buffer[]) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
        accept({ stdout: decode(stdout), stderr: decode(stderr), code });
      } catch { reject(new Error("Tool returned invalid UTF-8")); }
    });
    child.stdin.end(input);
  });
}
function expected(result: Output, tool: ToolName, codes = [0]) {
  if (!codes.includes(result.code)) throw new Error(`${tool} exited ${result.code}: ${(result.stderr || result.stdout).slice(0, 1000)}; ${INSTALL[tool]}`);
}
function json(text: string) { try { return JSON.parse(text) as unknown; } catch { throw new Error("Tool returned malformed JSON"); } }
function integer(value: unknown, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) throw new Error("Tool returned invalid source coordinates");
  return value;
}
function offsetPosition(text: string, offset: number, bytes = false): Position {
  integer(offset);
  if (bytes) {
    const buffer = Buffer.from(text);
    if (offset > buffer.length) throw new Error("Tool byte offset is outside source");
    try { offset = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset)).length; }
    catch { throw new Error("Tool byte offset splits UTF-8"); }
  }
  if (offset > text.length || /[\udc00-\udfff]/.test(text[offset] ?? "")) throw new Error("Tool offset is outside source or splits UTF-16");
  const before = text.slice(0, offset), line = before.split("\n").length - 1;
  return { line, character: offset - (before.lastIndexOf("\n") + 1) };
}
function point(text: string, row: unknown, column: unknown, unicode = false): Position {
  const line = integer(row, 1) - 1, char = integer(column, 1) - 1, content = text.split("\n")[line]?.replace(/\r$/, "");
  if (content === undefined) throw new Error("Tool line is outside source");
  const character = unicode ? [...content].slice(0, char).join("").length : char;
  if ((unicode ? [...content].length : content.length) < char || /[\udc00-\udfff]/.test(content[character] ?? "")) throw new Error("Tool column is outside source or splits UTF-16");
  return { line, character };
}
interface Replacement { start: number; end: number; text: string; }
function pointOffset(text: string, position: Position) { return text.split("\n").slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + position.character; }
function replacements(text: string, groups: Replacement[][]) {
  const selected: Replacement[] = [];
  for (const group of groups) {
    for (const edit of group) { offsetPosition(text, edit.start); offsetPosition(text, edit.end); if (edit.start > edit.end || !edit.text.isWellFormed()) throw new Error("Tool returned an invalid fix"); }
    const edits = group.filter(edit => !selected.some(other => JSON.stringify(other) === JSON.stringify(edit)));
    const conflicts = (a: Replacement, b: Replacement) => Math.max(a.start, b.start) < Math.min(a.end, b.end) || a.start === b.start || a.start < b.start && b.start < a.end || b.start < a.start && a.start < b.end;
    if (edits.some((edit, index) => selected.some(other => conflicts(edit, other)) || edits.slice(0, index).some(other => conflicts(edit, other)))) continue;
    selected.push(...edits);
  }
  for (const edit of selected.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}
function diagnostic(tool: ToolName, message: unknown, start: Position, end = start, code?: unknown, severity: 1 | 2 | 3 | 4 = 1): Diagnostic {
  if (typeof message !== "string" || !message.trim() || start.line > end.line || start.line === end.line && start.character > end.character) throw new Error("Tool returned invalid diagnostics");
  return { source: tool, message, range: { start, end }, severity, ...(typeof code === "string" || typeof code === "number" ? { code } : {}) };
}
const cargoReports = new WeakMap<Map<string, Promise<ToolProcessResult>>, Map<string, Promise<Output>>>();

function cargoTargets(pkg: ObjectValue, file: string) {
  if (!Array.isArray(pkg.targets)) throw new Error("Cargo returned malformed target metadata");
  const targets = pkg.targets.map(object);
  if (targets.some(target => typeof target.src_path !== "string" || typeof target.name !== "string" || !Array.isArray(target.kind) || !target.kind.every(kind => typeof kind === "string"))) throw new Error("Cargo returned malformed target metadata");
  const exact = targets.filter(target => resolve(String(target.src_path)) === file);
  const parents = targets.filter(target => inside(dirname(String(target.src_path)), file));
  const depth = Math.max(0, ...parents.map(target => dirname(String(target.src_path)).length));
  const selected = exact.length ? exact : parents.filter(target => dirname(String(target.src_path)).length === depth);
  if (!selected.length) throw new Error("Source is outside Cargo target directories; select a target source or use --server rust-analyzer for path-based modules");
  const flags: string[] = [];
  for (const target of selected) {
    const kinds = target.kind as string[];
    if (kinds.some(kind => ["lib", "rlib", "dylib", "cdylib", "staticlib", "proc-macro"].includes(kind))) flags.push("--lib");
    else if (kinds[0] === "custom-build") continue;
    else if (["bin", "test", "example", "bench"].includes(kinds[0])) flags.push(`--${kinds[0]}`, String(target.name));
    else throw new Error(`Unsupported Cargo target kind: ${kinds.join(", ")}`);
  }
  return { flags, inputs: selected.map(target => String(target.src_path)), targets: selected.map(target => ({ name: target.name, kind: target.kind })) };
}

function cargoSourceInput(records: ObjectValue[], pkg: ObjectValue, root: string, targetDirectory: unknown, file: string) {
  if (typeof targetDirectory !== "string" || !isAbsolute(targetDirectory)) return false;
  let bytes = 0;
  for (const record of records) {
    if (record.reason !== "compiler-artifact" || record.package_id !== pkg.id || !Array.isArray(record.filenames)) continue;
    for (const filename of record.filenames) {
      if (typeof filename !== "string" || !isAbsolute(filename) || !inside(targetDirectory, filename)) continue;
      const stem = basename(filename, extname(filename));
      for (const name of new Set([stem, stem.replace(/^lib(?=.+)/, "")])) {
        const path = join(dirname(filename), `${name}.d`);
        if (!existsSync(path)) continue;
        const text = readText(path); bytes += Buffer.byteLength(text);
        if (bytes > MAX_FILE_BYTES) throw new Error("Cargo dependency input scope exceeds 16 MiB; narrow the target scope");
        // rustc emits empty Makefile rules for source inputs, including cfg-gated modules.
        for (const line of text.split(/\r?\n/)) if (line.endsWith(":")) {
          const input = line.slice(0, -1).replace(/\\([ \t#:\\])/g, "$1").replace(/\$\$/g, "$");
          if (resolve(root, input) === file) return true;
        }
      }
    }
  }
  return false;
}

export async function runToolProcess(args: Options, file: string, tool: ToolName, operation: Operation, cache?: Map<string, Promise<ToolProcessResult>>): Promise<ToolProcessResult> {
  const command = resolveToolCommand(tool, file, args.globalBinsOnly);
  if (!command) throw new Error(`${tool} is unavailable. Install: ${INSTALL[tool]}`);
  if (operation === "format" ? ["eslint", "clippy", "oxlint"].includes(tool) : ["prettier", "rustfmt", "oxfmt"].includes(tool)) throw new Error(`${tool} does not support ${operation}; select a matching --tool`);
  const original = readText(file), configFiles = toolConfigFiles(tool, file, args.globalConfigOnly), configSnapshots = new Map<string, string>(), deadline = Date.now() + args.timeout, cwd = tool === "oxlint" || tool === "oxfmt" ? gitRoot(dirname(file)) : dirname(file);
  let configBytes = 0;
  for (const path of configFiles) { const text = readText(path); configBytes += Buffer.byteLength(text); if (configBytes > MAX_FILE_BYTES) throw new Error("Tool configuration exceeds 16 MiB; narrow scope"); configSnapshots.set(path, text); }
  const run = (argv: string[], input = original, executable = command, directory = cwd) => processOutput(executable, argv, directory, input, deadline);
  const cachedCargo = (executable: string, argv: string[], directory: string) => {
    if (!cache) return run(argv, "", executable, directory);
    let reports = cargoReports.get(cache); if (!reports) { reports = new Map(); cargoReports.set(cache, reports); }
    const key = JSON.stringify([executable, argv, directory]);
    if (!reports.has(key)) reports.set(key, run(argv, "", executable, directory));
    return reports.get(key)!;
  };
  const metadata = async (cargo: string, manifest: string) => {
    const output = await cachedCargo(cargo, ["metadata", "--no-deps", "--offline", "--locked", "--format-version", "1", "--manifest-path", manifest], dirname(manifest)); expected(output, "clippy");
    const value = object(json(output.stdout));
    if (!Array.isArray(value.packages) || typeof value.workspace_root !== "string") throw new Error("Cargo returned malformed package metadata");
    return { packages: value.packages.map(object), root: realpathSync(value.workspace_root), targetDirectory: value.target_directory };
  };
  let diagnostics: Diagnostic[] = [], updated: string | undefined, ignored = false, verified = true, errors: string[] | undefined, cargo: ObjectValue | undefined;
  if (tool === "ruff") {
    if (operation === "format") {
      const inventory = await run(["format", "--no-cache", "--check", "--force-exclude", file], ""); expected(inventory, tool, [0, 1]);
      ignored = inventory.code === 0 && inventory.stdout === "";
      if (inventory.code === 1 && !inventory.stdout) throw new Error("Ruff returned an incomplete formatting check");
      if (!ignored) { const output = await run(["format", "--no-cache", "--force-exclude", "--stdin-filename", file, "-"]); expected(output, tool); updated = output.stdout; }
    } else {
      const output = await run(["check", "--no-fix", "--no-fix-only", "--no-cache", "--force-exclude", "--output-format=json", "--verbose", file], ""); expected(output, tool, [0, 1]);
      const report = json(output.stdout); if (!Array.isArray(report) || output.code === 1 && !report.length) throw new Error("Ruff returned an incomplete diagnostic report");
      // shortcut: Ruff exposes lint.exclude skip counts only in verbose output; replace when it adds a structured processed-file count.
      const checked = [...output.stderr.matchAll(/\bChecked (\d+) files in:/g)].at(-1)?.[1] ?? (output.stderr.includes("No Python files found under the given path(s)") ? "0" : undefined);
      if (checked !== "0" && checked !== "1" || checked === "0" && report.length) throw new Error("Ruff returned an incomplete processed-file count; use a supported Ruff CLI");
      ignored = checked === "0";
      const fixes: Replacement[][] = [];
      for (const value of report) {
        const item = object(value), start = object(item.location), end = object(item.end_location ?? item.location);
        if (typeof item.filename !== "string" || resolve(item.filename) !== file) throw new Error("Ruff returned diagnostics for another file");
        diagnostics.push(diagnostic(tool, item.message, point(original, start.row, start.column, true), point(original, end.row, end.column, true), item.code, item.severity === "warning" ? 2 : 1));
        const fix = object(item.fix);
        if (operation === "fix" && fix.applicability === "safe") {
          if (!Array.isArray(fix.edits)) throw new Error("Ruff returned malformed safe fixes");
          fixes.push(fix.edits.map(value => { const edit = object(value), from = object(edit.location), to = object(edit.end_location); if (typeof edit.content !== "string") throw new Error("Ruff returned malformed fix content"); return { start: pointOffset(original, point(original, from.row, from.column, true)), end: pointOffset(original, point(original, to.row, to.column, true)), text: edit.content }; }));
        }
      }
      if (operation === "fix" && !ignored) updated = replacements(original, fixes);
    }
  } else if (tool === "oxlint") {
    const output = await run(["--no-error-on-unmatched-pattern", "--format", "json", file], ""); expected(output, tool, [0, 1]);
    let report: ObjectValue;
    try { report = object(json(output.stdout)); }
    catch { throw new Error(`Oxlint returned no valid JSON report: ${(output.stderr || output.stdout || "empty output").slice(0, 1000)}`); }
    const count = report.number_of_files;
    if (!Array.isArray(report.diagnostics) || count !== 0 && count !== 1 || count === 0 && (report.diagnostics.length > 0 || output.code !== 0)) throw new Error("Oxlint returned an incomplete file/diagnostic report");
    ignored = count === 0;
    for (const raw of report.diagnostics) {
      const item = object(raw), labels = Array.isArray(item.labels) ? item.labels : [], span = object(object(labels[0]).span);
      if (typeof item.filename !== "string" || resolve(cwd, item.filename) !== file) throw new Error(`Oxlint returned a diagnostic outside the selected source: ${String(item.message ?? item.filename)}`);
      if (!["error", "warning", "advice"].includes(String(item.severity))) throw new Error("Oxlint returned an invalid diagnostic severity");
      const start = integer(span.offset), end = start + integer(span.length);
      diagnostics.push(diagnostic(tool, item.message, offsetPosition(original, start, true), offsetPosition(original, end, true), item.code, item.severity === "warning" ? 2 : item.severity === "advice" ? 3 : 1));
    }
    if (output.code === 1 && !diagnostics.some(item => item.severity === 1)) throw new Error("Oxlint failed without a complete error report");
  } else if (tool === "oxfmt") {
    const inventory = await run(["--no-error-on-unmatched-pattern", "--check", file], ""); expected(inventory, tool, [0, 1]);
    const count = [...inventory.stdout.matchAll(/\bFinished in [^\r\n]* on (\d+) files? using \d+ threads?\b/g)].at(-1)?.[1];
    if (count !== "0" && count !== "1" || count === "0" && inventory.code !== 0) throw new Error(`Oxfmt returned an incomplete processed-file count: ${(inventory.stderr || inventory.stdout || "empty output; use a supported Oxfmt CLI").slice(0, 1000)}`);
    ignored = count === "0";
    if (!ignored) { const output = await run(["--stdin-filepath", file]); expected(output, tool); updated = output.stdout; }
  } else if (tool === "eslint") {
    const output = await run(["--stdin", "--stdin-filename", file, "--format", "json"]); expected(output, tool, [0, 1]);
    const report = json(output.stdout);
    if (!Array.isArray(report) || report.length !== 1) throw new Error("ESLint returned an incomplete diagnostic report");
    const item = object(report[0]); if (typeof item.filePath !== "string" || resolve(item.filePath) !== file || !Array.isArray(item.messages)) throw new Error("ESLint returned malformed diagnostics");
    for (const value of item.messages) {
      const message = object(value);
      if (typeof message.message === "string" && /\bFile ignored\b/i.test(message.message) && message.line === undefined) { ignored = true; continue; }
      if (message.severity !== 1 && message.severity !== 2) throw new Error("ESLint returned an invalid diagnostic severity");
      const start = point(original, message.line, message.column), end = message.endLine === undefined ? start : point(original, message.endLine, message.endColumn);
      diagnostics.push(diagnostic(tool, message.message, start, end, message.ruleId, message.severity === 2 ? 1 : 2));
    }
    if (operation === "fix" && !ignored) {
      const fixed = await run(["--stdin", "--stdin-filename", file, "--format", "json", "--fix-dry-run"]); expected(fixed, tool, [0, 1]);
      const result = json(fixed.stdout); if (!Array.isArray(result) || result.length !== 1 || object(result[0]).filePath !== item.filePath) throw new Error("ESLint returned malformed fix output");
      const value = object(result[0]).output; if (value !== undefined && typeof value !== "string") throw new Error("ESLint returned malformed fixed source");
      updated = typeof value === "string" ? value : original;
    }
  } else if (tool === "biome") {
    // Real-file preflight preserves ignore rules; Biome's stdin path bypasses them.
    const output = await run([operation === "format" ? "format" : "lint", "--reporter=json", "--max-diagnostics=none", "--no-errors-on-unmatched", file], ""); expected(output, tool, [0, 1]);
    const report = object(json(output.stdout)), summary = object(report.summary);
    if (!Array.isArray(report.diagnostics) || summary.diagnosticsNotPrinted !== 0) throw new Error("Biome returned an incomplete diagnostic report");
    ignored = integer(summary.unchanged) + integer(summary.changed) === 0 && !report.diagnostics.length;
    if (typeof summary.errors === "number" && summary.errors > report.diagnostics.length || typeof summary.warnings === "number" && summary.warnings > report.diagnostics.length) throw new Error("Biome returned an incomplete diagnostic report");
    for (const value of report.diagnostics) {
      const item = object(value), location = object(item.location);
      if (operation === "format" && item.category === "format") continue;
      const path = typeof location.path === "string" ? location.path : object(location.path).file;
      if (typeof path !== "string" || resolve(cwd, path) !== file) throw new Error(`Biome returned a diagnostic outside the selected source: ${String(item.message ?? item.description ?? path)}`);
      const start = object(location.start), end = object(location.end), span = location.span;
      let from: Position, to: Position;
      if (Array.isArray(span) && span.length === 2) { from = offsetPosition(original, integer(span[0]), true); to = offsetPosition(original, integer(span[1]), true); }
      else { from = point(original, start.line, start.column, true); to = point(original, end.line, end.column, true); }
      diagnostics.push(diagnostic(tool, item.message ?? item.description, from, to, item.category, item.severity === "warning" ? 2 : item.severity === "information" ? 3 : 1));
    }
    if (output.code === 1 && !report.diagnostics.length && !ignored) throw new Error(`Biome did not complete: ${output.stderr.slice(0, 1000)}`);
    if (operation === "format" && diagnostics.some(item => item.severity === 1)) { verified = false; errors = ["Biome formatting did not complete; resolve the reported parse or tool errors and retry"]; }
    if (operation !== "lint" && !ignored && verified) {
      const formatted = await run(operation === "format" ? ["format", `--stdin-file-path=${file}`] : ["lint", `--stdin-file-path=${file}`, "--write"]); expected(formatted, tool, operation === "fix" ? [0, 1] : [0]);
      if (formatted.code !== 0 && !formatted.stdout && original) throw new Error(`Biome did not return fixed source: ${formatted.stderr.slice(0, 1000)}`);
      updated = formatted.stdout;
    }
  } else if (tool === "prettier") {
    const ignores = roots(file).reverse().flatMap(root => [join(root, ".gitignore"), join(root, ".prettierignore")]).filter(existsSync);
    const flags = ignores.flatMap(path => ["--ignore-path", path]);
    const info = await run([...flags, "--file-info", file], ""); expected(info, tool);
    const metadata = object(json(info.stdout)); if (typeof metadata.ignored !== "boolean") throw new Error("Prettier returned an invalid file inventory");
    ignored = metadata.ignored;
    if (!ignored) { const output = await run([...flags, "--stdin-filepath", file]); expected(output, tool); updated = output.stdout; }
  } else if (tool === "rustfmt") {
    const manifest = roots(file).map(root => join(root, "Cargo.toml")).find(existsSync);
    let edition = "2015";
    if (manifest) {
      const cargo = resolveToolCommand("clippy", file, args.globalBinsOnly);
      if (!cargo) throw new Error(`cargo is required to resolve the Rust edition. Install: ${INSTALL.rustfmt}`);
      const pkg = (await metadata(cargo, manifest)).packages.find(pkg => pkg.manifest_path === manifest);
      if (!pkg || typeof pkg.edition !== "string" || !/^(2015|2018|2021|2024)$/.test(pkg.edition)) throw new Error("Cargo could not resolve this file's edition");
      edition = pkg.edition;
    }
    const config = roots(file).flatMap(root => [join(root, ".rustfmt.toml"), join(root, "rustfmt.toml")]).find(existsSync);
    const output = await run(["--emit", "stdout", "--edition", edition, ...(config ? ["--config-path", config] : [])]); expected(output, tool); updated = output.stdout;
  } else {
    const manifest = roots(file).map(root => join(root, "Cargo.toml")).find(existsSync);
    if (!manifest) throw new Error("Clippy requires a Cargo.toml project; select a Rust crate");
    const project = await metadata(command, manifest);
    const pkg = project.packages.find(pkg => pkg.manifest_path === manifest);
    if (!pkg) throw new Error("Cargo could not resolve this file's package");
    const selection = cargoTargets(pkg, file);
    const settings = object(loadConfig(cwd, args.globalConfigOnly)["rust-analyzer"]?.settings), build = object(object(settings["rust-analyzer"]).cargo);
    const features = settings["rust-analyzer.cargo.features"] ?? build.features ?? [], noDefaultFeatures = settings["rust-analyzer.cargo.noDefaultFeatures"] ?? build.noDefaultFeatures ?? false;
    if (features !== "all" && (!Array.isArray(features) || features.some(feature => typeof feature !== "string" || !feature || /[\s,\0]/.test(feature))) || typeof noDefaultFeatures !== "boolean") throw new Error("Invalid rust-analyzer Cargo features/noDefaultFeatures; use a feature-name array or features: \"all\", and a boolean noDefaultFeatures");
    const featureArgs = features === "all" ? ["--all-features"] : features.length ? ["--features", features.join(",")] : [];
    const flags = ["clippy", "--offline", "--locked", ...selection.flags, ...featureArgs, ...(noDefaultFeatures ? ["--no-default-features"] : []), "--message-format=json", "--manifest-path", manifest];
    cargo = { targets: selection.targets, features, noDefaultFeatures };
    const output = await cachedCargo(command, flags, project.root);
    expected(output, tool, [0, 101]);
    const records = output.stdout.split(/\r?\n/).filter(Boolean).map(line => object(json(line))), finishes = records.filter(item => item.reason === "build-finished");
    if (finishes.length !== 1 || typeof finishes[0].success !== "boolean") throw new Error(`Clippy returned an incomplete Cargo report: ${output.stderr.slice(-500)}; Install: ${INSTALL.clippy}`);
    // Cargo marks denied Clippy lints as a failed build after semantic analysis completes.
    const compilerErrors = records.filter(record => record.reason === "compiler-message" && !["warning", "note", "help"].includes(String(object(record.message).level)));
    const lintPackages = new Set(project.packages.filter(pkg => typeof pkg.id === "string" && typeof pkg.name === "string" && compilerErrors.some(record => record.package_id === pkg.id)).map(pkg => pkg.name));
    const stderrErrors = output.stderr.split(/\r?\n/).map(line => line.trim()).filter(line => /^error(?:\[[^\]]+\])?:/.test(line));
    const knownLintSummaries = stderrErrors.every(line => {
      const summary = /^error: could not compile `([^`]+)`(?: \([^\r\n]*\))? due to \d+ previous errors?(?:; \d+ warnings? emitted)?$/.exec(line);
      return summary !== null && lintPackages.has(summary[1]);
    });
    const deniedLints = output.code === 101 && finishes[0].success === false && compilerErrors.length > 0 && knownLintSummaries && compilerErrors.every(record => {
      const item = object(record.message), code = object(item.code).code;
      return item.level === "error" && typeof code === "string" && /^clippy::[a-z_][a-z_0-9]*$/.test(code) && typeof record.package_id === "string" && project.packages.some(pkg => pkg.id === record.package_id);
    });
    if (!(output.code === 0 && finishes[0].success === true && !compilerErrors.length) && !deniedLints) { verified = false; errors = [`Clippy did not complete; resolve the build error and retry: ${output.stderr.slice(-1000)}`]; }
    const fixes: Replacement[][] = [];
    const sourcePath = (value: unknown) => typeof value === "string" ? resolve(project.root, value) : "";
    const suggestions = (value: ObjectValue) => {
      const spans = Array.isArray(value.spans) ? value.spans.map(object).filter(span => span.suggested_replacement !== null && span.suggested_replacement !== undefined) : [];
      if (spans.length && spans.every(span => span.suggestion_applicability === "MachineApplicable" && sourcePath(span.file_name) === file)) fixes.push(spans.map(span => ({ start: pointOffset(original, offsetPosition(original, integer(span.byte_start), true)), end: pointOffset(original, offsetPosition(original, integer(span.byte_end), true)), text: typeof span.suggested_replacement === "string" ? span.suggested_replacement : (() => { throw new Error("Clippy returned malformed suggestions"); })() })));
      if (Array.isArray(value.children)) value.children.map(object).forEach(suggestions);
    };
    for (const record of records) if (record.reason === "compiler-message") {
      const item = object(record.message), spans = Array.isArray(item.spans) ? item.spans.map(object) : [], span = spans.find(span => span.is_primary === true && sourcePath(span.file_name) === file);
      if (!span) continue;
      diagnostics.push(diagnostic(tool, item.message, offsetPosition(original, integer(span.byte_start), true), offsetPosition(original, integer(span.byte_end), true), object(item.code).code, item.level === "warning" ? 2 : item.level === "note" ? 3 : 1));
      if (operation === "fix") suggestions(item);
    }
    if (verified) {
      const sourceInput = selection.inputs.includes(file) ? "cargo-target" : diagnostics.length ? "compiler-diagnostic" : cargoSourceInput(records, pkg, project.root, project.targetDirectory, file) ? "dep-info" : "unconfirmed";
      cargo.sourceInput = sourceInput;
      if (sourceInput === "unconfirmed") { verified = false; errors = ["Selected source is absent from Cargo's dependency inputs. Declare its module or select the owning target/features; use --server rust-analyzer for out-of-tree modules"]; }
    }
    if (operation === "fix" && verified) updated = replacements(original, fixes);
  }
  if (readText(file) !== original) throw new Error(`Source changed during ${tool} analysis: ${file}`);
  if (configFiles.some(path => readText(path) !== configSnapshots.get(path)) || JSON.stringify(toolConfigFiles(tool, file, args.globalConfigOnly)) !== JSON.stringify(configFiles)) throw new Error(`Project configuration changed during ${tool} analysis; retry`);
  if (updated !== undefined && (Buffer.byteLength(updated) > MAX_FILE_BYTES || !updated.isWellFormed())) throw new Error("Tool returned oversized or invalid source");
  diagnostics = [...new Map(diagnostics.map(item => [JSON.stringify(item), item])).values()];
  return { tool, command, configFiles, diagnostics, original, ...(updated !== undefined ? { updated } : {}), verified, ...(errors ? { errors } : {}), ...(ignored ? { ignored } : {}), ...(cargo ? { cargo } : {}) };
}
