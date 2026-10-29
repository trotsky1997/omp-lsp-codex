import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { ancestors, inside, loadConfig, object, readText, resolveCommand, resolveFile } from "./config.js";
import { position, sessionClient } from "./commands.js";
import { requestBefore } from "./semantic.js";
export const rustFile = (file) => /\.rs$/i.test(file);
export function rustBackend(args) {
    const executable = resolveCommand("codex-lsp-rust-types", args.cwd, args.globalBinsOnly);
    if (executable)
        return executable;
    const cargoHome = process.env.CARGO_HOME ? resolve(args.cwd, process.env.CARGO_HOME) : join(homedir(), ".cargo");
    const registered = resolveCommand(join(cargoHome, "bin", "codex-lsp-rust-types"), args.cwd);
    if (registered && (!args.globalBinsOnly || !inside(args.cwd, registered)))
        return registered;
    const source = ["../native/rust-types/", "../../native/rust-types/"].map(path => fileURLToPath(new URL(path, import.meta.url))).find(path => existsSync(join(path, "Cargo.toml")));
    const quoted = source ? process.platform === "win32" ? `'${source.replaceAll("'", "''")}'` : `'${source.replaceAll("'", "'\\''")}'` : "PATH_TO_CODEX_LSP/native/rust-types";
    throw new Error(`Rust type backend is missing. Install Rust 1.98+ and rust-src, then run cargo install --locked --path ${quoted}; ensure Cargo's bin directory is on PATH, then rerun codex-lsp setup rust-types. Official documentation: https://rust-analyzer.github.io/book/contributing/architecture.html`);
}
export function setupRustTypes(args) {
    const executable = rustBackend(args);
    return { data: { success: true, provider: "rust-analyzer-api", executable }, human: `Rust semantic type backend available: ${executable}\nUse types --file src/lib.rs --symbol NAME; Cargo configuration comes from the rust-analyzer settings.` };
}
export async function rustTypes(args, session) {
    const file = resolveFile(args.file, args.cwd), text = readText(file);
    const named = args.symbol && args.lineExplicit === false && args.column === undefined;
    const point = named ? undefined : await position(file, text, args);
    const root = ancestors(dirname(file)).find(path => existsSync(join(path, "Cargo.toml")));
    if (!root)
        throw new Error("Rust types require a Cargo target; select a file in a Cargo workspace and prepare its lockfile/dependencies first");
    const config = object(loadConfig(dirname(file), args.globalConfigOnly)["rust-analyzer"]?.settings?.["rust-analyzer"]);
    const cargo = object(config.cargo);
    if (cargo.features !== undefined && cargo.features !== "all" && (!Array.isArray(cargo.features) || cargo.features.some(value => typeof value !== "string" || !value.trim() || value.includes("\0"))))
        throw new Error("rust-analyzer cargo.features must be all or an array of feature names");
    if (cargo.noDefaultFeatures !== undefined && typeof cargo.noDefaultFeatures !== "boolean")
        throw new Error("rust-analyzer cargo.noDefaultFeatures must be boolean");
    if (cargo.target !== undefined && (typeof cargo.target !== "string" || !cargo.target.trim() || cargo.target.includes("\0")))
        throw new Error("rust-analyzer cargo.target must be a nonempty target triple");
    const executable = rustBackend(args);
    const server = { name: "rust-analyzer-api", command: executable, resolvedCommand: executable, root,
        initOptions: { cargo: { features: cargo.features ?? [], noDefaultFeatures: cargo.noDefaultFeatures ?? false, target: cargo.target ?? null } } };
    const client = await sessionClient(server, args, session), view = args.view ?? "computed";
    try {
        if (client.capabilities.codexTypesVersion !== 1)
            throw new Error("Rust backend API version mismatch; reinstall codex-lsp-rust-types from this CLI's native/rust-types directory");
        const { uri } = await client.open(file);
        const data = object(await requestBefore(client, "codex/types", { uri, ...(named ? { symbol: args.symbol } : { range: args.range ?? { start: point, end: point } }), view, limit: args.limit }, Date.now() + args.timeout));
        if (typeof data.success !== "boolean" || data.supported !== true || data.provider !== "rust-analyzer-api" || data.apiVersion !== 1 || data.view !== view || typeof data.found !== "boolean" || typeof data.summary !== "string" || !data.summary.isWellFormed() || !Number.isSafeInteger(data.snapshot) || Number(data.snapshot) < 0 || typeof data.engineVersion !== "string" || typeof data.backendVersion !== "string" || (data.found ? object(data.type).text !== data.summary : data.type !== null))
            throw new Error("Invalid Rust semantic API response");
        if (readText(file) !== text)
            throw new Error("Source changed during Rust query; retry with a current anchor");
        return { data: { ...data, file }, ...(data.success ? {} : { code: 1 }), human: [`rust-analyzer ${data.engineVersion} (${view})`, data.summary, data.hint].filter(Boolean).join("\n") };
    }
    catch (error) {
        await client.close();
        throw error;
    }
    finally {
        if (!session)
            await client.close();
    }
}
