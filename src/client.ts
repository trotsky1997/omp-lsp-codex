import { basename } from "node:path";
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
import { fileUri, languageId, object, readText, type ObjectValue, type Server } from "./config.ts";
import { version } from "../package.json";

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

// Extracted from OMP's async stdio client; the standalone CLI owns one process per invocation.
export class LspClient {
  static readonly active = new Set<LspClient>();
  readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly diagnostics = new Map<string, Diagnostic[]>();
  readonly progress = new Set<string>();
  readonly progressSeen = new Set<string>();
  capabilities: ObjectValue = {};
  serverStatus?: ServerStatus;
  applyEdit?: (edit: WorkspaceEdit) => Promise<void>;
  #pending = new Map<LspJsonRpcId, Pending>();
  #listeners = new Set<() => void>();
  #requestId = 0;
  #writeQueue: Promise<void> = Promise.resolve();
  #stderr = "";
  #failure?: Error;
  #closed = false;

  constructor(
    readonly server: Server,
    readonly timeoutMs: number,
    readonly allowApply = false,
  ) {
    const command = [
      server.resolvedCommand,
      ...(server.args ?? []).map((arg) => (arg === "$PID" ? String(process.pid) : arg)),
    ];
    this.proc = Bun.spawn(command, {
      cwd: server.root,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" },
    });
    LspClient.active.add(this);
    void this.#readMessages();
    void this.#readStderr();
    void this.proc.exited.then((code) =>
      this.#fail(
        new Error(
          `${server.name} exited (${code})${this.#stderr.trim() ? `: ${this.#stderr.trim()}` : ""}`,
        ),
      ),
    );
  }

  static async start(server: Server, timeoutMs: number, allowApply = false): Promise<LspClient> {
    const client = new LspClient(server, timeoutMs, allowApply);
    const capabilities = structuredClone(CLIENT_CAPABILITIES);
    capabilities.workspace.applyEdit = allowApply;
    capabilities.workspace.workspaceEdit.resourceOperations = [];
    capabilities.textDocument.diagnostic.dynamicRegistration = false;
    try {
      const result = await client.request<{ capabilities?: ObjectValue }>(
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
      await client.notify("initialized", {});
      await client.notify("workspace/didChangeConfiguration", { settings: server.settings ?? {} });
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async #send(message: Message): Promise<void> {
    const write = this.#writeQueue.then(async () => {
      if (this.#failure) throw this.#failure;
      this.proc.stdin.write(encodeMessageFrame(message));
      await this.proc.stdin.flush();
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
        reject(new Error(`LSP request ${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
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
                new Error(`LSP error ${message.error.code}: ${message.error.message}`),
              );
            else pending?.resolve(message.result);
          }
        }
      }
      if (!this.#closed) {
        await Promise.race([this.proc.exited, Bun.sleep(100)]);
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
      typeof params.uri === "string" &&
      Array.isArray(params.diagnostics)
    ) {
      this.diagnostics.set(params.uri, params.diagnostics as Diagnostic[]);
    } else if (message.method === "experimental/serverStatus") {
      this.serverStatus = params as ServerStatus;
    } else if (message.method === "$/progress") {
      const token = String(params.token),
        value = object(params.value);
      this.progressSeen.add(token);
      if (value.kind === "end") this.progress.delete(token);
      else this.progress.add(token);
    } else if (["window/logMessage", "window/showMessage"].includes(message.method)) {
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
    if (check()) return;
    if (this.#failure) throw this.#failure;
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
        reject(new Error(`Timed out waiting for ${this.server.name} ${label}`));
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
    const text = readText(path),
      uri = fileUri(path);
    await this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: languageId(this.server, path), version: 1, text },
    });
    return { uri, text };
  }
  async waitDiagnostics(uri: string, timeoutMs = this.timeoutMs): Promise<Diagnostic[]> {
    await this.#waitUntil(() => this.diagnostics.has(uri), timeoutMs, "file analysis");
    return this.diagnostics.get(uri)!;
  }
  async waitWorkspace(timeoutMs = this.timeoutMs): Promise<void> {
    await this.#waitUntil(() => !!this.serverStatus?.quiescent, timeoutMs, "workspace analysis");
    if (this.serverStatus?.health !== "ok")
      throw new Error(
        `rust-analyzer workspace is incomplete: ${this.serverStatus?.message ?? this.serverStatus?.health}`,
      );
  }
  async ready(uri: string): Promise<void> {
    if (this.server.name === "rust-analyzer") await this.waitWorkspace();
    if (["pyright", "basedpyright"].includes(this.server.name)) await this.waitDiagnostics(uri);
  }
  async #waitRustCheck(): Promise<boolean> {
    const deadline = Date.now() + this.timeoutMs;
    const relevant = (token: string) => /^(rustAnalyzer|rust-analyzer)\//.test(token);
    while (Date.now() < deadline) {
      if ([...this.progressSeen].some(relevant) && ![...this.progress].some(relevant)) {
        await Bun.sleep(100);
        if (![...this.progress].some(relevant)) return true;
      }
      await Bun.sleep(50);
    }
    return false;
  }
  async getDiagnostics(uri: string): Promise<{ diagnostics: Diagnostic[]; verified: boolean }> {
    let ready = true;
    if (this.server.name === "rust-analyzer") {
      await this.waitWorkspace();
      ready = await this.#waitRustCheck();
      if (this.diagnostics.has(uri))
        return { diagnostics: this.diagnostics.get(uri)!, verified: ready };
    }
    if (this.capabilities.diagnosticProvider) {
      try {
        const report = await this.request<{ kind: string; items?: Diagnostic[] }>(
          "textDocument/diagnostic",
          { textDocument: { uri } },
        );
        if (report.kind === "full") return { diagnostics: report.items ?? [], verified: ready };
      } catch {
        /* Older servers can advertise pull diagnostics but only publish them. */
      }
    }
    try {
      return { diagnostics: await this.waitDiagnostics(uri), verified: ready };
    } catch {
      return { diagnostics: [], verified: false };
    }
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    LspClient.active.delete(this);
    if (!this.#failure) {
      try {
        await this.request("shutdown", null, 1000);
        await this.notify("exit");
      } catch {
        /* Kill below if shutdown fails. */
      }
    }
    if (this.proc.exitCode === null) {
      await Promise.race([this.proc.exited, Bun.sleep(200)]);
      if (this.proc.exitCode === null) {
        this.proc.kill();
        await Promise.race([this.proc.exited, Bun.sleep(200)]);
        if (this.proc.exitCode === null) this.proc.kill("SIGKILL");
      }
      await this.proc.exited;
    }
    this.#fail(new Error("LSP client closed"));
  }
}
