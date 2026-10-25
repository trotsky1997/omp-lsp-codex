import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import defaults from "./defaults.json";

export type ObjectValue = Record<string, unknown>;
export function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
}

export interface ServerConfig {
  command: string;
  args?: string[];
  fileTypes?: string[];
  rootMarkers?: string[];
  languageId?: string;
  disabled?: boolean;
  isLinter?: boolean;
  warmupTimeoutMs?: number;
  initOptions?: ObjectValue;
  settings?: ObjectValue;
  setup?: { install?: string | string[] | Record<string, string | string[]>; docs?: string };
}
export interface Server extends ServerConfig {
  name: string;
  root: string;
  resolvedCommand: string;
}
export const MAX_FILES = 200;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const LANGUAGES: Record<string, string> = {
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".go": "go",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".hs": "haskell",
  ".html": "html",
  ".java": "java",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".json": "json",
  ".jsonc": "jsonc",
  ".kt": "kotlin",
  ".lua": "lua",
  ".md": "markdown",
  ".ml": "ocaml",
  ".mli": "ocaml.interface",
  ".nix": "nix",
  ".php": "php",
  ".py": "python",
  ".pyi": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".scala": "scala",
  ".scss": "scss",
  ".sh": "shellscript",
  ".sql": "sql",
  ".swift": "swift",
  ".tla": "tlaplus",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".vue": "vue",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".zig": "zig",
};

