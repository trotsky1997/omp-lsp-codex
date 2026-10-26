import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync, statSync, } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import defaults from "./defaults.json" with { type: "json" };
export function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
export const MAX_FILES = 200;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const LANGUAGES = {
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
export function expandHome(path) {
    return path === "~" ? homedir() : /^[~][\\/]/.test(path) ? join(homedir(), path.slice(2)) : path;
}
export function ancestors(cwd) {
    const paths = [resolve(cwd)];
    while (dirname(paths.at(-1)) !== paths.at(-1))
        paths.push(dirname(paths.at(-1)));
    return paths;
}
export function gitRoot(cwd) {
    return ancestors(cwd).find((path) => existsSync(join(path, ".git"))) ?? cwd;
}
export function inside(root, path) {
    const rel = relative(root, path);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export function insideWorkspace(root, path) {
    if (!inside(root, path))
        return false;
    const checkout = gitRoot(dirname(path));
    return !existsSync(join(checkout, ".git")) || inside(checkout, root);
}
export function configPaths(cwd, globalOnly = false) {
    const global = join(homedir(), ".codex/lsp.json");
    if (globalOnly)
        return [global];
    const roots = ancestors(cwd);
    const root = roots.find((path) => existsSync(join(path, ".git"))) ??
        roots.find((path) => path !== homedir() && existsSync(join(path, ".codex/lsp.json"))) ?? cwd;
    return [global, join(root, ".codex/lsp.json")];
}
export function readOverrides(path) {
    if (!existsSync(path))
        return {};
    let doc;
    try {
        doc = JSON.parse(readFileSync(path, "utf8"));
    }
    catch (error) {
        throw new Error(`Cannot read LSP configuration ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc))
        throw new Error(`LSP config must contain an object: ${path}`);
    const entries = "servers" in doc ? doc.servers : doc;
    if (!entries || typeof entries !== "object" || Array.isArray(entries))
        throw new Error(`The servers field must contain an object: ${path}`);
    for (const [name, value] of Object.entries(entries)) {
        if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error(`Invalid LSP server ${name} in ${path}`);
    }
    return entries;
}
export function loadConfig(cwd, globalConfigOnly = false) {
    const configs = Object.assign(Object.create(null), structuredClone(defaults));
    for (const path of configPaths(cwd, globalConfigOnly)) {
        for (const [name, override] of Object.entries(readOverrides(path)))
            configs[name] = { ...configs[name], ...override };
    }
    for (const [name, config] of Object.entries(configs)) {
        if (typeof config.command !== "string" || !config.command.trim())
            throw new Error(`LSP server ${name} needs a command`);
        for (const field of ["args", "fileTypes", "rootMarkers"]) {
            const value = config[field];
            if (value !== undefined &&
                (!Array.isArray(value) || value.some((x) => typeof x !== "string")))
                throw new Error(`Invalid ${name}.${field}`);
        }
        for (const field of ["settings", "initOptions"]) {
            const value = config[field];
            if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value)))
                throw new Error(`Invalid ${name}.${field}`);
        }
        for (const field of ["disabled", "isLinter"])
            if (config[field] !== undefined && typeof config[field] !== "boolean")
                throw new Error(`Invalid ${name}.${field}: expected a boolean`);
        if (config.languageId !== undefined && (typeof config.languageId !== "string" || !config.languageId.trim()))
            throw new Error(`Invalid ${name}.languageId`);
        if (config.warmupTimeoutMs !== undefined &&
            (!Number.isInteger(config.warmupTimeoutMs) || config.warmupTimeoutMs < 1 || config.warmupTimeoutMs > 2147483647))
            throw new Error(`Invalid ${name}.warmupTimeoutMs: expected 1–2147483647 milliseconds`);
        if (config.setup !== undefined) {
            const guide = object(config.setup), install = guide.install;
            const commands = (value) => typeof value === "string" ||
                (Array.isArray(value) && value.every((item) => typeof item === "string"));
            if (!config.setup || typeof config.setup !== "object" || Array.isArray(config.setup) ||
                (guide.docs !== undefined && typeof guide.docs !== "string") ||
                (install !== undefined && !commands(install) &&
                    (!install || typeof install !== "object" || Array.isArray(install) || !Object.values(install).every(commands))))
                throw new Error(`Invalid ${name}.setup`);
        }
        if (name === "typescript-language-server") {
            config.initOptions ??= {};
            if (config.initOptions.tsserver !== undefined &&
                (typeof config.initOptions.tsserver !== "object" ||
                    !config.initOptions.tsserver ||
                    Array.isArray(config.initOptions.tsserver)))
                throw new Error("initOptions.tsserver must be an object");
            config.initOptions.tsserver = {
                useSyntaxServer: "never",
                ...object(config.initOptions.tsserver),
            };
        }
    }
    return configs;
}
export function serverRoot(cwd, markers = []) {
    for (const root of ancestors(cwd)) {
        if (markers.some((marker) => {
            try {
                return /[*?\[]/.test(marker)
                    ? readdirSync(root).some((name) => matchesGlob(name, marker))
                    : existsSync(join(root, marker));
            }
            catch {
                return false;
            }
        }))
            return root;
        if (existsSync(join(root, ".git")))
            break;
    }
}
export function executable(path) {
    try {
        return (statSync(path).isFile() &&
            (accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK), true));
    }
    catch {
        return false;
    }
}
export function resolveCommand(command, root, globalOnly = false) {
    const value = expandHome(command);
    const names = process.platform === "win32" && !extname(value)
        ? [value, ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map(extension => value + extension)]
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
            if (local)
                return local;
        }
    const found = (process.env.PATH ?? "").split(delimiter).flatMap(directory => directory ? names.map(name => resolve(directory, name)) : []).find(path => executable(path) && (!globalOnly || !inside(realpathSync(root), realpathSync(path))));
    return found;
}
export function availableServers(configs, cwd, globalOnly = false) {
    const servers = [];
    for (const [name, raw] of Object.entries(configs)) {
        if (raw.disabled)
            continue;
        const root = serverRoot(cwd, raw.rootMarkers);
        if (!root)
            continue;
        const resolvedCommand = resolveCommand(raw.command, root, globalOnly);
        if (!resolvedCommand)
            continue;
        const server = { ...raw, name, root, resolvedCommand };
        if (["pyright", "basedpyright"].includes(name)) {
            const python = raw.settings?.python;
            if (python !== undefined && (!python || typeof python !== "object" || Array.isArray(python)))
                throw new Error(`${name} settings.python must be an object`);
            if (!object(python).pythonPath)
                for (const env of [".venv", "venv"]) {
                    const interpreter = join(root, env, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
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
export function matchesFile(config, path) {
    return (config.fileTypes ?? []).some((type) => [basename(path).toLowerCase(), extname(path).toLowerCase()].includes(type.toLowerCase()));
}
export function fileServers(servers, path) {
    return servers
        .filter((server) => matchesFile(server, path))
        .sort((a, b) => Number(!!a.isLinter) - Number(!!b.isLinter));
}
export function resolveFile(value, cwd) {
    const requested = resolve(cwd, expandHome(value));
    let path;
    try {
        path = realpathSync(requested);
    }
    catch (error) {
        if (["ENOENT", "ENOTDIR"].includes(String(object(error).code)))
            throw new Error(`File not found: ${requested}; use rg --files to locate the source, then pass the existing path to --file`);
        throw error;
    }
    const info = statSync(path);
    if (!info.isFile())
        throw new Error(`Not a regular file: ${path}`);
    if (info.size > MAX_FILE_BYTES)
        throw new Error(`File exceeds the 16 MiB LSP limit: ${path}`);
    return path;
}
export function readText(path) {
    const bytes = readFileSync(path);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}
export function languageId(server, path) {
    return (server.languageId ??
        (basename(path).toLowerCase() === "dockerfile"
            ? "dockerfile"
            : (LANGUAGES[extname(path).toLowerCase()] ?? (extname(path).slice(1) || "plaintext"))));
}
export function fileUri(path) {
    return pathToFileURL(path).href;
}
export function uriFile(uri) {
    try {
        return uri.startsWith("file:") ? fileURLToPath(uri) : undefined;
    }
    catch {
        return undefined;
    }
}
export function workspaceSource(server) {
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
    function visit(directory) {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const path = join(directory, entry.name);
            if (entry.isDirectory() && !skipped.has(entry.name)) {
                const found = visit(path);
                if (found)
                    return found;
            }
            if (entry.isFile() && matchesFile(server, path) && statSync(path).size <= MAX_FILE_BYTES)
                return path;
        }
    }
    return visit(server.root);
}
export function serverForLanguage(language, configs) {
    const aliases = {
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
    const name = language.toLowerCase(), alias = Object.hasOwn(aliases, name) ? aliases[name] : undefined;
    if (Object.hasOwn(configs, name))
        return name;
    if (alias && Object.hasOwn(configs, alias))
        return alias;
    const extensions = alias
        ? [alias]
        : Object.keys(LANGUAGES).filter((ext) => LANGUAGES[ext] === name);
    if (!extensions.length)
        extensions.push(name.startsWith(".") ? name : `.${name}`);
    const matches = Object.keys(configs).filter((id) => (configs[id].fileTypes ?? []).some((ext) => extensions.includes(ext.toLowerCase())));
    const selected = matches.find((id) => !configs[id].isLinter) ?? matches[0];
    if (!selected)
        throw new Error(`No bundled language server matches ${language}; pass a server ID`);
    return selected;
}
