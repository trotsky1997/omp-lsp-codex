import { basename } from "node:path";
import childProcess, { type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { windowsCommand } from "./windows-command.ts";
import { CLIENT_CAPABILITIES } from "./omp/capabilities.ts";
import { encodeMessageFrame, MessageFramer } from "./omp/message-framing.ts";
import type {
  Diagnostic,
  LspJsonRpcId,
  LspJsonRpcNotification,
  LspJsonRpcRequest,
  LspJsonRpcResponse,
  WorkspaceEdit,
} from "./omp/types.ts";
import { fileUri, gitRoot, languageId, MAX_FILE_BYTES, MAX_FILES, object, readText, resolveFile, uriFile, type ObjectValue, type Server } from "./config.ts";
import { applyWorkspaceEdit, type DocumentState } from "./edits.ts";
import { version } from "./version.ts";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}
interface ServerStatus {
  quiescent?: boolean;
  health?: string;
  message?: string;
}
type Message = LspJsonRpcRequest | LspJsonRpcResponse | LspJsonRpcNotification;

function validDiagnostics(value: unknown): value is Diagnostic[] {
  const coordinate = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0;
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
  static readonly active = new Set<LspClient>();
  readonly proc: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  readonly diagnostics = new Map<string, Diagnostic[]>();
  readonly documents = new Map<string, DocumentState>();
  readonly progress = new Set<string>();
  readonly progressSeen = new Set<string>();
  capabilities: ObjectValue = {};
  serverStatus?: ServerStatus;
  applyEdit?: (edit: WorkspaceEdit) => Promise<void>;
  renameTarget?: { file: string; line: number; column: number };
  #pending = new Map<LspJsonRpcId, Pending>();
  #listeners = new Set<() => void>();
  #requestId = 0;
  #writeQueue: Promise<void> = Promise.resolve();
  #stderr = "";
  #failure?: Error;
  #diagnosticSizes = new WeakMap<Diagnostic[], number>();
  #diagnosticLimit?: Error;
  #diagnosticOverflow = 0;
  #configurationInitialized = false;
  #closed = false;
  #closing?: Promise<void>;

  get reusable(): boolean { return !this.#failure && !this.#closed; }

  constructor(
    readonly server: Server,
    readonly timeoutMs: number,
    readonly allowApply = false,
  ) {
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

  static async start(server: Server, timeoutMs: number, allowApply = false): Promise<LspClient> {
    const client = new LspClient(server, timeoutMs, allowApply);
    const capabilities = structuredClone(CLIENT_CAPABILITIES);
    capabilities.workspace.applyEdit = allowApply;
    capabilities.workspace.workspaceEdit.resourceOperations = [];
    capabilities.textDocument.diagnostic.dynamicRegistration = false;
    try {
      const result = await client.request<{ capabilities?: ObjectValue; serverInfo?: { name?: string } }>(
        "initialize",
        {
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
        },
        Math.max(timeoutMs, server.warmupTimeoutMs ?? 5000),
      );
      client.capabilities = result?.capabilities ?? {};
      if (client.capabilities.positionEncoding !== undefined && client.capabilities.positionEncoding !== "utf-16")
        throw new Error(`Unsupported LSP position encoding: ${client.capabilities.positionEncoding}; codex-lsp requires utf-16`);
      await client.notify("initialized", {});
      // Biome pulls initial settings itself; a concurrent reload publishes provisional empty diagnostics.
      if (server.name === "biome" || result?.serverInfo?.name === "biome_lsp")
        await client.#waitUntil(() => client.#configurationInitialized, Math.max(timeoutMs, server.warmupTimeoutMs ?? 5000), "configuration initialization");
      else if (Object.keys(server.settings ?? {}).length)
        await client.notify("workspace/didChangeConfiguration", { settings: server.settings });
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async #send(message: Message): Promise<void> {
    const write = this.#writeQueue.then(async () => {
      if (this.#failure) throw this.#failure;
      await new Promise<void>((resolve, reject) => this.proc.stdin.write(encodeMessageFrame(message), error => error ? reject(error) : resolve()));
    });
    this.#writeQueue = write.catch(() => {});
    return write;
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const id = ++this.#requestId;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(
      () => {
        this.#pending.delete(id);
        void this.notify("$/cancelRequest", { id }).catch(() => {});
        reject(new Error(`LSP request ${method} timed out after ${timeoutMs / 1000}s`));
      },
      Math.max(1, timeoutMs),
    );
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
    return promise as Promise<T>;
  }

  notify(method: string, params: unknown = {}): Promise<void> {
    return this.#send({ jsonrpc: "2.0", method, params });
  }

  async #readMessages(): Promise<void> {
    const framer = new MessageFramer(Buffer.alloc(0));
    try {
      for await (const chunk of this.proc.stdout) {
        framer.push(chunk);
        for (const text of framer.drain((header) => {
          this.#stderr = (this.#stderr + `\nNon-protocol stdout: ${header.slice(0, 200)}`).slice(
            -8192,
          );
        })) {
          const message = JSON.parse(text) as Message;
          // Server request IDs have a separate namespace and can collide with our pending IDs.
          if ("method" in message) {
            if ("id" in message) await this.#serverRequest(message);
            else this.#notification(message);
          } else if (message.id !== undefined) {
            const pending = this.#pending.get(message.id);
            this.#pending.delete(message.id);
            if (message.error)
              pending?.reject(
                Object.assign(new Error(`LSP error ${message.error.code}: ${message.error.message}`), { code: message.error.code }),
              );
            else pending?.resolve(message.result);
          }
        }
      }
      if (!this.#closed) {
        await Promise.race([this.exited, sleep(100, undefined, { ref: false })]);
        this.#fail(
          new Error(
            `${this.server.name} closed its LSP stream${this.#stderr ? `: ${this.#stderr}` : ""}`,
          ),
        );
      }
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async #readStderr(): Promise<void> {
    try {
      const decoder = new TextDecoder();
      for await (const chunk of this.proc.stderr)
        this.#stderr = (this.#stderr + decoder.decode(chunk, { stream: true })).slice(-8192);
    } catch {
      /* Process shutdown closes stderr. */
    }
  }

  #notification(message: LspJsonRpcNotification): void {
    const params = object(message.params);
    if (
      message.method === "textDocument/publishDiagnostics" &&
      typeof params.uri === "string"
    ) {
      if (params.version !== undefined) {
        if (!Number.isInteger(params.version) || Number(params.version) < 0) {
          this.diagnostics.delete(params.uri);
          return;
        }
        if (this.documents.has(params.uri) && this.documents.get(params.uri)!.version !== params.version) return;
      }
      if (validDiagnostics(params.diagnostics)) this.#cacheDiagnostics(params.uri, params.diagnostics);
      else this.diagnostics.delete(params.uri);
    } else if (message.method === "experimental/serverStatus") {
      this.serverStatus = params as ServerStatus;
    } else if (message.method === "$/progress") {
      const token = String(params.token),
        value = object(params.value);
      this.progressSeen.add(token);
      if (value.kind === "end") this.progress.delete(token);
      else this.progress.add(token);
    } else if (["window/logMessage", "window/showMessage"].includes(message.method)) {
      if (message.method === "window/logMessage" && params.type === 3 && /^Server initialized with PID: \d+$/.test(String(params.message))) this.#configurationInitialized = true;
      this.#stderr = (this.#stderr + `\n${String(params.message ?? "")}`).slice(-8192);
    }
    for (const wake of [...this.#listeners]) wake();
  }

  async #serverRequest(message: LspJsonRpcRequest): Promise<void> {
    const params = object(message.params);
    let result: unknown = null;
    let error: LspJsonRpcResponse["error"];
    switch (message.method) {
      case "workspace/configuration":
        result = (Array.isArray(params.items) ? params.items : []).map((item) => {
          const section = object(item).section;
          let value: unknown = this.server.settings ?? {};
          if (typeof section === "string" && section)
            for (const part of section.split(".")) value = object(value)[part];
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
            await this.applyEdit(object(params.edit) as WorkspaceEdit);
            result = { applied: true };
          } catch (error) {
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
          this.renameTarget = { file: uriFile(uri)!, line: line + 1, column: character + 1 };
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

  #fail(error: Error): void {
    this.#failure ??= error;
    for (const pending of this.#pending.values()) pending.reject(this.#failure);
    this.#pending.clear();
    for (const wake of [...this.#listeners]) wake();
  }

  async #waitUntil(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
    if (this.#failure) throw this.#failure;
    if (check()) return;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const wake = () => {
      if (check()) {
        cleanup();
        resolve();
      } else if (this.#failure) {
        cleanup();
        reject(this.#failure);
      }
    };
    const timer = setTimeout(
      () => {
        cleanup();
        const seconds = Math.min(300, Math.max(120, Math.ceil(this.timeoutMs / 1000) * 2));
        const recovery = this.timeoutMs < 300000 ? `retry with --timeout ${seconds}` : "check project dependencies and language-server health";
        const context = this.server.name === "rust-analyzer" && label === "workspace analysis"
          ? `; run cargo metadata --locked --format-version 1 in ${this.server.root} to check dependencies (omit --locked if Cargo.lock is absent)${typeof this.serverStatus?.message === "string" ? `; server status: ${this.serverStatus.message}` : ""}` : "";
        reject(new Error(`Timed out waiting for ${this.server.name} ${label}; ${recovery}${context}`));
      },
      Math.max(1, timeoutMs),
    );
    const cleanup = () => {
      clearTimeout(timer);
      this.#listeners.delete(wake);
    };
    this.#listeners.add(wake);
    wake();
    return promise;
  }

  async open(path: string): Promise<{ uri: string; text: string }> {
    path = resolveFile(path, this.server.root);
    const text = readText(path),
      uri = fileUri(path);
    const opened = this.documents.get(uri);
    if (opened) {
      if (opened.text !== text) throw new Error(`File changed during the shared session: ${path}; retry with a fresh batch`);
      return { uri, text };
    }
    this.documents.set(uri, { text, version: 1 });
    await this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: languageId(this.server, path), version: 1, text },
    });
    return { uri, text };
  }
  async edit(edit: WorkspaceEdit): Promise<boolean> {
    if (!this.allowApply) throw new Error("This invocation is read-only");
    const updated = await applyWorkspaceEdit(edit, gitRoot(this.server.root), this.documents);
    try {
      for (const [uri, text] of updated) await this.#syncDocument(uri, text);
    } catch (error) {
      throw new Error(`Edits applied, but LSP synchronization failed: ${error}`);
    }
    return updated.size > 0;
  }
  async previewText(uri: string, text: string): Promise<void> {
    if (!this.documents.has(uri) || !text.isWellFormed() || Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error("Invalid in-memory document preview");
    if (this.documents.get(uri)!.text !== text) await this.#syncDocument(uri, text);
  }
  async #syncDocument(uri: string, text: string): Promise<void> {
    const document = this.documents.get(uri);
    if (!document) return;
    const version = document.version + 1;
    this.documents.set(uri, { text, version }); this.diagnostics.delete(uri);
    const sync = this.capabilities.textDocumentSync, change = typeof sync === "number" ? sync : object(sync).change;
    if (change === 0) {
      await this.notify("textDocument/didClose", { textDocument: { uri } });
      await this.notify("textDocument/didOpen", { textDocument: { uri, languageId: languageId(this.server, uriFile(uri)!), version, text } });
    } else {
      const lines = document.text.split("\n");
      await this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{
        ...(change === 2 ? { range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1)!.length } } } : {}), text,
      }] });
    }
  }
  async refresh(): Promise<number> {
    let refreshed = 0;
    for (const [uri, document] of [...this.documents]) {
      const path = uriFile(uri)!;
      let text: string;
      try { text = readText(path); }
      catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes(String(object(error).code))) throw error;
        await this.notify("textDocument/didClose", { textDocument: { uri } });
        this.documents.delete(uri); this.diagnostics.delete(uri); refreshed++; continue;
      }
      if (text !== document.text) {
        await this.#syncDocument(uri, text);
        if (this.server.name === "rust-analyzer") await this.notify("textDocument/didSave", { textDocument: { uri } });
        refreshed++;
      }
    }
    return refreshed;
  }
  #cacheDiagnostics(uri: string, diagnostics: Diagnostic[]): boolean {
    const bytes = (items: Diagnostic[]) => {
      let size = this.#diagnosticSizes.get(items);
      if (size === undefined) { size = Buffer.byteLength(JSON.stringify(items)); this.#diagnosticSizes.set(items, size); }
      return size;
    };
    this.diagnostics.delete(uri);
    let total = Infinity;
    try {
      total = Buffer.byteLength(uri) + bytes(diagnostics);
      for (const [key, items] of this.diagnostics) total += Buffer.byteLength(key) + bytes(items);
    } catch { total = Infinity; } // Deep provider metadata must not poison the reusable client.
    if (this.diagnostics.size >= MAX_FILES || total > MAX_FILE_BYTES) {
      this.diagnostics.clear(); this.#diagnosticOverflow++;
      this.#diagnosticLimit = new Error("Language-server diagnostics exceed 200 URI/16 MiB; narrow to --file or reduce server diagnostic scope, then retry after a fresh report");
      return false;
    }
    this.diagnostics.set(uri, diagnostics); this.#diagnosticLimit = undefined;
    return true;
  }
  async waitDiagnostics(uri: string, timeoutMs = this.timeoutMs): Promise<Diagnostic[]> {
    await this.#waitUntil(() => !!this.#diagnosticLimit || this.diagnostics.has(uri), timeoutMs, "file analysis");
    if (this.#diagnosticLimit) throw this.#diagnosticLimit;
    return this.diagnostics.get(uri)!;
  }
  async waitWorkspace(timeoutMs = this.timeoutMs): Promise<void> {
    await this.#waitUntil(() => this.serverStatus?.quiescent === true, timeoutMs, "workspace analysis");
    if (this.serverStatus?.health !== "ok")
      throw new Error(
        `rust-analyzer workspace is incomplete: ${this.serverStatus?.message ?? this.serverStatus?.health}`,
      );
  }
  async ready(uri: string): Promise<void> {
    if (this.server.name === "rust-analyzer") await this.waitWorkspace();
    if (["pyright", "basedpyright"].includes(this.server.name)) await this.waitDiagnostics(uri);
  }
  async #waitRustCheck(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const relevant = (token: string) => /^(rustAnalyzer|rust-analyzer)\//.test(token);
    while (Date.now() < deadline) {
      if ([...this.progressSeen].some(relevant) && ![...this.progress].some(relevant)) {
        await sleep(100);
        if (![...this.progress].some(relevant)) return true;
      }
      await sleep(50);
    }
    return false;
  }
  async getWorkspaceDiagnostics(timeoutMs = this.timeoutMs): Promise<{ uri: string; items: Diagnostic[]; version?: number | null }[]> {
    const capability = object(this.capabilities.diagnosticProvider);
    if (capability.workspaceDiagnostics !== true) throw new Error(`${this.server.name} does not advertise workspace diagnostics`);
    const report = object(await this.request("workspace/diagnostic", { previousResultIds: [], ...(typeof capability.identifier === "string" ? { identifier: capability.identifier } : {}) }, timeoutMs));
    if (!Array.isArray(report.items) || report.items.length > MAX_FILES) throw new Error("Invalid workspace diagnostic report or scope exceeds 200 files");
    return report.items.map(raw => {
      const item = object(raw);
      if (typeof item.uri !== "string" || item.kind !== "full" || !validDiagnostics(item.items) || item.version != null && (!Number.isSafeInteger(item.version) || Number(item.version) < 0)) throw new Error("Invalid or incomplete workspace diagnostic item");
      return { uri: item.uri, items: item.items, ...(item.version !== undefined ? { version: item.version as number | null } : {}) };
    });
  }
  async getDiagnostics(uri: string, timeoutMs = this.timeoutMs): Promise<{ diagnostics: Diagnostic[]; verified: boolean }> {
    const overflow = this.#diagnosticOverflow;
    const result = await this.#collectDiagnostics(uri, timeoutMs), document = this.documents.get(uri);
    if (result.verified && (this.#diagnosticLimit || overflow !== this.#diagnosticOverflow)) return { diagnostics: [], verified: false };
    if (result.verified && document &&
        readText(resolveFile(uriFile(uri)!, this.server.root)) !== document.text)
      return { diagnostics: [], verified: false };
    return result;
  }
  async #collectDiagnostics(uri: string, timeoutMs: number): Promise<{ diagnostics: Diagnostic[]; verified: boolean }> {
    const deadline = Date.now() + timeoutMs, remaining = () => Math.max(1, deadline - Date.now());
    let ready = true;
    if (this.server.name === "rust-analyzer") {
      await this.waitWorkspace(remaining());
      ready = await this.#waitRustCheck(remaining());
      if (this.diagnostics.has(uri))
        return { diagnostics: this.diagnostics.get(uri)!, verified: ready };
    }
    if (this.capabilities.diagnosticProvider) {
      try {
        const report = await this.request<{ kind: string; items?: Diagnostic[] }>(
          "textDocument/diagnostic",
          { textDocument: { uri } },
          remaining(),
        );
        if (report.kind === "full")
          return validDiagnostics(report.items) && this.#cacheDiagnostics(uri, report.items)
            ? { diagnostics: report.items, verified: ready }
            : { diagnostics: [], verified: false };
      } catch {
        /* Older servers can advertise pull diagnostics but only publish them. */
      }
    }
    try {
      return { diagnostics: await this.waitDiagnostics(uri, remaining()), verified: ready };
    } catch {
      return { diagnostics: [], verified: false };
    }
  }
  close(): Promise<void> {
    return this.#closing ??= this.#close();
  }
  async #close(): Promise<void> {
    this.#closed = true;
    try {
      if (!this.#failure) {
        try {
          await this.request("shutdown", null, 1000);
          await this.notify("exit");
        } catch {
          /* Kill below if shutdown fails. */
        }
      }
      if (this.proc.exitCode === null && this.proc.signalCode === null) {
        await Promise.race([this.exited, sleep(200, undefined, { ref: false })]);
        if (this.proc.exitCode === null && this.proc.signalCode === null) {
          this.proc.kill();
          await Promise.race([this.exited, sleep(200, undefined, { ref: false })]);
          if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill("SIGKILL");
        }
      }
      await this.exited;
    } finally {
      this.#fail(new Error("LSP client closed"));
      LspClient.active.delete(this);
    }
  }
}
