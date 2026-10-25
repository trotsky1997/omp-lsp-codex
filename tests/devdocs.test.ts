import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { basename } from "node:path";
import * as edits from "../src/edits.ts";
import { findReference } from "../src/devdocs.ts";

const cache = new Map<string, string>(), urls: string[] = [], writes: string[] = [];
const originalRead = fs.readFileSync;
const isCache = (path: unknown) => typeof path === "string" && path.replaceAll("\\", "/").includes("/cache/codex-lsp/devdocs/");
const index = { entries: [{ name: "Option::is_none", path: "std/option.html#method.is_none" }] };
const defaults = (url: string): Response => Response.json(url.endsWith("docs/docs.json") ? [{ slug: "rust", version: "1" }] : index);
let respond: (url: string) => Response | Promise<Response> = defaults, writeFails = false;
const readSpy = spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, options?: BufferEncoding) => {
  if (!isCache(path)) return Reflect.apply(originalRead, fs, [path, options]);
  const data = cache.get(basename(String(path)));
  if (data === undefined) throw new Error("Missing test cache");
  return data;
}) as typeof fs.readFileSync);
const writeSpy = spyOn(edits, "atomicWrite").mockImplementation((path, bytes) => {
  writes.push(path);
  if (writeFails) throw new Error("injected read-only cache");
  cache.set(basename(path), Buffer.from(bytes).toString("utf8"));
});
const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  urls.push(url);
  return respond(url);
}) as typeof fetch);
afterEach(() => { cache.clear(); urls.length = 0; writes.length = 0; respond = defaults; writeFails = false; });
afterAll(() => { readSpy.mockRestore(); writeSpy.mockRestore(); fetchSpy.mockRestore(); });
const cached = (data: unknown, fresh = true) => JSON.stringify({ fetchedAt: Date.now() / 1000 - (fresh ? 0 : 90000), data });

test("DevDocs: fresh cached references require no network or writes", async () => {
  cache.set("catalog.json", cached([{ slug: "rust" }])); cache.set("index-rust.json", cached(index));
  expect(await findReference("rust", "is_none")).toContain("std/option.html#method.is_none");
  expect(urls).toEqual([]); expect(writes).toEqual([]);
});
test("DevDocs: stale cached references survive network failure", async () => {
  cache.set("catalog.json", cached([{ slug: "rust" }], false)); cache.set("index-rust.json", cached(index, false));
  respond = () => { throw new Error("injected offline network"); };
  expect(await findReference("rust", "is_none")).toContain("Option::is_none");
  expect(urls.length).toBe(2); expect(writes).toEqual([]);
});
test("DevDocs: corrupt cache is refreshed, writes stay inside the cache", async () => {
  cache.set("catalog.json", "{");
  expect(await findReference("rust", "is_none")).toContain("Documentation provider: DevDocs");
  expect(urls.length).toBe(2); expect(writes.length).toBe(2);
  expect(writes.every(isCache)).toBe(true);
  expect(JSON.parse(cache.get("catalog.json")!).data[0].slug).toBe("rust");
});
test("DevDocs: read-only cache still permits a valid reference", async () => {
  writeFails = true;
  expect(await findReference("rust", "is_none")).toContain("Option::is_none");
  expect(writes.length).toBe(2);
});
test.each(["HTTP error", "oversized response", "invalid JSON"])("DevDocs: %s cannot poison the cache", async (fault) => {
  respond = () => fault === "HTTP error" ? new Response("no", { status: 503 }) : fault === "oversized response" ? new Response("{}", { headers: { "Content-Length": "67108865" } }) : new Response("{");
  expect(await findReference("rust", "is_none")).toBeUndefined();
  expect(writes).toEqual([]);
});
test("DevDocs: expired deadline performs no network requests", async () => {
  expect(await findReference("rust", "is_none", 0)).toBeUndefined();
  expect(urls).toEqual([]);
});
test("DevDocs: invalid catalog slugs never escape the cache or select a URL", async () => {
  respond = (url) => url.endsWith("docs/docs.json") ? Response.json([{ slug: "rust~../../../../injected", version: "999" }]) : Response.json(index);
  expect(await findReference("rust", "is_none")).toContain("Option::is_none");
  expect(urls).toEqual(["https://devdocs.io/docs/docs.json", "https://documents.devdocs.io/rust/index.json"]);
  expect(writes.every(isCache)).toBe(true);
});
test("DevDocs: numeric version selection chooses 1.10 over 1.9", async () => {
  respond = (url) => url.endsWith("docs/docs.json") ? Response.json([{ slug: "rust~1.9", version: "1.9" }, { slug: "rust~1.10", version: "1.10" }]) : Response.json(index);
  expect(await findReference("rust", "is_none")).toContain("/rust~1.10/");
  expect(urls[1]).toBe("https://documents.devdocs.io/rust~1.10/index.json");
});
test("DevDocs: unsupported languages and unrelated symbols return no reference", async () => {
  expect(await findReference("unknown-language", "is_none")).toBeUndefined(); expect(urls).toEqual([]);
  expect(await findReference("rust", "none")).toBeUndefined();
});
