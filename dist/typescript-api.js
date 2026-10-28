import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ancestors, gitRoot, inside, loadConfig, object, readText, resolveCommand, resolveFile } from "./config.js";
import { position, sessionClient } from "./commands.js";
import { requestBefore } from "./semantic.js";
export function typescriptFile(file) { return /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file); }
export function typescriptCompiler(file, args) {
    if (!args.globalBinsOnly) {
        try {
            return realpathSync(createRequire(file).resolve("typescript"));
        }
        catch (error) {
            if (object(error).code !== "MODULE_NOT_FOUND")
                throw error;
        }
    }
    const fallback = object(loadConfig(dirname(file), args.globalConfigOnly)["typescript-language-server"]?.initOptions).tsserver;
    const configured = object(fallback).fallbackPath;
    if (typeof configured === "string" && existsSync(join(dirname(configured), "typescript.js")))
        return realpathSync(join(dirname(configured), "typescript.js"));
    const executable = resolveCommand("tsserver", dirname(file), args.globalBinsOnly) ?? resolveCommand("tsc", dirname(file), args.globalBinsOnly);
    if (executable) {
        try {
            return realpathSync(createRequire(realpathSync(executable)).resolve("typescript"));
        }
        catch (error) {
            if (object(error).code !== "MODULE_NOT_FOUND")
                throw error;
        }
    }
    for (const path of [
        ...(executable ? [join(dirname(realpathSync(executable)), "../lib/typescript.js"), join(dirname(executable), "node_modules/typescript/lib/typescript.js")] : []),
    ])
        if (existsSync(path))
            return realpathSync(path);
    throw new Error("TypeScript Compiler API is unavailable; prepare the project's declared typescript dependency or install npm install --global typescript. Official documentation: https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API");
}
export async function typescriptTypes(args, session) {
    const file = resolveFile(args.file, args.cwd), text = readText(file), point = await position(file, text, args);
    const compiler = typescriptCompiler(file, args), boundary = gitRoot(dirname(file));
    const config = ancestors(dirname(file)).filter(path => inside(boundary, path)).flatMap(path => [join(path, "tsconfig.json"), join(path, "jsconfig.json")]).find(existsSync);
    const root = config ? dirname(config) : boundary;
    const server = { name: "typescript-api", command: process.execPath, resolvedCommand: process.execPath, root,
        args: [fileURLToPath(new URL("./typescript-worker.js", import.meta.url)), compiler, config ?? ""], warmupTimeoutMs: args.timeout };
    const client = await sessionClient(server, args, session), view = args.view ?? "computed";
    try {
        const { uri } = await client.open(file);
        const data = object(await requestBefore(client, "codex/types", { uri, range: args.range ?? { start: point, end: point }, view, limit: args.limit }, Date.now() + args.timeout));
        if (typeof data.success !== "boolean" || data.provider !== "typescript-api" || data.view !== view || typeof data.found !== "boolean" || typeof data.summary !== "string")
            throw new Error("Invalid TypeScript API response");
        if (readText(file) !== text)
            throw new Error("Source changed during TypeScript query; retry with a current anchor");
        return { data: { ...data, file }, human: [`TypeScript ${data.compilerVersion} (${view})`, data.summary, data.hint].filter(Boolean).join("\n"), ...(data.success ? {} : { code: 1 }) };
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
