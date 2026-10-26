import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import fs from "node:fs";
import type { PathLike } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { findReference } from "../src/devdocs.ts";

const urls: string[] = [];
const index = { entries: [{ name: "Option::is_none", path: "std/option.html#method.is_none" }] };
const defaults = (url: string): Response => Response.json(url.endsWith("docs/docs.json") ? [{ slug: "rust", version: "1" }] : index);
let respond: (url: string) => Response | Promise<Response> = defaults;
let root = "", previousCodexHome: string | undefined;
const fetchSpy = mock.method(globalThis, "fetch", (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  urls.push(url);
  return respond(url);
}) as typeof fetch);
beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "codex-lsp devdocs "));
  process.env.CODEX_HOME = root;
  mkdirSync(cacheDir(), { recursive: true });
  urls.length = 0;
  respond = defaults;
});
afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  rmSync(root, { recursive: true, force: true });
});
after(() => fetchSpy.mock.restore());
const cacheDir = () => join(root, "cache/codex-lsp/devdocs");
const cachePath = (key: string) => join(cacheDir(), `${key}.json`);
const cached = (data: unknown, fresh = true) => JSON.stringify({ fetchedAt: Date.now() / 1000 - (fresh ? 0 : 90000), data });
const seed = (key: string, data: string) => writeFileSync(cachePath(key), data);

test("DevDocs: fresh cached references require no network or writes", async () => {
  seed("catalog", cached([{ slug: "rust" }])); seed("index-rust", cached(index));
  const before = readFileSync(cachePath("catalog"));
  assert.ok(String(await findReference("rust", "is_none")).includes("std/option.html#method.is_none"));
  assert.deepStrictEqual(urls, []); assert.deepStrictEqual(readFileSync(cachePath("catalog")), before);
});
test("DevDocs: stale cached references survive network failure", async () => {
  seed("catalog", cached([{ slug: "rust" }], false)); seed("index-rust", cached(index, false));
  respond = () => { throw new Error("injected offline network"); };
  assert.ok(String(await findReference("rust", "is_none")).includes("Option::is_none"));
  assert.strictEqual(urls.length, 2);
});
test("DevDocs: corrupt cache is refreshed and writes stay inside the cache", async () => {
  seed("catalog", "{");
  assert.ok(String(await findReference("rust", "is_none")).includes("Documentation provider: DevDocs"));
  assert.strictEqual(urls.length, 2);
  assert.strictEqual(JSON.parse(readFileSync(cachePath("catalog"), "utf8")).data[0].slug, "rust");
  assert.strictEqual(JSON.parse(readFileSync(cachePath("index-rust"), "utf8")).data.entries[0].name, "Option::is_none");
});
test("DevDocs: read-only cache still permits a valid reference", async () => {
  const open = fs.openSync;
  const spy = mock.method(fs, "openSync", ((path: PathLike, ...args: unknown[]) => {
    if (String(path).includes("/cache/codex-lsp/devdocs/")) throw new Error("injected read-only cache");
    return Reflect.apply(open, fs, [path, ...args]);
  }) as typeof fs.openSync);
  syncBuiltinESMExports();
  try {
    assert.ok(String(await findReference("rust", "is_none")).includes("Option::is_none"));
    assert.deepStrictEqual(urls, ["https://devdocs.io/docs/docs.json", "https://documents.devdocs.io/rust/index.json"]);
  } finally { spy.mock.restore(); syncBuiltinESMExports(); }
});
for (const caseValue of (["HTTP error", "oversized response", "invalid JSON"] as const)) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = async fault => {
    respond = () => fault === "HTTP error" ? new Response("no", { status: 503 }) : fault === "oversized response" ? new Response("{}", { headers: { "Content-Length": "67108865" } }) : new Response("{");
    assert.strictEqual(await findReference("rust", "is_none"), undefined);
    assert.strictEqual(fs.existsSync(cachePath("catalog")), false);
  };
  test(`DevDocs: ${caseValue} cannot poison the cache`, () => runCase(caseValue));
}
test("DevDocs: expired deadline performs no network requests", async () => {
  assert.strictEqual(await findReference("rust", "is_none", 0), undefined);
  assert.deepStrictEqual(urls, []);
});
test("DevDocs: invalid catalog slugs never escape the cache or select a URL", async () => {
  respond = url => url.endsWith("docs/docs.json") ? Response.json([{ slug: "rust~../../../../injected", version: "999" }]) : Response.json(index);
    assert.ok(String(await findReference("rust", "is_none")).includes("Option::is_none"));
  assert.deepStrictEqual(urls, ["https://devdocs.io/docs/docs.json", "https://documents.devdocs.io/rust/index.json"]);
  assert.strictEqual(fs.readdirSync(cacheDir()).every(name => name.endsWith(".json")), true);
});
test("DevDocs: numeric version selection chooses 1.10 over 1.9", async () => {
  respond = url => url.endsWith("docs/docs.json") ? Response.json([{ slug: "rust~1.9", version: "1.9" }, { slug: "rust~1.10", version: "1.10" }]) : Response.json(index);
  assert.ok(String(await findReference("rust", "is_none")).includes("/rust~1.10/"));
  assert.strictEqual(urls[1], "https://documents.devdocs.io/rust~1.10/index.json");
});
test("DevDocs: unsupported languages and unrelated symbols return no reference", async () => {
  assert.strictEqual(await findReference("unknown-language", "is_none"), undefined); assert.deepStrictEqual(urls, []);
  assert.strictEqual(await findReference("rust", "none"), undefined);
});
