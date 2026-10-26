import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MessageFramer, encodeMessageFrame } from "../src/omp/message-framing.ts";
import { fileUri, object } from "../src/config.ts";
import { LspClient } from "../src/client.ts";
import { applyWorkspaceEdit } from "../src/edits.ts";
import { position } from "../src/commands.ts";
import { bestEntry, safeDocUrl } from "../src/devdocs.ts";
import type { TextEdit } from "../src/omp/types.ts";

async function fixtureServer(): Promise<void> {
  const framer = new MessageFramer(Buffer.alloc(0));
  const send = (message: unknown) => {
    process.stdout.write(encodeMessageFrame(message));
  };
  let initialize: Record<string, unknown> = {},
    initializedId: number | string = 0,
    uri = "",
    ready = false;
  for await (const chunk of process.stdin) {
    framer.push(chunk);
    for (const text of framer.drain(() => {})) {
      const message = object(JSON.parse(text)),
        params = object(message.params);
      const reply = (result: unknown) => send({ jsonrpc: "2.0", id: message.id, result });
      switch (message.method) {
        case "initialize":
          initialize = params;
          initializedId = message.id as number;
          send({
            jsonrpc: "2.0",
            id: initializedId,
            method: "workspace/configuration",
            params: { items: [{ section: "python.analysis" }] },
          });
          break;
        case "initialized":
          break;
        case "textDocument/didOpen":
          uri = String(object(params.textDocument).uri);
          send({
            jsonrpc: "2.0",
            id: "write-attempt",
            method: "workspace/applyEdit",
            params: {
              edit: {
                changes: {
                  [uri]: [
                    {
                      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                      newText: "UNREQUESTED",
                    },
                  ],
                },
              },
            },
          });
          setTimeout(() => {
            ready = true;
            send({
              jsonrpc: "2.0",
              method: "textDocument/publishDiagnostics",
              params: { uri, diagnostics: [] },
            });
          }, 30);
          break;
        case "textDocument/references":
          reply(
            ready
              ? [
                  {
                    uri,
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                  },
                ]
              : [],
          );
          break;
        case "textDocument/rename":
          reply(
            params.newName === "empty"
              ? {}
              : {
                  changes: {
                    [uri]: [
                      {
                        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                        newText: params.newName,
                      },
                    ],
                  },
                },
          );
          break;
        case "textDocument/codeAction":
          reply([
            {
              title: "Suggested edit",
              edit: {
                changes: {
                  [uri]: [
                    {
                      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                      newText: "CHANGED",
                    },
                  ],
                },
              },
            },
          ]);
          break;
        case "shutdown":
          reply(null);
          break;
        case "exit":
          return;
        default:
          if (!message.method && message.id === initializedId) {
            const workspace = object(object(initialize.capabilities).workspace);
            assert.equal(object((message.result as unknown[])[0]).typeCheckingMode, "strict");
            send({
              jsonrpc: "2.0",
              id: initializedId,
              result: {
                capabilities: {
                  referencesProvider: true,
                  renameProvider: true,
                  fixture: {
                    readOnly: !workspace.applyEdit,
                    diagnostics: object(
                      object(object(initialize.capabilities).textDocument).diagnostic,
                    ).dynamicRegistration,
                  },
                },
              },
            });
          } else if (!message.method && message.id === "write-attempt")
            assert.equal(object(message.result).applied, false);
          else if (message.id !== undefined && message.method) reply(null);
      }
    }
  }
}

