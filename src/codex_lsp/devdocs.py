from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from typing import Any

DOCSETS_BY_LANGUAGE = {
    "python": ["python", "numpy", "pandas", "scipy", "django", "flask"],
    "typescript": ["typescript", "javascript", "node", "lodash"],
    "typescriptreact": ["typescript", "javascript", "node", "lodash"],
    "javascript": ["javascript", "node", "lodash", "jquery"],
    "javascriptreact": ["javascript", "node", "lodash", "jquery"],
    "rust": ["rust"], "go": ["go"], "c": ["c"], "cpp": ["cpp"],
    "ruby": ["ruby"], "php": ["php"], "kotlin": ["kotlin"],
    "swift": ["swift"], "elixir": ["elixir"], "lua": ["lua"],
    "haskell": ["haskell"], "shellscript": ["bash"], "css": ["css"],
    "html": ["html"],
}
FALLBACK_SLUGS = {
    "python": "python~3.14", "numpy": "numpy~2.4", "pandas": "pandas~3",
    "scipy": "scipy", "django": "django~6.1", "flask": "flask",
    "typescript": "typescript", "javascript": "javascript", "node": "node~22",
    "lodash": "lodash~4", "jquery": "jquery", "rust": "rust", "go": "go",
    "c": "c", "cpp": "cpp", "ruby": "ruby~4.0", "php": "php",
    "kotlin": "kotlin~1.9", "swift": "swift", "elixir": "elixir~1.20",
    "lua": "lua~5.5", "haskell": "haskell~9", "bash": "bash",
    "css": "css", "html": "html",
}
CACHE_TTL = 24 * 60 * 60
MAX_RESPONSE_BYTES = 64 * 1024 * 1024


def symbol_at_position(text: str, line: int, character: int) -> str | None:
    lines = text.splitlines()
    if line < 0 or line >= len(lines):
        return None
    source_line = lines[line]
    used = 0
    index = 0
    for index, char in enumerate(source_line):
        if used >= character:
            break
        used += 2 if ord(char) > 0xFFFF else 1
        if used > character:
            return None
    else:
        index = len(source_line)
    pattern = re.compile(r"[A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*")
    for match in pattern.finditer(source_line):
        if match.start() <= index < match.end():
            return match.group(0)
    return None


def _cache_path(key: str) -> Path:
    codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    return codex_home / "cache" / "codex-lsp" / "devdocs" / f"{key}.json"


def _fetch_json(key: str, url: str, timeout: float) -> Any:
    cache_path = _cache_path(key)
    cached = None
    try:
        envelope = json.loads(cache_path.read_text(encoding="utf-8"))
        cached = envelope.get("data")
        if time.time() - float(envelope["fetchedAt"]) < CACHE_TTL:
            return cached
    except (OSError, ValueError, KeyError, TypeError):
        pass

    request = Request(url, headers={"Accept": "application/json", "User-Agent": "Mozilla/5.0 codex-lsp"})
    try:
        with urlopen(request, timeout=timeout) as response:
            if int(response.headers.get("Content-Length", 0)) > MAX_RESPONSE_BYTES:
                return cached
            payload = response.read(MAX_RESPONSE_BYTES + 1)
        if len(payload) > MAX_RESPONSE_BYTES:
            return cached
        data = json.loads(payload)
    except (OSError, URLError, TimeoutError, ValueError, json.JSONDecodeError):
        return cached

    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps({"fetchedAt": time.time(), "data": data}), encoding="utf-8")
    except OSError:
        pass
    return data


def _version_key(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in re.findall(r"\d+", value))


def _catalog(timeout: float) -> dict[str, dict[str, str | None]]:
    raw = _fetch_json("catalog", "https://devdocs.io/docs/docs.json", timeout)
    result: dict[str, dict[str, str | None]] = {}
    if not isinstance(raw, list):
        return result
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get("slug"), str):
            continue
        base = item["slug"].split("~", 1)[0]
        previous = result.get(base)
        version = str(item.get("version") or "")
        previous_version = str(previous.get("version") or "") if previous else ""
        if previous and _version_key(version) <= _version_key(previous_version):
            continue
        alias = item.get("alias")
        result[base] = {
            "slug": item["slug"],
            "alias": alias if isinstance(alias, str) else None,
            "version": version,
        }
    return result


def _normalize_symbol(value: str) -> str:
    return value.strip().removesuffix("()").lower()


def _best_entry(entries: Any, symbol: str) -> dict[str, str] | None:
    query = _normalize_symbol(symbol)
    if not query or not isinstance(entries, list):
        return None
    ranked: list[tuple[int, int, dict[str, str]]] = []
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("name"), str) or not isinstance(entry.get("path"), str):
            continue
        name = _normalize_symbol(entry["name"])
        score = 0 if name == query else 1 if name.endswith(f".{query}") else 2 if query in name else 99
        if score < 99:
            ranked.append((score, len(name), entry))
    return min(ranked, default=(0, 0, None), key=lambda item: item[:2])[2]


def _safe_doc_url(slug: str, entry_path: str) -> str | None:
    parsed = urlsplit(entry_path)
    if parsed.scheme or parsed.netloc or entry_path.startswith(("/", "\\")) or ".." in entry_path.split("/"):
        return None
    return f"https://devdocs.io/{slug}/{entry_path}"


def find_reference(language_id: str, symbol: str, timeout: float = 3) -> str | None:
    docsets = DOCSETS_BY_LANGUAGE.get(language_id, [])
    if not docsets or not symbol:
        return None
    catalog = _catalog(timeout)
    for base in docsets:
        resolved = catalog.get(base, {})
        slug = resolved.get("slug") or FALLBACK_SLUGS.get(base)
        if not isinstance(slug, str):
            continue
        entries = _fetch_json(f"index-{slug}", f"https://documents.devdocs.io/{slug}/index.json", timeout)
        alias = resolved.get("alias")
        query = symbol
        if isinstance(alias, str) and "." in query and query.split(".", 1)[0] == alias:
            query = base + query[len(alias):]
        entry = _best_entry(entries.get("entries") if isinstance(entries, dict) else None, query)
        if not entry:
            continue
        url = _safe_doc_url(slug, entry["path"])
        if not url:
            continue
        title = entry["name"].replace("`", "\\`")
        kind = entry.get("type")
        type_label = f" ({kind})" if isinstance(kind, str) and kind else ""
        return f"Documentation provider: DevDocs\n\n`{title}`{type_label}\n\n[Open docs]({url})"
    return None