export function expandHome(path: string): string {
  return path === "~" ? homedir() : /^[~][\\/]/.test(path) ? join(homedir(), path.slice(2)) : path;
}
export function ancestors(cwd: string): string[] {
  const paths = [resolve(cwd)];
  while (dirname(paths.at(-1)!) !== paths.at(-1)) paths.push(dirname(paths.at(-1)!));
  return paths;
}
export function gitRoot(cwd: string): string {
  return ancestors(cwd).find((path) => existsSync(join(path, ".git"))) ?? cwd;
}
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export function configPaths(cwd: string): string[] {
  const roots = ancestors(cwd);
  const root = roots.find((path) => existsSync(join(path, ".git"))) ??
    roots.find((path) => path !== homedir() && existsSync(join(path, ".codex/lsp.json"))) ?? cwd;
  return [join(homedir(), ".codex/lsp.json"), join(root, ".codex/lsp.json")];
}
export function readOverrides(path: string): Record<string, ServerConfig> {
  if (!existsSync(path)) return {};
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`Cannot read LSP configuration ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    throw new Error(`LSP config must contain an object: ${path}`);
  const entries = "servers" in doc ? doc.servers : doc;
  if (!entries || typeof entries !== "object" || Array.isArray(entries))
    throw new Error(`The servers field must contain an object: ${path}`);
  for (const [name, value] of Object.entries(entries)) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`Invalid LSP server ${name} in ${path}`);
  }
  return entries as Record<string, ServerConfig>;
}
export function loadConfig(cwd: string, builtinsOnly = false): Record<string, ServerConfig> {
  const configs: Record<string, ServerConfig> = Object.assign(Object.create(null), structuredClone(defaults));
  if (!builtinsOnly)
    for (const path of configPaths(cwd)) {
      for (const [name, override] of Object.entries(readOverrides(path)))
        configs[name] = { ...configs[name], ...override };
    }
  for (const [name, config] of Object.entries(configs)) {
    if (typeof config.command !== "string" || !config.command.trim())
      throw new Error(`LSP server ${name} needs a command`);
    for (const field of ["args", "fileTypes", "rootMarkers"] as const) {
      const value = config[field];
      if (
        value !== undefined &&
        (!Array.isArray(value) || value.some((x) => typeof x !== "string"))
      )
        throw new Error(`Invalid ${name}.${field}`);
    }
    for (const field of ["settings", "initOptions"] as const) {
      const value = config[field];
      if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value)))
        throw new Error(`Invalid ${name}.${field}`);
    }
    for (const field of ["disabled", "isLinter"] as const)
      if (config[field] !== undefined && typeof config[field] !== "boolean")
        throw new Error(`Invalid ${name}.${field}: expected a boolean`);
    if (config.languageId !== undefined && (typeof config.languageId !== "string" || !config.languageId.trim()))
      throw new Error(`Invalid ${name}.languageId`);
    if (config.warmupTimeoutMs !== undefined &&
        (!Number.isInteger(config.warmupTimeoutMs) || config.warmupTimeoutMs < 1 || config.warmupTimeoutMs > 2147483647))
      throw new Error(`Invalid ${name}.warmupTimeoutMs: expected 1–2147483647 milliseconds`);
    if (config.setup !== undefined) {
      const guide = object(config.setup), install = guide.install;
      const commands = (value: unknown) => typeof value === "string" ||
        (Array.isArray(value) && value.every((item) => typeof item === "string"));
      if (!config.setup || typeof config.setup !== "object" || Array.isArray(config.setup) ||
          (guide.docs !== undefined && typeof guide.docs !== "string") ||
          (install !== undefined && !commands(install) &&
            (!install || typeof install !== "object" || Array.isArray(install) || !Object.values(install).every(commands))))
        throw new Error(`Invalid ${name}.setup`);
    }
    if (name === "typescript-language-server") {
      config.initOptions ??= {};
      if (
        config.initOptions.tsserver !== undefined &&
        (typeof config.initOptions.tsserver !== "object" ||
          !config.initOptions.tsserver ||
          Array.isArray(config.initOptions.tsserver))
      )
        throw new Error("initOptions.tsserver must be an object");
      config.initOptions.tsserver = {
        useSyntaxServer: "never",
        ...object(config.initOptions.tsserver),
      };
    }
  }
  return configs;
}
export function serverRoot(cwd: string, markers: string[] = []): string | undefined {
  return ancestors(cwd).find((root) =>
    markers.some((marker) => {
      try {
        return /[*?\[]/.test(marker)
          ? readdirSync(root).some((name) => new Bun.Glob(marker).match(name))
          : existsSync(join(root, marker));
      } catch {
        return false;
      }
    }),
  );
}
export function executable(path: string): boolean {
  try {
    return (
      statSync(path).isFile() &&
      (accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK), true)
    );
  } catch {
    return false;
  }
}
export function resolveCommand(
  command: string,
  root: string,
  globalOnly = false,
): string | undefined {
  const value = expandHome(command);
  const names =
    process.platform === "win32" && !extname(value)
      ? [value, `${value}.exe`, `${value}.cmd`, `${value}.bat`]
      : [value];
  if (isAbsolute(value) || /[\\/]/.test(value)) {
    return names.map((name) => resolve(root, name)).find(executable);
  }
  if (!globalOnly)
    for (const directory of [
      "node_modules/.bin",
      ".venv/bin",
      ".venv/Scripts",
      "venv/bin",
      "venv/Scripts",
      "bin",
    ]) {
      const local = names.map((name) => join(root, directory, name)).find(executable);
      if (local) return local;
    }
  const found = Bun.which(command) ?? undefined;
  if (globalOnly && found && inside(realpathSync(root), realpathSync(found))) return undefined;
  return found;
}
export function availableServers(
  configs: Record<string, ServerConfig>,
  cwd: string,
  globalOnly = false,
): Server[] {
  const servers: Server[] = [];
  for (const [name, raw] of Object.entries(configs)) {
    if (raw.disabled) continue;
    const root = serverRoot(cwd, raw.rootMarkers);
    if (!root) continue;
    const resolvedCommand = resolveCommand(raw.command, root, globalOnly);
    if (!resolvedCommand) continue;
    const server: Server = { ...raw, name, root, resolvedCommand };
    if (["pyright", "basedpyright"].includes(name)) {
      const python = raw.settings?.python;
      if (python !== undefined && (!python || typeof python !== "object" || Array.isArray(python)))
        throw new Error(`${name} settings.python must be an object`);
      if (!object(python).pythonPath)
        for (const env of [".venv", "venv"]) {
          const interpreter = join(
            root,
            env,
            process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
          );
          if (executable(interpreter)) {
            server.settings = {
              ...raw.settings,
              python: { ...object(python), pythonPath: interpreter },
            };
            break;
          }
        }
    }
    servers.push(server);
  }
  return servers;
}
export function matchesFile(config: ServerConfig, path: string): boolean {
  return (config.fileTypes ?? []).some((type) =>
    [basename(path).toLowerCase(), extname(path).toLowerCase()].includes(type.toLowerCase()),
  );
}
export function fileServers(servers: Server[], path: string): Server[] {
  return servers
    .filter((server) => matchesFile(server, path))
    .sort((a, b) => Number(!!a.isLinter) - Number(!!b.isLinter));
}
export function resolveFile(value: string, cwd: string): string {
  const path = realpathSync(resolve(cwd, expandHome(value)));
  const info = statSync(path);
  if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);
  if (info.size > MAX_FILE_BYTES) throw new Error(`File exceeds the 16 MiB LSP limit: ${path}`);
  return path;
}
export function readText(path: string): string {
  const bytes = readFileSync(path);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}
export function languageId(server: ServerConfig, path: string): string {
  return (
    server.languageId ??
    (basename(path).toLowerCase() === "dockerfile"
      ? "dockerfile"
      : (LANGUAGES[extname(path).toLowerCase()] ?? (extname(path).slice(1) || "plaintext")))
  );
}
export function fileUri(path: string): string {
  return pathToFileURL(path).href;
}
export function uriFile(uri: string): string | undefined {
  try {
    return uri.startsWith("file:") ? fileURLToPath(uri) : undefined;
  } catch {
    return undefined;
  }
}
export function workspaceSource(server: Server): string | undefined {
  const skipped = new Set([
    ".git",
    ".codex",
    ".claude",
    "node_modules",
    ".venv",
    "venv",
    "target",
    "dist",
    "build",
  ]);
  function visit(directory: string): string | undefined {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !skipped.has(entry.name)) {
        const found = visit(path);
        if (found) return found;
      }
      if (entry.isFile() && matchesFile(server, path) && statSync(path).size <= MAX_FILE_BYTES)
        return path;
    }
  }
  return visit(server.root);
}
export function serverForLanguage(language: string, configs: Record<string, ServerConfig>): string {
  const aliases: Record<string, string> = {
    bash: ".sh",
    "c++": ".cpp",
    "c#": ".cs",
    docker: "dockerls",
    dockerfile: "dockerls",
    helm: "helm-ls",
    latex: "texlab",
    odin: "ols",
    shell: ".sh",
    tex: "texlab",
  };
  const name = language.toLowerCase(),
    alias = Object.hasOwn(aliases, name) ? aliases[name] : undefined;
  if (Object.hasOwn(configs, name)) return name;
  if (alias && Object.hasOwn(configs, alias)) return alias;
  const extensions = alias
    ? [alias]
    : Object.keys(LANGUAGES).filter((ext) => LANGUAGES[ext] === name);
  if (!extensions.length) extensions.push(name.startsWith(".") ? name : `.${name}`);
  const matches = Object.keys(configs).filter((id) =>
    (configs[id].fileTypes ?? []).some((ext) => extensions.includes(ext.toLowerCase())),
  );
  const selected = matches.find((id) => !configs[id].isLinter) ?? matches[0];
  if (!selected)
    throw new Error(`No bundled language server matches ${language}; pass a server ID`);
  return selected;
}