async function checks(): Promise<void> {
  const temp = mkdtempSync(join(tmpdir(), "codex-lsp ts ")),
    root = join(temp, "project with spaces");
  mkdirSync(root);
  const path = join(root, "source.py"),
    cli = join(dirname(dirname(fileURLToPath(import.meta.url))), "src/cli.js");
  const edit: TextEdit = {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
    newText: "renamed",
  };
  try {
    writeFileSync(path, "hello = 1\n");
    writeFileSync(join(root, "pyproject.toml"), "");
    mkdirSync(join(root, ".codex"));
    const server = {
      command: process.execPath,
      args: [fileURLToPath(import.meta.url), "--server"],
      fileTypes: [".py"],
      rootMarkers: ["pyproject.toml"],
      settings: { python: { analysis: { typeCheckingMode: "strict" } } },
    };
    writeFileSync(join(root, ".codex/lsp.json"), JSON.stringify({ servers: { pyright: server } }));
    const frame = encodeMessageFrame({ text: "中文😀" }),
      framer = new MessageFramer(Buffer.alloc(0));
    const decoded: string[] = [];
    for (const byte of frame) {
      framer.push(Uint8Array.of(byte));
      decoded.push(...framer.drain(() => {}));
    }
    assert.deepEqual(
      decoded.map((text) => JSON.parse(text)),
      [{ text: "中文😀" }],
    );
    const malformed = new MessageFramer(Buffer.from("Content-Length: -1\r\n\r\n"));
    assert.throws(() => [...malformed.drain(() => {})]);
    assert.equal(bestEntry([{ name: "Option::is_none", path: "option.html" }], "none"), undefined);
    assert.equal(
      bestEntry([{ name: "Option::is_none", path: "option.html" }], "is_none")?.path,
      "option.html",
    );
    assert.equal(safeDocUrl("rust", "https://external.invalid/"), undefined);
    assert.equal(safeDocUrl("rust", "../escape"), undefined);
    const emoji = join(root, "emoji.ts");
    writeFileSync(emoji, 'const emoji = "😀"; hello(hello);\n');
    assert.equal(
      (await position(emoji, readFileSync(emoji, "utf8"), { line: 1, symbol: "hello#2" }))
        .character,
      26,
    );
    await assert.rejects(
      position(emoji, readFileSync(emoji, "utf8"), { line: 1, symbol: "absent" }),
    );
    const client = await LspClient.start(
      { ...server, name: "pyright", root, resolvedCommand: process.execPath },
      1000,
    );
    try {
      assert.deepEqual(client.capabilities.fixture, { readOnly: true, diagnostics: false });
      const { uri } = await client.open(path);
      await client.ready(uri);
      const refs = await client.request<unknown[]>("textDocument/references", {
        textDocument: { uri },
      });
      assert.equal(refs.length, 1);
      assert.equal(readFileSync(path, "utf8"), "hello = 1\n");
    } finally {
      await client.close();
    }
    async function invoke(
      args: string[],
      input?: unknown,
    ): Promise<{ exit: number; data: Record<string, unknown> }> {
      const proc = spawnSync(process.execPath, [cli, ...args], {
        cwd: root,
        input: input ? JSON.stringify(input) : undefined,
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: "" },
      });
      assert.equal(proc.error, undefined, proc.error?.message);
      assert.equal(proc.stderr, "");
      return { exit: proc.status ?? -1, data: object(JSON.parse(proc.stdout)) };
    }
    const refs = await invoke(["references", "--file", path, "--symbol", "hello", "--json"]);
    assert.equal(refs.exit, 0);
    assert.equal((refs.data.locations as unknown[]).length, 1);
    const preview = await invoke([
      "rename",
      "--file",
      path,
      "--symbol",
      "hello",
      "--new-name",
      "renamed",
      "--json",
    ]);
    assert.equal(preview.exit, 0);
    assert.equal(preview.data.applied, false);
    assert.equal(readFileSync(path, "utf8"), "hello = 1\n");
    const applied = await invoke([
      "rename",
      "--file",
      path,
      "--symbol",
      "hello",
      "--new-name",
      "renamed",
      "--apply",
      "--json",
    ]);
    assert.equal(applied.exit, 0);
    assert.equal(applied.data.applied, true);
    assert.equal(readFileSync(path, "utf8"), "renamed = 1\n");
    writeFileSync(path, "hello = 1\n");
    const action = await invoke([
      "code-actions",
      "--file",
      path,
      "--symbol",
      "hello",
      "--query",
      "0",
      "--apply",
      "--json",
    ]);
    assert.equal(action.exit, 0);
    assert.equal(action.data.applied, true);
    assert.equal(readFileSync(path, "utf8"), "CHANGED = 1\n");
    writeFileSync(path, "hello = 1\n");
    const empty = await invoke([
      "rename",
      "--file",
      path,
      "--symbol",
      "hello",
      "--new-name",
      "empty",
      "--apply",
      "--json",
    ]);
    assert.equal(empty.exit, 2);
    assert.equal(empty.data.success, false);
    assert.equal(readFileSync(path, "utf8"), "hello = 1\n");
    const raw = await invoke([
      "request",
      "--file",
      path,
      "--method",
      "textDocument/codeAction",
      "--payload",
      JSON.stringify({ textDocument: { uri: fileUri(path) } }),
      "--json",
    ]);
    assert.equal(raw.exit, 0);
    assert.equal(raw.data.applied, false);
    assert.equal(readFileSync(path, "utf8"), "hello = 1\n");
    const blocked = await invoke([
      "request",
      "--file",
      path,
      "--method",
      "workspace/executeCommand",
      "--json",
    ]);
    assert.equal(blocked.exit, 2);
    assert.equal(blocked.data.success, false);
    const hook = await invoke(["hook", "stop"], { stop_hook_active: true });
    assert.equal(hook.data.continue, true);
    const outside = join(temp, "outside.py");
    writeFileSync(outside, "hello outside\n");
    await assert.rejects(
      applyWorkspaceEdit(
        { changes: { [fileUri(path)]: [edit], [fileUri(outside)]: [edit] } },
        root,
      ),
    );
    assert.equal(readFileSync(outside, "utf8"), "hello outside\n");
    await assert.rejects(
      applyWorkspaceEdit(
        { changes: { [fileUri(path)]: [edit, { ...edit, newText: "overlap" }] } },
        root,
      ),
    );
    assert.equal(readFileSync(path, "utf8"), "hello = 1\n");
    chmodSync(path, 0o666);
    await applyWorkspaceEdit({ changes: { [fileUri(path)]: [edit] } }, root);
    assert.equal(readFileSync(path, "utf8"), "renamed = 1\n");
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o666);
    writeFileSync(path, "\uFEFFhello\r\n");
    await applyWorkspaceEdit(
      {
        changes: {
          [fileUri(path)]: [
            {
              range: { start: { line: 0, character: 1 }, end: { line: 0, character: 6 } },
              newText: "renamed",
            },
          ],
        },
      },
      root,
    );
    assert.equal(readFileSync(path, "utf8"), "\uFEFFrenamed\r\n");
    console.log("Protocol, readiness, read-only preview, edit safety, hooks and CLI checks passed");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
if (process.argv.includes("--server")) await fixtureServer();
else await checks();
