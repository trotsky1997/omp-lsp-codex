import { setTimeout as delay } from "node:timers/promises";
import { appendFileSync, closeSync, fstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { encodeMessageFrame, MessageFramer } from "../../src/omp/message-framing.ts";
import { object } from "../../src/config.ts";

const [mode, tracePath] = process.argv.slice(2);
const scenario = mode === "scenario" ? JSON.parse(readFileSync(process.argv[4], "utf8")) : {};
const calls = new Map<string, number>();
const documentTexts = new Map<string, string>();
const trace = (direction: string, message: Record<string, unknown>) => appendFileSync(tracePath, JSON.stringify({ direction, ...message }) + "\n");
trace("lifecycle", { pid: process.pid });
const send = async (message: Record<string, unknown>) => {
  trace("send", message);
  const frame = encodeMessageFrame({ jsonrpc: "2.0", ...message });
  if (mode === "fragmented") {
    for (let offset = 0; offset < frame.length; offset += 7) {
      process.stdout.write(frame.subarray(offset, offset + 7));
      await delay(1);
    }
  } else process.stdout.write(frame);
};
const corruptUtf8 = (message: Record<string, unknown>) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
  const marker = body.indexOf("INVALID_UTF8");
  if (marker < 0) throw new Error("Missing UTF-8 fault marker");
  body[marker] = 0xff;
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
};
if (mode === "hang") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }
if (mode === "ast-flood") { process.on("SIGTERM", () => {}); process.stdout.write("x".repeat(4096)); setInterval(() => {}, 1000); }
const queued: Record<string, unknown>[] = [];
let callbackId: unknown;
let callbackMethod: string | undefined;
let lateId: unknown;
let indexReady = false;
const framer = new MessageFramer(Buffer.alloc(0));
for await (const chunk of process.stdin) {
  framer.push(chunk);
  for (const text of framer.drain(() => {})) {
    const message = object(JSON.parse(text)), params = object(message.params);
    trace("receive", message);
    const reply = async (result: unknown) => {
      if (scenario.corruptUtf8 === message.method) {
        corruptUtf8({ id: message.id, result });
      } else await send({ id: message.id, result });
    };
    switch (message.method) {
      case "initialize":
        if (mode === "exit-init") { process.stderr.write("fixture initialization failed\n"); process.exit(17); }
        if (mode === "stall-init") break;
        await reply({ capabilities: scenario.capabilities ?? { diagnosticProvider: mode.startsWith("pull"), hoverProvider: true } });
        break;
      case "textDocument/didChange":
        if (!scenario.diagnosticVersionFromDocument && !scenario.diagnosticsByText) break;
      case "textDocument/didOpen":
        if (mode === "scenario") {
          const document = object(params.textDocument), uri = String(document.uri);
          const changes = Array.isArray(params.contentChanges) ? params.contentChanges : [];
          const text = typeof document.text === "string" ? document.text : object(changes.at(-1)).text;
          if (typeof text === "string") documentTexts.set(uri, text);
          if (scenario.afterOpen) writeFileSync(scenario.afterOpen.file, scenario.afterOpen.text);
          const diagnostics = scenario.diagnosticsByText?.[documentTexts.get(uri) ?? ""] ?? scenario.diagnostics;
          if (diagnostics !== false) {
            const publish = () => send({ method: "textDocument/publishDiagnostics", params: { uri: document.uri, diagnostics: diagnostics ?? [], ...(scenario.diagnosticVersionFromDocument ? { version: document.version } : "diagnosticVersion" in scenario ? { version: scenario.diagnosticVersion } : {}) } });
            const diagnosticDelay = scenario.diagnosticDelayByText?.[documentTexts.get(uri) ?? ""] ?? scenario.diagnosticDelay;
            if (diagnosticDelay) setTimeout(publish, diagnosticDelay);
            else await publish();
          }
          if (scenario.serverStatus && (message.method === "textDocument/didOpen" || scenario.serverStatusOnChange)) {
            const status = () => { indexReady = true; return send({ method: "experimental/serverStatus", params: scenario.serverStatus }); };
            if (scenario.serverStatusDelay) setTimeout(status, scenario.serverStatusDelay); else await status();
          }
          for (const progress of scenario.progress ?? []) await send({ method: "$/progress", params: progress });
        }
        break;
      case "fixture/echo": await reply(params); break;
      case "fixture/reverse":
        queued.push(message);
        if (queued.length === 2) for (const item of queued.splice(0).reverse()) await send({ id: item.id, result: item.params });
        break;
      case "fixture/collision":
        await send({ id: message.id, method: "workspace/configuration", params: { items: [{ section: "python.analysis" }] } });
        await reply("original response");
        break;
      case "fixture/stall": break;
      case "fixture/late": lateId = message.id; break;
      case "$/cancelRequest":
        if (lateId !== undefined && params.id === lateId) await send({ id: lateId, result: "late response" });
        break;
      case "fixture/exit": process.stderr.write("fixture crash detail\n"); process.exit(23);
      case "fixture/close-stdout": {
        // Close every stdout pipe handle so EOF can precede process exit.
        const stdout = fstatSync(1);
        for (const descriptor of readdirSync("/dev/fd")) {
          try {
            const fd = Number(descriptor), info = fstatSync(fd);
            if (info.ino === stdout.ino && info.dev === stdout.dev) closeSync(fd);
          } catch { /* The directory listing can include its own closed descriptor. */ }
        }
        break;
      }
      case "fixture/bad-json": process.stdout.write("Content-Length: 1\r\n\r\n{"); break;
      case "fixture/bad-length": process.stdout.write("Content-Length: -1\r\n\r\n"); break;
      case "fixture/bad-utf8": corruptUtf8({ id: message.id, result: "INVALID_UTF8" }); break;
      case "fixture/stderr": process.stderr.write("x".repeat(20000) + "\nfixture stderr tail\n"); await reply(true); break;
      case "fixture/notification": await send({ method: params.method, params: params.params }); await reply(true); break;
      case "fixture/callback":
        callbackId = message.id;
        await send({ id: "server-request", method: params.method, params: params.params });
        break;
      case "textDocument/diagnostic":
        if (scenario.stallMethods?.includes(message.method)) break;
        if (mode === "pull-malformed") await reply({ kind: "full", items: [null] });
        else if (mode === "pull-missing") await reply({ kind: "full" });
        else if (mode === "pull-throws") await send({ id: message.id, error: { code: -32601, message: "Use push diagnostics" } });
        else await reply({ kind: "full", items: scenario.diagnosticsByText?.[documentTexts.get(String(object(params.textDocument).uri)) ?? ""] || [] });
        break;
      case "shutdown": if (mode !== "hang") await reply(null); break;
      case "exit": if (mode !== "hang") process.exit(0); break;
      default:
        if (message.id === "server-request" && !message.method) {
          const error = callbackMethod ? scenario.errors?.[callbackMethod] : undefined;
          await send(error ? { id: callbackId, error } : { id: callbackId, result: message });
        }
        else if (mode === "scenario" && message.id !== undefined) {
          const method = String(message.method), count = calls.get(method) ?? 0;
          if (scenario.stallMethods?.includes(method)) break;
          calls.set(method, count + 1);
          const mutation = scenario.beforeResponse?.[method];
          if (mutation) writeFileSync(mutation.file, mutation.text);
          if (scenario.callbacks?.[method]) {
            callbackId = message.id;
            callbackMethod = method;
            await send({ id: "server-request", ...scenario.callbacks[method] });
          } else if (count < (scenario.contentModified?.[method] ?? 0))
            await send({ id: message.id, error: { code: -32801, message: "Content Modified" } });
          else {
            const item = object(params.item ?? params), key = String(object(item.data).key ?? item.name ?? item.label);
            const position = object(params.position), point = `${position.line}:${position.character}`;
            const error = scenario.errorsByItem?.[method]?.[key] ?? scenario.errors?.[method];
            if (error) await send({ id: message.id, error });
            else if (scenario.requiresIndex && method === "textDocument/references" && !indexReady) await reply([]);
            else if (scenario.manualCodeActions && method === "textDocument/codeAction" && object(params.context).triggerKind !== 1) await reply([]);
            else await reply(scenario.responsesByItem?.[method]?.[key] ?? scenario.responsesByPosition?.[method]?.[point] ?? scenario.responsesByText?.[method]?.[documentTexts.get(String(object(params.textDocument).uri)) ?? ""] ?? scenario.responses?.[method] ?? null);
          }
        }
    }
  }
}
