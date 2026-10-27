import { basename } from "node:path";
import childProcess from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { windowsCommand } from "./windows-command.js";
import { CLIENT_CAPABILITIES } from "./omp/capabilities.js";
import { encodeMessageFrame, MessageFramer } from "./omp/message-framing.js";
import { fileUri, gitRoot, languageId, object, readText, resolveFile, uriFile } from "./config.js";
import { applyWorkspaceEdit } from "./edits.js";
import { version } from "./version.js";
function validDiagnostics(value) {
    const coordinate = (n) => typeof n === "number" && Number.isInteger(n) && n >= 0;
    return Array.isArray(value) && value.every((entry) => {
        const item = object(entry), range = object(item.range), start = object(range.start), end = object(range.end);
        return typeof item.message === "string" &&
            [start, end].every((pos) => coordinate(pos.line) && coordinate(pos.character)) &&
            (Number(end.line) > Number(start.line) || (end.line === start.line && Number(end.character) >= Number(start.character))) &&
            (item.severity === undefined || (Number.isInteger(item.severity) && Number(item.severity) >= 1 && Number(item.severity) <= 4));
    });
}
// Extracted from OMP's async stdio client; a batch or stdio session can reuse it.
export class LspClient {
    server;
    timeoutMs;
    allowApply;
    static active = new Set();
    proc;
    exited;
    diagnostics = new Map();
    documents = new Map();
    progress = new Set();
    progressSeen = new Set();
    capabilities = {};
    serverStatus;
    applyEdit;
    renameTarget;
    #pending = new Map();
    #listeners = new Set();
    #requestId = 0;
    #writeQueue = Promise.resolve();
    #stderr = "";
    #failure;
    #closed = false;
    #closing;
    get reusable() { return !this.#failure && !this.#closed; }
    constructor(server, timeoutMs, allowApply = false) {
        this.server = server;
        this.timeoutMs = timeoutMs;
        this.allowApply = allowApply;
        const command = [
            server.resolvedCommand,
            ...(server.args ?? []).map((arg) => (arg === "$PID" ? String(process.pid) : arg)),
        ];
        const invocation = process.platform === "win32" && /\.(cmd|bat)$/i.test(command[0])
            ? windowsCommand(command[0], command.slice(1))
            : { command: command[0], args: command.slice(1), windowsVerbatimArguments: false };
        this.proc = childProcess.spawn(invocation.command, invocation.args, {
            cwd: server.root,
            stdio: "pipe",
            windowsVerbatimArguments: invocation.windowsVerbatimArguments,
            env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" },
        });
        LspClient.active.add(this);
        void this.#readMessages();
        void this.#readStderr();
        this.proc.stdin.on("error", error => this.#fail(error));
        this.exited = new Promise(resolve => {
            this.proc.once("error", error => this.#fail(error));
            this.proc.once("close", (code, signal) => {
                this.#fail(new Error(`${server.name} exited (${signal ?? code})${this.#stderr.trim() ? `: ${this.#stderr.trim()}` : ""}`));
                resolve();
            });
        });
    }
    static async start(server, timeoutMs, allowApply = false) {
        const client = new LspClient(server, timeoutMs, allowApply);
        const capabilities = structuredClone(CLIENT_CAPABILITIES);
        capabilities.workspace.applyEdit = allowApply;
        capabilities.workspace.workspaceEdit.resourceOperations = [];
        capabilities.textDocument.diagnostic.dynamicRegistration = false;
        try {
            const result = await client.request("initialize", {
                processId: process.pid,
                clientInfo: { name: "codex-lsp", version },
                rootUri: fileUri(server.root),
                rootPath: server.root,
                workspaceFolders: [{ uri: fileUri(server.root), name: basename(server.root) }],
                initializationOptions: server.initOptions ?? {},
                capabilities: {
                    ...capabilities,
                    general: { positionEncodings: ["utf-16"] },
                    experimental: { serverStatusNotification: true },
                },
            }, Math.max(timeoutMs, server.warmupTimeoutMs ?? 5000));
            client.capabilities = result?.capabilities ?? {};
            if (client.capabilities.positionEncoding !== undefined && client.capabilities.positionEncoding !== "utf-16")
                throw new Error(`Unsupported LSP position encoding: ${client.capabilities.positionEncoding}; codex-lsp requires utf-16`);
            await client.notify("initialized", {});
            await client.notify("workspace/didChangeConfiguration", { settings: server.settings ?? {} });
            return client;
        }
        catch (error) {
            await client.close();
            throw error;
        }
    }
    async #send(message) {
        const write = this.#writeQueue.then(async () => {
            if (this.#failure)
                throw this.#failure;
            await new Promise((resolve, reject) => this.proc.stdin.write(encodeMessageFrame(message), error => error ? reject(error) : resolve()));
        });
        this.#writeQueue = write.catch(() => { });
        return write;
    }
    request(method, params, timeoutMs = this.timeoutMs) {
        const id = ++this.#requestId;
        const { promise, resolve, reject } = Promise.withResolvers();
        const timer = setTimeout(() => {
            this.#pending.delete(id);
            void this.notify("$/cancelRequest", { id }).catch(() => { });
            reject(new Error(`LSP request ${method} timed out after ${timeoutMs / 1000}s`));
        }, Math.max(1, timeoutMs));
        this.#pending.set(id, {
            resolve(value) {
                clearTimeout(timer);
                resolve(value);
            },
            reject(error) {
                clearTimeout(timer);
                reject(error);
            },
        });
        void this.#send({ jsonrpc: "2.0", id, method, params }).catch((error) => {
            this.#pending.delete(id);
            clearTimeout(timer);
            reject(error);
        });
        return promise;
    }
    notify(method, params = {}) {
        return this.#send({ jsonrpc: "2.0", method, params });
    }
    async #readMessages() {
        const framer = new MessageFramer(Buffer.alloc(0));
        try {
            for await (const chunk of this.proc.stdout) {
                framer.push(chunk);
                for (const text of framer.drain((header) => {
                    this.#stderr = (this.#stderr + `\nNon-protocol stdout: ${header.slice(0, 200)}`).slice(-8192);
                })) {
                    const message = JSON.parse(text);
                    // Server request IDs have a separate namespace and can collide with our pending IDs.
                    if ("method" in message) {
                        if ("id" in message)
                            await this.#serverRequest(message);
                        else
                            this.#notification(message);
                    }
                    else if (message.id !== undefined) {
                        const pending = this.#pending.get(message.id);
                        this.#pending.delete(message.id);
                        if (message.error)
                            pending?.reject(Object.assign(new Error(`LSP error ${message.error.code}: ${message.error.message}`), { code: message.error.code }));
                        else
                            pending?.resolve(message.result);
                    }
                }
            }
            if (!this.#closed) {
                await Promise.race([this.exited, sleep(100, undefined, { ref: false })]);
                this.#fail(new Error(`${this.server.name} closed its LSP stream${this.#stderr ? `: ${this.#stderr}` : ""}`));
            }
        }
        catch (error) {
            this.#fail(error instanceof Error ? error : new Error(String(error)));
        }
    }
    async #readStderr() {
        try {
            const decoder = new TextDecoder();
            for await (const chunk of this.proc.stderr)
                this.#stderr = (this.#stderr + decoder.decode(chunk, { stream: true })).slice(-8192);
        }
        catch {
            /* Process shutdown closes stderr. */
        }
    }
    #notification(message) {
        const params = object(message.params);
        if (message.method === "textDocument/publishDiagnostics" &&
            typeof params.uri === "string") {
            if (params.version !== undefined) {
                if (!Number.isInteger(params.version) || Number(params.version) < 0) {
                    this.diagnostics.delete(params.uri);
                    return;
                }
                if (this.documents.has(params.uri) && this.documents.get(params.uri).version !== params.version)
                    return;
            }
            if (validDiagnostics(params.diagnostics))
                this.diagnostics.set(params.uri, params.diagnostics);
            else
                this.diagnostics.delete(params.uri);
        }
        else if (message.method === "experimental/serverStatus") {
            this.serverStatus = params;
        }
        else if (message.method === "$/progress") {
            const token = String(params.token), value = object(params.value);
            this.progressSeen.add(token);
            if (value.kind === "end")
                this.progress.delete(token);
            else
                this.progress.add(token);
        }
        else if (["window/logMessage", "window/showMessage"].includes(message.method)) {
            this.#stderr = (this.#stderr + `\n${String(params.message ?? "")}`).slice(-8192);
        }
        for (const wake of [...this.#listeners])
            wake();
    }
    async #serverRequest(message) {
        const params = object(message.params);
        let result = null;
        let error;
        switch (message.method) {
            case "workspace/configuration":
                result = (Array.isArray(params.items) ? params.items : []).map((item) => {
                    const section = object(item).section;
                    let value = this.server.settings ?? {};
                    if (typeof section === "string" && section)
                        for (const part of section.split("."))
                            value = object(value)[part];
                    return value ?? null;
                });
                break;
            case "workspace/workspaceFolders":
                result = [{ uri: fileUri(this.server.root), name: basename(this.server.root) }];
                break;
            case "workspace/applyEdit":
                if (!this.allowApply || !this.applyEdit)
                    result = { applied: false, failureReason: "This invocation is read-only" };
                else {
                    try {
                        await this.applyEdit(object(params.edit));
                        result = { applied: true };
                    }
                    catch (error) {
                        result = { applied: false, failureReason: String(error) };
                    }
                }
                break;
            // Refactoring can request editor rename UI; retain the generated name and expose its anchor.
            case "_typescript.rename": {
                const uri = object(params.textDocument).uri, point = object(params.position);
                const document = typeof uri === "string" ? this.documents.get(uri) : undefined;
                const lines = document?.text.split("\n").map(line => line.replace(/\r$/, ""));
                const line = Number(point.line), character = Number(point.character);
                if (this.allowApply && typeof uri === "string" && uriFile(uri) && Number.isSafeInteger(point.line) && Number.isSafeInteger(point.character) && line >= 0 && character >= 0 &&
                    lines?.[line] !== undefined && character <= lines[line].length && !(lines[line].charCodeAt(character) >= 0xdc00 && lines[line].charCodeAt(character) <= 0xdfff))
                    this.renameTarget = { file: uriFile(uri), line: line + 1, column: character + 1 };
                break;
            }
            case "client/registerCapability":
                for (const item of Array.isArray(params.registrations) ? params.registrations : []) {
                    if (object(item).method === "textDocument/diagnostic")
                        this.capabilities.diagnosticProvider = object(item).registerOptions ?? true;
                }
                break;
            case "client/unregisterCapability":
            case "window/workDoneProgress/create":
            case "workspace/diagnostic/refresh":
                break;
            default:
                error = { code: -32601, message: `Unsupported client request: ${message.method}` };
        }
        await this.#send({ jsonrpc: "2.0", id: message.id, ...(error ? { error } : { result }) });
    }
    #fail(error) {
        this.#failure ??= error;
        for (const pending of this.#pending.values())
            pending.reject(this.#failure);
        this.#pending.clear();
        for (const wake of [...this.#listeners])
            wake();
    }
    async #waitUntil(check, timeoutMs, label) {
        if (this.#failure)
            throw this.#failure;
        if (check())
            return;
        const { promise, resolve, reject } = Promise.withResolvers();
        const wake = () => {
            if (check()) {
                cleanup();
                resolve();
            }
            else if (this.#failure) {
                cleanup();
                reject(this.#failure);
            }
        };
        const timer = setTimeout(() => {
            cleanup();
            const seconds = Math.min(300, Math.max(120, Math.ceil(this.timeoutMs / 1000) * 2));
            const recovery = this.timeoutMs < 300000 ? `retry with --timeout ${seconds}` : "check project dependencies and language-server health";
            const context = this.server.name === "rust-analyzer" && label === "workspace analysis"
                ? `; run cargo metadata --locked --format-version 1 in ${this.server.root} to check dependencies (omit --locked if Cargo.lock is absent)${typeof this.serverStatus?.message === "string" ? `; server status: ${this.serverStatus.message}` : ""}` : "";
            reject(new Error(`Timed out waiting for ${this.server.name} ${label}; ${recovery}${context}`));
        }, Math.max(1, timeoutMs));
        const cleanup = () => {
            clearTimeout(timer);
            this.#listeners.delete(wake);
        };
        this.#listeners.add(wake);
        wake();
        return promise;
    }
    async open(path) {
        path = resolveFile(path, this.server.root);
        const text = readText(path), uri = fileUri(path);
        const opened = this.documents.get(uri);
        if (opened) {
            if (opened.text !== text)
                throw new Error(`File changed during the shared session: ${path}; retry with a fresh batch`);
            return { uri, text };
        }
        this.documents.set(uri, { text, version: 1 });
        await this.notify("textDocument/didOpen", {
            textDocument: { uri, languageId: languageId(this.server, path), version: 1, text },
        });
        return { uri, text };
    }
    async edit(edit) {
        if (!this.allowApply)
            throw new Error("This invocation is read-only");
        const updated = await applyWorkspaceEdit(edit, gitRoot(this.server.root), this.documents);
        try {
            for (const [uri, text] of updated)
                await this.#syncDocument(uri, text);
        }
        catch (error) {
            throw new Error(`Edits applied, but LSP synchronization failed: ${error}`);
        }
        return updated.size > 0;
    }
    async #syncDocument(uri, text) {
        const document = this.documents.get(uri);
        if (!document)
            return;
        const version = document.version + 1;
        this.documents.set(uri, { text, version });
        this.diagnostics.delete(uri);
        const sync = this.capabilities.textDocumentSync, change = typeof sync === "number" ? sync : object(sync).change;
        if (change === 0) {
            await this.notify("textDocument/didClose", { textDocument: { uri } });
            await this.notify("textDocument/didOpen", { textDocument: { uri, languageId: languageId(this.server, uriFile(uri)), version, text } });
        }
        else {
            const lines = document.text.split("\n");
            await this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{
                        ...(change === 2 ? { range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1).length } } } : {}), text,
                    }] });
        }
    }
    async refresh() {
        let refreshed = 0;
        for (const [uri, document] of [...this.documents]) {
            const path = uriFile(uri);
            let text;
            try {
                text = readText(path);
            }
            catch (error) {
                if (!["ENOENT", "ENOTDIR"].includes(String(object(error).code)))
                    throw error;
                await this.notify("textDocument/didClose", { textDocument: { uri } });
                this.documents.delete(uri);
                this.diagnostics.delete(uri);
                refreshed++;
                continue;
            }
            if (text !== document.text) {
                await this.#syncDocument(uri, text);
                if (this.server.name === "rust-analyzer")
                    await this.notify("textDocument/didSave", { textDocument: { uri } });
                refreshed++;
            }
        }
        return refreshed;
    }
    async waitDiagnostics(uri, timeoutMs = this.timeoutMs) {
        await this.#waitUntil(() => this.diagnostics.has(uri), timeoutMs, "file analysis");
        return this.diagnostics.get(uri);
    }
    async waitWorkspace(timeoutMs = this.timeoutMs) {
        await this.#waitUntil(() => this.serverStatus?.quiescent === true, timeoutMs, "workspace analysis");
        if (this.serverStatus?.health !== "ok")
            throw new Error(`rust-analyzer workspace is incomplete: ${this.serverStatus?.message ?? this.serverStatus?.health}`);
    }
    async ready(uri) {
        if (this.server.name === "rust-analyzer")
            await this.waitWorkspace();
        if (["pyright", "basedpyright"].includes(this.server.name))
            await this.waitDiagnostics(uri);
    }
    async #waitRustCheck(timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        const relevant = (token) => /^(rustAnalyzer|rust-analyzer)\//.test(token);
        while (Date.now() < deadline) {
            if ([...this.progressSeen].some(relevant) && ![...this.progress].some(relevant)) {
                await sleep(100);
                if (![...this.progress].some(relevant))
                    return true;
            }
            await sleep(50);
        }
        return false;
    }
    async getDiagnostics(uri, timeoutMs = this.timeoutMs) {
        const result = await this.#collectDiagnostics(uri, timeoutMs), document = this.documents.get(uri);
        if (result.verified && document &&
            readText(resolveFile(uriFile(uri), this.server.root)) !== document.text)
            return { diagnostics: [], verified: false };
        return result;
    }
    async #collectDiagnostics(uri, timeoutMs) {
        const deadline = Date.now() + timeoutMs, remaining = () => Math.max(1, deadline - Date.now());
        let ready = true;
        if (this.server.name === "rust-analyzer") {
            await this.waitWorkspace(remaining());
            ready = await this.#waitRustCheck(remaining());
            if (this.diagnostics.has(uri))
                return { diagnostics: this.diagnostics.get(uri), verified: ready };
        }
        if (this.capabilities.diagnosticProvider) {
            try {
                const report = await this.request("textDocument/diagnostic", { textDocument: { uri } }, remaining());
                if (report.kind === "full")
                    return validDiagnostics(report.items)
                        ? { diagnostics: report.items, verified: ready }
                        : { diagnostics: [], verified: false };
            }
            catch {
                /* Older servers can advertise pull diagnostics but only publish them. */
            }
        }
        try {
            return { diagnostics: await this.waitDiagnostics(uri, remaining()), verified: ready };
        }
        catch {
            return { diagnostics: [], verified: false };
        }
    }
    close() {
        return this.#closing ??= this.#close();
    }
    async #close() {
        this.#closed = true;
        try {
            if (!this.#failure) {
                try {
                    await this.request("shutdown", null, 1000);
                    await this.notify("exit");
                }
                catch {
                    /* Kill below if shutdown fails. */
                }
            }
            if (this.proc.exitCode === null && this.proc.signalCode === null) {
                await Promise.race([this.exited, sleep(200, undefined, { ref: false })]);
                if (this.proc.exitCode === null && this.proc.signalCode === null) {
                    this.proc.kill();
                    await Promise.race([this.exited, sleep(200, undefined, { ref: false })]);
                    if (this.proc.exitCode === null && this.proc.signalCode === null)
                        this.proc.kill("SIGKILL");
                }
            }
            await this.exited;
        }
        finally {
            this.#fail(new Error("LSP client closed"));
            LspClient.active.delete(this);
        }
    }
}
