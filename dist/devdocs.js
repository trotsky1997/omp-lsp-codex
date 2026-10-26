import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "./edits.js";
import { object } from "./config.js";
const DOCSETS = {
    python: ["python", "numpy", "pandas", "scipy", "django", "flask"],
    typescript: ["typescript", "javascript", "node", "lodash"], typescriptreact: ["typescript", "javascript", "node", "lodash"],
    javascript: ["javascript", "node", "lodash", "jquery"], javascriptreact: ["javascript", "node", "lodash", "jquery"],
    rust: ["rust"], go: ["go"], c: ["c"], cpp: ["cpp"], ruby: ["ruby"], php: ["php"], kotlin: ["kotlin"],
    swift: ["swift"], elixir: ["elixir"], lua: ["lua"], haskell: ["haskell"], shellscript: ["bash"], css: ["css"], html: ["html"],
};
const FALLBACK = { python: "python~3.14", numpy: "numpy~2.4", pandas: "pandas~3", django: "django~6.1", node: "node~22", lodash: "lodash~4", ruby: "ruby~4.0", kotlin: "kotlin~1.9", elixir: "elixir~1.20", lua: "lua~5.5", haskell: "haskell~9" };
export function symbolAt(text, line, character) {
    const source = text.split("\n")[line] ?? "";
    for (const match of source.matchAll(/[A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*/g)) {
        if (match.index <= character && character < match.index + match[0].length)
            return match[0];
    }
}
async function fetchJson(key, url, deadline) {
    const path = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "cache/codex-lsp/devdocs", `${key}.json`);
    let cached;
    try {
        const envelope = object(JSON.parse(readFileSync(path, "utf8")));
        cached = envelope.data;
        if (Date.now() / 1000 - Number(envelope.fetchedAt) < 86400)
            return cached;
    }
    catch { /* Missing or invalid cache is refreshed below. */ }
    if (Date.now() >= deadline)
        return cached;
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())), headers: { Accept: "application/json", "User-Agent": "codex-lsp" } });
        if (!response.ok || Number(response.headers.get("Content-Length")) > 64 * 1024 * 1024)
            return cached;
        const reader = response.body?.getReader();
        if (!reader)
            return cached;
        const chunks = [];
        let length = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                length += value.length;
                if (length > 64 * 1024 * 1024) {
                    await reader.cancel();
                    return cached;
                }
                chunks.push(value);
            }
        }
        finally {
            reader.releaseLock();
        }
        const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        try {
            atomicWrite(path, Buffer.from(JSON.stringify({ fetchedAt: Date.now() / 1000, data })));
        }
        catch { /* Read-only cache still permits references. */ }
        return data;
    }
    catch {
        return cached;
    }
}
export function bestEntry(entries, symbol) {
    if (!Array.isArray(entries))
        return;
    const normalize = (s) => s.trim().replace(/\(\)$/, " ").trim().toLowerCase();
    const query = normalize(symbol);
    if (!query)
        return;
    return entries.filter((item) => typeof object(item).name === "string" && typeof object(item).path === "string")
        .map(item => ({ item, name: normalize(item.name) }))
        .filter(({ name }) => name === query || name.endsWith(`.${query}`) || name.endsWith(`::${query}`))
        .sort((a, b) => Number(a.name !== query) - Number(b.name !== query) || a.name.length - b.name.length)[0]?.item;
}
export function safeDocUrl(slug, path) {
    if (!/^[a-z0-9_.~+-]+$/i.test(slug) || /^[\\/]/.test(path) || /[\\\u0000-\u001f\u007f]/.test(path) || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.split("/").includes(".."))
        return;
    const url = new URL(`https://devdocs.io/${slug}/${path}`);
    if (!url.pathname.startsWith(`/${slug}/`))
        return;
    return url.href.replaceAll("(", "%28").replaceAll(")", "%29");
}
export async function findReference(language, symbol, timeoutMs = 3000) {
    const docsets = DOCSETS[language];
    if (!docsets || !symbol)
        return;
    const deadline = Date.now() + timeoutMs;
    const raw = await fetchJson("catalog", "https://devdocs.io/docs/docs.json", deadline);
    const catalog = new Map();
    for (const entry of Array.isArray(raw) ? raw : []) {
        if (typeof object(entry).slug !== "string" || !safeDocUrl(String(object(entry).slug), "index.json"))
            continue;
        const item = entry;
        const base = item.slug.split("~")[0], previous = catalog.get(base);
        if (!previous || String(item.version ?? "").localeCompare(String(previous.version ?? ""), undefined, { numeric: true }) > 0)
            catalog.set(base, item);
    }
    for (const base of docsets) {
        const resolved = catalog.get(base), slug = resolved?.slug ?? FALLBACK[base] ?? base;
        const index = await fetchJson(`index-${slug}`, `https://documents.devdocs.io/${slug}/index.json`, deadline);
        const query = resolved?.alias && symbol.startsWith(`${resolved.alias}.`) ? base + symbol.slice(resolved.alias.length) : symbol;
        const entry = bestEntry(object(index).entries, query);
        if (!entry)
            continue;
        const url = safeDocUrl(slug, entry.path);
        if (!url)
            continue;
        return `Documentation provider: DevDocs\n\n\`${entry.name.replaceAll("`", "\\`")}\`${entry.type ? ` (${entry.type})` : ""}\n\n[Open docs](${url})`;
    }
}
