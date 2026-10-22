from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from codex_lsp import __version__
from codex_lsp.devdocs import find_reference, symbol_at_position
from codex_lsp.protocol import LspClient, LspError


DEFAULTS = Path(__file__).with_name("defaults.json")
MAX_FILES = 200
MAX_FILE_BYTES = 16 * 1024 * 1024
HOVER_RETRY_SECONDS = 6.0
READ_ONLY_METHODS = {
    "textDocument/definition",
    "textDocument/declaration",
    "textDocument/typeDefinition",
    "textDocument/implementation",
    "textDocument/references",
    "textDocument/hover",
    "textDocument/documentSymbol",
    "workspace/symbol",
    "textDocument/diagnostic",
    "textDocument/semanticTokens/full",
}
LANGUAGE_IDS = {
    ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp",
    ".cs": "csharp", ".css": "css", ".dart": "dart", ".ex": "elixir", ".exs": "elixir",
    ".go": "go", ".graphql": "graphql", ".gql": "graphql", ".hs": "haskell", ".html": "html",
    ".java": "java", ".js": "javascript", ".jsx": "javascriptreact", ".json": "json", ".jsonc": "jsonc",
    ".kt": "kotlin", ".lua": "lua", ".md": "markdown", ".ml": "ocaml", ".mli": "ocaml.interface",
    ".nix": "nix", ".php": "php", ".py": "python", ".pyi": "python", ".rb": "ruby", ".rs": "rust",
    ".scala": "scala", ".scss": "scss", ".sh": "shellscript", ".sql": "sql", ".swift": "swift",
    ".tla": "tlaplus", ".toml": "toml", ".ts": "typescript", ".tsx": "typescriptreact", ".vue": "vue",
    ".yaml": "yaml", ".yml": "yaml", ".zig": "zig",
}
LANGUAGE_ALIASES = {
    "bash": ".sh", "c++": ".cpp", "c#": ".cs", "docker": "dockerls",
    "dockerfile": "dockerls", "helm": "helm-ls", "latex": "texlab", "odin": "ols",
    "shell": ".sh", "tex": "texlab",
}


def _git_root(cwd: Path) -> Path:
    for parent in (cwd, *cwd.parents):
        if (parent / ".git").exists():
            return parent
    return cwd


def _read_overrides(path: Path) -> dict[str, dict[str, Any]]:
    if not path.is_file():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise LspError(f"Invalid LSP config {path}: {exc}") from exc
    if not isinstance(raw, dict):
        raise LspError(f"LSP config must contain an object: {path}")
    entries = raw.get("servers", raw)
    if not isinstance(entries, dict):
        raise LspError(f"The servers field must contain an object: {path}")
    return {name: value for name, value in entries.items() if isinstance(name, str) and isinstance(value, dict)}


def load_config(cwd: Path, builtins_only: bool = False) -> dict[str, dict[str, Any]]:
    try:
        servers: dict[str, dict[str, Any]] = json.loads(DEFAULTS.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise LspError(f"Could not read bundled server definitions: {exc}") from exc
    if not builtins_only:
        sources = [Path.home() / ".codex" / "lsp.json", _git_root(cwd) / ".codex" / "lsp.json"]
        for source in sources:
            for name, override in _read_overrides(source).items():
                servers[name] = {**servers.get(name, {}), **override}
    for name, config in servers.items():
        command = config.get("command")
        if not isinstance(command, str) or not command.strip():
            raise LspError(f"LSP server {name!r} needs a non-empty command")
        for field in ("args", "fileTypes", "rootMarkers"):
            if field in config and (not isinstance(config[field], list) or not all(isinstance(item, str) for item in config[field])):
                raise LspError(f"LSP server {name!r} has an invalid {field} list")
        for field in ("initOptions", "settings"):
            if field in config and not isinstance(config[field], dict):
                raise LspError(f"LSP server {name!r} has an invalid {field} object")
    return servers


def _has_marker(root: Path, marker: str) -> bool:
    if any(char in marker for char in "*?["):
        return any(fnmatch.fnmatch(entry.name, marker) for entry in root.iterdir())
    return (root / marker).exists()


def _server_root(cwd: Path, markers: list[str]) -> Path | None:
    if not markers:
        return None
    for root in (cwd, *cwd.parents):
        try:
            if any(_has_marker(root, marker) for marker in markers):
                return root
        except OSError:
            continue
    return None


def _resolve_command(command: str, root: Path, global_bins_only: bool) -> str | None:
    candidate = Path(command).expanduser()
    if candidate.is_absolute():
        return str(candidate) if candidate.is_file() and os.access(candidate, os.X_OK) else None
    if "/" in command or "\\" in command:
        candidate = (root / candidate).resolve()
        return str(candidate) if candidate.is_file() and os.access(candidate, os.X_OK) else None
    if not global_bins_only:
        for directory in (root / "node_modules" / ".bin", root / ".venv" / "bin", root / "venv" / "bin", root / "bin"):
            local = directory / command
            if local.is_file() and os.access(local, os.X_OK):
                return str(local.resolve())
    resolved = shutil.which(command)
    if global_bins_only and resolved and Path(resolved).resolve().is_relative_to(root.resolve()):
        return None
    return resolved


def available_servers(
    configs: dict[str, dict[str, Any]], cwd: Path, global_bins_only: bool = False
) -> list[dict[str, Any]]:
    result = []
    for name, raw in configs.items():
        if raw.get("disabled") is True:
            continue
        root = _server_root(cwd, raw.get("rootMarkers", []))
        if root is None:
            continue
        command = _resolve_command(raw["command"], root, global_bins_only)
        if command is None:
            continue
        result.append({**raw, "name": name, "root": root, "resolvedCommand": command})
    return result


def _server_for_language(language: str, configs: dict[str, dict[str, Any]]) -> str:
    name = language.casefold()
    if name in configs:
        return name
    alias = LANGUAGE_ALIASES.get(name)
    if alias in configs:
        return alias
    extensions = [alias] if alias else [
        ext for ext, language_id in LANGUAGE_IDS.items() if language_id.casefold() == name
    ]
    if not extensions and name.startswith("."):
        extensions = [name]
    if not extensions:
        extensions = [f".{name}"]
    candidates = [
        server_name
        for server_name, config in configs.items()
        if any(file_type.casefold() in extensions for file_type in config.get("fileTypes", []))
    ]
    if candidates:
        return next((server for server in candidates if not configs[server].get("isLinter")), candidates[0])
    raise LspError(f"No bundled language server matches {language!r}; pass a server ID to select one directly")


def _matches_file(config: dict[str, Any], path: Path) -> bool:
    name = path.name.casefold()
    suffix = path.suffix.casefold()
    return any(
        name == file_type.casefold() or suffix == file_type.casefold()
        for file_type in config.get("fileTypes", [])
    )


def servers_for_file(servers: list[dict[str, Any]], path: Path) -> list[dict[str, Any]]:
    return sorted((server for server in servers if _matches_file(server, path)), key=lambda item: item.get("isLinter", False))


def resolve_file(value: str, cwd: Path, must_exist: bool = True) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = cwd / path
    try:
        path = path.resolve(strict=must_exist)
    except OSError as exc:
        raise LspError(f"File does not exist: {value}") from exc
    if must_exist:
        try:
            info = path.stat()
        except OSError as exc:
            raise LspError(f"Could not inspect {path}: {exc}") from exc
        if not stat.S_ISREG(info.st_mode):
            raise LspError(f"Not a regular file: {path}")
        if info.st_size > MAX_FILE_BYTES:
            raise LspError(f"File exceeds the {MAX_FILE_BYTES // (1024 * 1024)} MiB LSP limit: {path}")
    return path


def _read_text(path: Path) -> str:
    try:
        with path.open("r", encoding="utf-8", newline="") as stream:
            return stream.read()
    except (OSError, UnicodeError) as exc:
        raise LspError(f"Could not read UTF-8 source file {path}: {exc}") from exc


def _language_id(config: dict[str, Any], path: Path) -> str:
    if config.get("languageId"):
        return config["languageId"]
    if path.name.casefold() == "dockerfile":
        return "dockerfile"
    return LANGUAGE_IDS.get(path.suffix.casefold(), path.suffix.lstrip(".") or "plaintext")


def open_document(client: LspClient, config: dict[str, Any], path: Path) -> tuple[str, str]:
    text = _read_text(path)
    uri = path.as_uri()
    client.notify(
        "textDocument/didOpen",
        {
            "textDocument": {
                "uri": uri,
                "languageId": _language_id(config, path),
                "version": 1,
                "text": text,
            }
        },
    )
    return uri, text


def _utf16_index(text: str, units: int) -> int:
    if units < 0:
        raise LspError("LSP column cannot be negative")
    used = 0
    for index, char in enumerate(text):
        if used >= units:
            return index
        used += 2 if ord(char) > 0xFFFF else 1
    if used == units:
        return len(text)
    raise LspError("LSP column is past the end of the line")


def _line_position(text: str, line_number: int, symbol: str | None, column: int | None) -> dict[str, int]:
    lines = text.splitlines()
    if not lines and line_number == 1:
        lines = [""]
    if line_number < 1 or line_number > len(lines):
        raise LspError(f"Line {line_number} is outside this file")
    line = lines[line_number - 1]
    index: int
    if symbol:
        occurrence = 1
        match = re.fullmatch(r"(.*)#([1-9][0-9]*)", symbol)
        if match:
            symbol, occurrence = match.group(1), int(match.group(2))
        if not symbol:
            raise LspError("Symbol name cannot be empty")
        pattern = re.compile(rf"(?<![\w$]){re.escape(symbol)}(?![\w$])") if re.fullmatch(r"[\w$]+", symbol) else None
        exact = [match.start() for match in pattern.finditer(line)] if pattern else [m.start() for m in re.finditer(re.escape(symbol), line)]
        if not exact:
            insensitive = re.compile(pattern.pattern, re.IGNORECASE) if pattern else re.compile(re.escape(symbol), re.IGNORECASE)
            exact = [m.start() for m in insensitive.finditer(line)]
        if occurrence > len(exact):
            raise LspError(f"Symbol {symbol!r} occurrence #{occurrence} was not found on line {line_number}")
        index = exact[occurrence - 1]
    elif column is not None:
        index = _utf16_index(line, column - 1)
    else:
        index = len(line) - len(line.lstrip())
    return {"line": line_number - 1, "character": len(line[:index].encode("utf-16-le")) // 2}


def _position_params(uri: str, text: str, args: argparse.Namespace) -> dict[str, Any]:
    return {
        "textDocument": {"uri": uri},
        "position": _line_position(text, args.line, getattr(args, "symbol", None), getattr(args, "column", None)),
    }


def _uri_path(uri: str) -> Path | None:
    parsed = urlparse(uri)
    if parsed.scheme != "file":
        return None
    return Path(unquote(parsed.path))


def _location(value: dict[str, Any]) -> dict[str, Any] | None:
    uri = value.get("uri") or value.get("targetUri")
    range_value = value.get("range") or value.get("targetSelectionRange") or value.get("targetRange")
    if not uri or not isinstance(range_value, dict):
        return None
    start = range_value.get("start", {})
    path = _uri_path(uri)
    return {
        "file": str(path) if path else uri,
        "line": int(start.get("line", 0)) + 1,
        "column": int(start.get("character", 0)) + 1,
    }


def _locations(result: Any) -> list[dict[str, Any]]:
    if result is None:
        return []
    values = result if isinstance(result, list) else [result]
    return [location for value in values if isinstance(value, dict) if (location := _location(value))]


def _flatten_hover(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n\n".join(part for part in (_flatten_hover(item) for item in value) if part)
    if isinstance(value, dict):
        return str(value.get("value", value.get("contents", "")))
    return ""


def _format_symbol(value: dict[str, Any], base_uri: str = "") -> dict[str, Any]:
    location = value.get("location") if isinstance(value.get("location"), dict) else value
    point = _location(location) or {}
    start = (value.get("selectionRange") or value.get("range") or {}).get("start", {})
    if not point and base_uri:
        path = _uri_path(base_uri)
        if path:
            point = {"file": str(path), "line": int(start.get("line", 0)) + 1, "column": int(start.get("character", 0)) + 1}
    return {"name": value.get("name", ""), "kind": value.get("kind"), "container": value.get("containerName"), **point}


def _symbol_tree(values: Any, base_uri: str = "") -> list[dict[str, Any]]:
    result = []
    if not isinstance(values, list):
        return result
    for value in values:
        if not isinstance(value, dict):
            continue
        item = _format_symbol(value, base_uri)
        children = _symbol_tree(value.get("children"), base_uri)
        if children:
            item["children"] = children
        result.append(item)
    return result


def _position_offset(text: str, position: dict[str, Any]) -> int:
    line_number = int(position.get("line", 0))
    character = int(position.get("character", 0))
    lines = text.splitlines(keepends=True)
    if line_number == len(lines) and character == 0:
        return len(text)
    if line_number < 0 or line_number >= len(lines):
        raise LspError("Workspace edit line is outside the target file")
    line = lines[line_number]
    content = line.rstrip("\r\n")
    index = _utf16_index(content, character)
    return sum(len(item) for item in lines[:line_number]) + index


def _apply_text_edits(text: str, edits: list[dict[str, Any]]) -> str:
    spans = []
    for edit in edits:
        range_value = edit.get("range", {})
        start = _position_offset(text, range_value.get("start", {}))
        end = _position_offset(text, range_value.get("end", {}))
        if end < start:
            raise LspError("Workspace edit has a reversed range")
        spans.append((start, end, str(edit.get("newText", ""))))
    spans.sort(key=lambda span: (span[0], span[1]))
    unique = []
    for span in spans:
        if unique and span == unique[-1]:
            continue
        if unique and span[0] < unique[-1][1]:
            raise LspError("Workspace edit contains overlapping text changes")
        unique.append(span)
    for start, end, replacement in reversed(unique):
        text = text[:start] + replacement + text[end:]
    return text


def _atomic_write(path: Path, content: bytes) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=".codex-lsp-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def apply_workspace_edit(edit: dict[str, Any], root: Path) -> tuple[bool, str | None]:
    changes: dict[str, list[dict[str, Any]]] = {}
    for uri, edits in (edit.get("changes") or {}).items():
        changes.setdefault(uri, []).extend(edits or [])
    for change in edit.get("documentChanges") or []:
        if not isinstance(change, dict) or "textDocument" not in change:
            return False, "Resource operations are not supported by this CLI"
        uri = (change.get("textDocument") or {}).get("uri")
        if uri:
            changes.setdefault(uri, []).extend(change.get("edits", []))

    planned: list[tuple[Path, bytes, bytes]] = []
    resolved_root = root.resolve()
    for uri, edits in changes.items():
        path = _uri_path(uri)
        if path is None:
            return False, f"Unsupported edit URI: {uri}"
        path = path.resolve()
        if not path.is_relative_to(resolved_root):
            return False, f"Edit is outside the workspace: {path}"
        info = path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE_BYTES:
            return False, f"Edit target is not a supported regular file: {path}"
        original = path.read_bytes()
        try:
            updated = _apply_text_edits(original.decode("utf-8"), edits).encode("utf-8")
        except UnicodeError as exc:
            return False, f"Edit target is not UTF-8: {path}"
        planned.append((path, original, updated))

    written: list[tuple[Path, bytes]] = []
    try:
        for path, original, updated in planned:
            _atomic_write(path, updated)
            written.append((path, original))
    except OSError as exc:
        for path, original in reversed(written):
            try:
                _atomic_write(path, original)
            except OSError:
                pass
        return False, f"Could not write workspace edit: {exc}"
    return True, None


def _edit_summary(edit: dict[str, Any]) -> list[str]:
    paths = set((edit.get("changes") or {}).keys())
    for change in edit.get("documentChanges") or []:
        if isinstance(change, dict):
            uri = (change.get("textDocument") or {}).get("uri")
            if uri:
                paths.add(uri)
    return [f"{len(paths)} file(s), {sum(len(items) for items in (edit.get('changes') or {}).values()) + sum(len(item.get('edits', [])) for item in edit.get('documentChanges', []) if isinstance(item, dict))} edit(s)"]


def _diagnostics_for_client(client: LspClient, uri: str, timeout: float) -> tuple[list[dict[str, Any]], bool]:
    provider = client.capabilities.get("diagnosticProvider")
    if provider:
        try:
            report = client.request("textDocument/diagnostic", {"textDocument": {"uri": uri}}, timeout=timeout)
            if isinstance(report, dict) and report.get("kind") == "full":
                return report.get("items", []), True
            if uri in client.diagnostics:
                return client.diagnostics[uri], True
        except (LspError, TimeoutError):
            pass
    pushed = client.wait_for_push_diagnostics(uri, min(timeout, 5))
    return (pushed or [], pushed is not None)


def _changed_files(cwd: Path) -> list[Path]:
    root = _git_root(cwd)
    commands = [
        ["git", "-C", str(root), "diff", "--name-only", "-z", "--diff-filter=ACMRTUXB", "HEAD"],
        ["git", "-C", str(root), "diff", "--name-only", "-z", "--diff-filter=ACMRTUXB"],
        ["git", "-C", str(root), "diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRTUXB"],
        ["git", "-C", str(root), "ls-files", "--others", "--exclude-standard", "-z"],
    ]
    found: set[Path] = set()
    for command in commands:
        try:
            result = subprocess.run(command, capture_output=True, timeout=5, check=False)
        except (OSError, subprocess.TimeoutExpired):
            continue
        if result.returncode != 0:
            continue
        for raw in result.stdout.split(b"\0"):
            if not raw:
                continue
            try:
                path = (root / os.fsdecode(raw)).resolve()
                if path.is_file() and path.stat().st_size <= MAX_FILE_BYTES:
                    found.add(path)
            except OSError:
                continue
    return sorted(found)[:MAX_FILES]


def _diagnostic_record(path: Path, diagnostics: list[dict[str, Any]], verified: bool) -> dict[str, Any]:
    return {"file": str(path), "verified": verified, "diagnostics": diagnostics}


def command_setup(args: argparse.Namespace, cwd: Path) -> int:
    configs = load_config(cwd)
    languages = [
        language.strip()
        for value in args.languages
        for language in re.split(r"[,，]", value)
        if language.strip()
    ]
    if not languages:
        raise LspError("Provide one or more languages, such as `codex-lsp setup rust python`")

    selected: dict[str, tuple[str, str]] = {}
    missing: list[tuple[str, str, str]] = []
    for language in languages:
        name = _server_for_language(language, configs)
        config = configs[name]
        command = _resolve_command(config["command"], cwd, False)
        if command is None:
            missing.append((language, name, config["command"]))
        else:
            selected[name] = (language, command)
    if missing:
        lines = ["Missing language servers:"]
        for language, name, command in missing:
            lines.append(f"- {language}: {name} (executable: {command})")
            guide = configs[name].get("setup", {})
            if isinstance(guide, dict):
                install = guide.get("install")
                docs = guide.get("docs")
            else:
                install = docs = None
            if isinstance(install, dict):
                install = install.get(sys.platform) or install.get("default")
            platform_name = {"darwin": "macOS", "linux": "Linux", "win32": "Windows"}.get(sys.platform, sys.platform)
            if isinstance(install, str):
                install = [install]
            if not isinstance(install, list) or not all(isinstance(item, str) for item in install):
                install = []
            lines.append(f"  Install command(s) ({platform_name}):")
            lines.extend(f"    {item}" for item in install or [f"Use the official documentation for {platform_name}-specific installation steps."])
            lines.append(f"  Official documentation: {docs if isinstance(docs, str) else 'Consult the language server upstream project documentation.'}")
        rerun = "codex-lsp setup " + " ".join(languages) + (" --project" if args.project else "")
        lines.append(f"After installation, rerun: {rerun}")
        raise LspError("\n".join(lines))

    path = (_git_root(cwd) / ".codex" / "lsp.json") if args.project else (Path.home() / ".codex" / "lsp.json")
    if path.is_file():
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise LspError(f"Invalid LSP config {path}: {exc}") from exc
    else:
        document = {"servers": {}}
    if not isinstance(document, dict):
        raise LspError(f"LSP config must contain an object: {path}")
    wrapped = "servers" in document
    entries = document["servers"] if wrapped else document
    if not isinstance(entries, dict):
        raise LspError(f"The servers field must contain an object: {path}")
    for name, (_, command) in selected.items():
        previous = entries.get(name, {})
        if not isinstance(previous, dict):
            raise LspError(f"LSP config entry {name!r} must contain an object: {path}")
        entries[name] = {**previous, "command": command}
    if wrapped:
        document["servers"] = entries

    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write(path, (json.dumps(document, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    print(f"Configured language servers in {path}:")
    for name, (language, command) in selected.items():
        print(f"- {language}: {name} ({command})")
    return 0


def command_status(args: argparse.Namespace, cwd: Path) -> int:
    configs = load_config(cwd, args.builtins_only)
    servers = available_servers(configs, cwd, args.global_bins_only)
    data = {
        "success": True,
        "servers": [
            {"name": item["name"], "command": item["resolvedCommand"], "root": str(item["root"]), "fileTypes": item.get("fileTypes", [])}
            for item in servers
        ],
    }
    if args.json:
        print(json.dumps(data, ensure_ascii=False))
    elif servers:
        print("Language servers:")
        for item in data["servers"]:
            print(f"- {item['name']} ({item['command']})")
    else:
        print("No configured language servers are available for this workspace")
    return 0


def command_doctor(args: argparse.Namespace, cwd: Path) -> int:
    configs = load_config(cwd)
    config_paths = [Path.home() / ".codex" / "lsp.json", _git_root(cwd) / ".codex" / "lsp.json"]
    overrides: dict[str, dict[str, Any]] = {}
    for path in config_paths:
        overrides.update(_read_overrides(path))

    servers = []
    issues = []
    for server in available_servers(configs, cwd):
        try:
            with LspClient(server, server["root"], args.timeout) as client:
                capabilities = sorted(key for key, value in client.capabilities.items() if value)
            servers.append({
                "name": server["name"],
                "status": "ok",
                "command": server["resolvedCommand"],
                "root": str(server["root"]),
                "capabilities": capabilities,
            })
        except (LspError, TimeoutError, OSError, ValueError) as exc:
            servers.append({
                "name": server["name"],
                "status": "error",
                "command": server["resolvedCommand"],
                "root": str(server["root"]),
                "error": str(exc),
            })
            issues.append({"severity": "error", "server": server["name"], "message": str(exc)})

    for name in sorted(overrides):
        config = configs.get(name)
        if not config or config.get("disabled") is True:
            continue
        root = _server_root(cwd, config.get("rootMarkers", []))
        if root is None or _resolve_command(config["command"], root, False) is not None:
            continue
        message = f"Executable {config['command']!r} is missing; run `codex-lsp setup {name}` for install guidance"
        servers.append({
            "name": name,
            "status": "missing",
            "command": config["command"],
            "root": str(root),
            "message": message,
        })
        issues.append({"severity": "error", "server": name, "message": message})

    if not servers:
        issues.append({
            "severity": "warning",
            "message": "No language server is available for this workspace; run `codex-lsp setup <language...>` for guidance",
        })

    success = bool(servers) and all(server["status"] == "ok" for server in servers)
    data = {
        "success": success,
        "runtime": {
            "version": __version__,
            "python": sys.version.split()[0],
            "executable": str(Path(sys.argv[0]).resolve()),
        },
        "configFiles": [str(path) for path in config_paths if path.is_file()],
        "servers": servers,
        "issues": issues,
    }
    if args.json:
        print(json.dumps(data, ensure_ascii=False))
    else:
        print(f"codex-lsp doctor ({__version__})")
        print(f"Python: {data['runtime']['python']} ({sys.executable})")
        print("Config files:")
        for path in data["configFiles"]:
            print(f"- {path}")
        if not data["configFiles"]:
            print("- none; using built-in server discovery")
        for server in servers:
            if server["status"] == "ok":
                print(f"OK {server['name']}: {server['command']} (root: {server['root']})")
                print(f"  LSP capabilities: {', '.join(server['capabilities']) or 'none reported'}")
            elif server["status"] == "missing":
                print(f"ERROR {server['name']}: {server['message']}")
            else:
                print(f"ERROR {server['name']}: {server['error']}")
        for issue in issues:
            if issue["severity"] == "warning":
                print(f"WARNING: {issue['message']}")
        print("Doctor result: OK" if success else "Doctor result: needs attention")
    return 0 if success else 1


def command_diagnostics(args: argparse.Namespace, cwd: Path) -> int:
    configs = load_config(cwd, args.builtins_only)
    servers = available_servers(configs, cwd, args.global_bins_only)
    paths = _changed_files(cwd) if args.changed else [resolve_file(args.file, cwd)]
    if len(paths) > MAX_FILES:
        paths = paths[:MAX_FILES]
    groups: dict[tuple[str, str], tuple[dict[str, Any], list[Path]]] = {}
    results: dict[Path, dict[str, Any]] = {}
    for path in paths:
        matches = servers_for_file(servers, path)
        if not matches:
            results[path] = _diagnostic_record(path, [], False)
            continue
        for server in matches:
            key = server["name"], str(server["root"])
            groups.setdefault(key, (server, []))[1].append(path)
    for server, files in groups.values():
        try:
            with LspClient(server, server["root"], args.timeout) as client:
                opened: dict[Path, str] = {}
                for path in files:
                    uri, _ = open_document(client, server, path)
                    opened[path] = uri
                for path, uri in opened.items():
                    diagnostics, verified = _diagnostics_for_client(client, uri, args.timeout)
                    record = results.setdefault(path, _diagnostic_record(path, [], False))
                    if verified:
                        record["verified"] = True
                    seen = {(str(item.get("range")), item.get("message")) for item in record["diagnostics"]}
                    for diagnostic in diagnostics:
                        key = (str(diagnostic.get("range")), diagnostic.get("message"))
                        if key not in seen:
                            record["diagnostics"].append(diagnostic)
                            seen.add(key)
        except (LspError, TimeoutError, OSError) as exc:
            for path in files:
                record = results.setdefault(path, _diagnostic_record(path, [], False))
                record.setdefault("errors", []).append(f"{server['name']}: {exc}")
    ordered = [results[path] for path in paths if path in results]
    errors = [d for result in ordered for d in result["diagnostics"] if d.get("severity", 1) == 1]
    data = {"success": not errors, "checked": ordered, "hasErrors": bool(errors)}
    if args.json:
        print(json.dumps(data, ensure_ascii=False))
    else:
        for result in ordered:
            if result["diagnostics"]:
                print(f"Diagnostics for {result['file']}:")
                for item in result["diagnostics"]:
                    start = item.get("range", {}).get("start", {})
                    severity = {1: "error", 2: "warning", 3: "info", 4: "hint"}.get(item.get("severity"), "diagnostic")
                    print(f"  {start.get('line', 0) + 1}:{start.get('character', 0) + 1} {severity}: {item.get('message', '')}")
            elif result["verified"]:
                print(f"OK {result['file']}")
            else:
                print(f"Unverified {result['file']} (no matching server or diagnostics response)")
            for error in result.get("errors", []):
                print(f"  {error}")
    return 1 if errors else 0


def _client_for_file(
    args: argparse.Namespace,
    cwd: Path,
    configs: dict[str, dict[str, Any]],
    allow_apply_edits: bool = False,
) -> tuple[dict[str, Any], Path, LspClient, str, str]:
    path = resolve_file(args.file, cwd)
    servers = available_servers(configs, path.parent)
    matches = servers_for_file(servers, path)
    if not matches:
        raise LspError(f"No available language server matches {path}")
    server = matches[0]
    client = LspClient(server, server["root"], args.timeout, allow_apply_edits=allow_apply_edits)
    try:
        uri, text = open_document(client, server, path)
    except Exception:
        client.close()
        raise
    return server, path, client, uri, text


def command_navigate(args: argparse.Namespace, cwd: Path, method: str) -> int:
    configs = load_config(cwd, args.builtins_only)
    server, path, client, uri, text = _client_for_file(args, cwd, configs)
    try:
        params = _position_params(uri, text, args)
        if method == "textDocument/references":
            params["context"] = {"includeDeclaration": True}
        if method == "textDocument/hover":
            position = params["position"]
            symbol = symbol_at_position(text, position["line"], position["character"])
            deadline = time.monotonic() + min(args.timeout, HOVER_RETRY_SECONDS)
            delay = 0.1
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    result = None
                    content = ""
                    break
                try:
                    result = client.request(method, params, timeout=remaining)
                except LspError as exc:
                    if str(exc).casefold().replace(" ", "") != "contentmodified":
                        raise
                    result = None
                    content = ""
                except TimeoutError:
                    result = None
                    content = ""
                    break
                content = _flatten_hover((result or {}).get("contents")) if isinstance(result, dict) else ""
                if content.strip() or not symbol:
                    break
                # Fresh LSP processes can answer before workspace indexing finishes.
                time.sleep(min(delay, max(0.0, deadline - time.monotonic())))
                delay = min(delay * 2, 0.5)
            provider = "lsp"
            if not content.strip():
                reference = find_reference(_language_id(server, path), symbol or "", timeout=min(args.timeout, 3))
                if reference:
                    content = reference
                    provider = "devdocs"
            data = {"success": True, "server": server["name"], "provider": provider, "hover": content}
            human = content or "No hover information"
        else:
            result = client.request(method, params)
            locations = _locations(result)
            label = {"textDocument/definition": "definition", "textDocument/references": "reference", "textDocument/typeDefinition": "type definition", "textDocument/implementation": "implementation"}[method]
            data = {"success": True, "server": server["name"], "locations": locations}
            human = f"No {label} found" if not locations else f"Found {len(locations)} {label}(s):\n" + "\n".join(f"{item['file']}:{item['line']}:{item['column']}" for item in locations)
        if args.json:
            print(json.dumps(data, ensure_ascii=False))
        else:
            print(human)
        return 0
    finally:
        client.close()


def command_symbols(args: argparse.Namespace, cwd: Path) -> int:
    configs = load_config(cwd, args.builtins_only)
    servers = available_servers(configs, cwd)
    if args.workspace:
        if not args.query:
            raise LspError("--query is required with --workspace")
        items = []
        used = []
        for server in servers:
            if server.get("isLinter"):
                continue
            try:
                with LspClient(server, server["root"], args.timeout) as client:
                    result = client.request("workspace/symbol", {"query": args.query}) or []
                    items.extend(_symbol_tree(result))
                    used.append(server["name"])
            except LspError:
                continue
        items = items[:MAX_FILES]
        data = {"success": True, "servers": used, "symbols": items}
    else:
        server, path, client, uri, _ = _client_for_file(args, cwd, configs)
        try:
            result = client.request("textDocument/documentSymbol", {"textDocument": {"uri": uri}})
            data = {"success": True, "server": server["name"], "symbols": _symbol_tree(result, uri)}
        finally:
            client.close()
    if args.json:
        print(json.dumps(data, ensure_ascii=False))
    elif data["symbols"]:
        print("Symbols:")
        for item in data["symbols"]:
            location = f" @ {item['file']}:{item['line']}:{item['column']}" if item.get("file") else ""
            print(f"- {item.get('name', '')}{location}")
    else:
        print("No symbols found")
    return 0


def command_rename(args: argparse.Namespace, cwd: Path) -> int:
    if not args.new_name:
        raise LspError("--new-name is required")
    configs = load_config(cwd, args.builtins_only)
    server, path, client, uri, text = _client_for_file(args, cwd, configs)
    try:
        edit = client.request("textDocument/rename", {**_position_params(uri, text, args), "newName": args.new_name}) or {}
        if args.apply:
            applied, reason = apply_workspace_edit(edit, server["root"])
            if not applied:
                raise LspError(reason or "Could not apply rename")
            data = {"success": True, "applied": True, "server": server["name"], "edits": _edit_summary(edit)}
            human = "Applied rename:\n" + "\n".join(data["edits"])
        else:
            data = {"success": True, "applied": False, "server": server["name"], "edits": _edit_summary(edit)}
            human = "Rename preview:\n" + "\n".join(data["edits"])
        if args.json:
            print(json.dumps(data, ensure_ascii=False))
        else:
            print(human)
        return 0
    finally:
        client.close()


def command_code_actions(args: argparse.Namespace, cwd: Path) -> int:
    configs = load_config(cwd, args.builtins_only)
    server, path, client, uri, text = _client_for_file(args, cwd, configs, allow_apply_edits=args.apply)
    try:
        params = _position_params(uri, text, args)
        position = params["position"]
        params["range"] = {"start": position, "end": position}
        params["context"] = {"diagnostics": client.diagnostics.get(uri, [])}
        actions = client.request("textDocument/codeAction", params) or []
        actions = [item for item in actions if isinstance(item, dict)]
        if not args.apply:
            items = [{"index": i, "title": item.get("title", ""), "kind": item.get("kind")} for i, item in enumerate(actions)]
            if args.query:
                items = [item for item in items if args.query.casefold() in item["title"].casefold()]
            data = {"success": True, "server": server["name"], "actions": items}
            human = f"{len(items)} code action(s):\n" + "\n".join(f"{item['index']}: {item.get('title', '')}" for item in items)
        else:
            if not args.query:
                raise LspError("--query must select an action when using --apply")
            chosen = None
            if args.query.isdigit() and int(args.query) < len(actions):
                chosen = actions[int(args.query)]
            else:
                chosen = next((item for item in actions if args.query.casefold() in item.get("title", "").casefold()), None)
            if chosen is None:
                raise LspError(f"No code action matches {args.query!r}")
            client.apply_edit_handler = lambda edit: apply_workspace_edit(edit, server["root"])
            if chosen.get("edit"):
                applied, reason = apply_workspace_edit(chosen["edit"], server["root"])
                if not applied:
                    raise LspError(reason or "Could not apply code action")
            if chosen.get("command"):
                command = chosen["command"]
                client.request("workspace/executeCommand", {"command": command.get("command"), "arguments": command.get("arguments", [])})
            elif not chosen.get("edit"):
                raise LspError("Selected code action has no edit or command")
            data = {"success": True, "applied": True, "server": server["name"], "title": chosen.get("title", "")}
            human = f"Applied {chosen.get('title', 'code action')}"
        if args.json:
            print(json.dumps(data, ensure_ascii=False))
        else:
            print(human)
        return 0
    finally:
        client.close()


def _inside(root: Path, path: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _remap_edit(edit: dict[str, Any], old_uri: str, new_uri: str) -> dict[str, Any]:
    result = json.loads(json.dumps(edit))
    if isinstance(result.get("changes"), dict) and old_uri in result["changes"]:
        result["changes"][new_uri] = result["changes"].pop(old_uri)
    for change in result.get("documentChanges") or []:
        if isinstance(change, dict) and (change.get("textDocument") or {}).get("uri") == old_uri:
            change["textDocument"]["uri"] = new_uri
    return result


def _move_no_replace(source: Path, destination: Path) -> None:
    created = False
    try:
        with source.open("rb") as source_stream:
            with destination.open("xb") as destination_stream:
                created = True
                shutil.copyfileobj(source_stream, destination_stream)
                destination_stream.flush()
                os.fsync(destination_stream.fileno())
        shutil.copystat(source, destination)
        source.unlink()
    except OSError:
        if created and source.exists():
            try:
                destination.unlink()
            except OSError:
                pass
        raise


def command_rename_file(args: argparse.Namespace, cwd: Path) -> int:
    source = resolve_file(args.file, cwd)
    destination = Path(args.new_name).expanduser()
    if not destination.is_absolute():
        destination = source.parent / destination
    destination = destination.resolve(strict=False)
    if source == destination:
        raise LspError("Source and destination are identical")
    if destination.exists():
        raise LspError(f"Destination already exists: {destination}")
    configs = load_config(cwd, args.builtins_only)
    servers = available_servers(configs, source.parent)
    matches = [item for item in servers_for_file(servers, source) if not item.get("isLinter")]
    pairs = {"files": [{"oldUri": source.as_uri(), "newUri": destination.as_uri()}]}
    clients: list[tuple[dict[str, Any], LspClient, dict[str, Any]]] = []
    try:
        for server in matches:
            client = LspClient(server, server["root"], args.timeout)
            try:
                edit = client.request("workspace/willRenameFiles", pairs) or {}
                clients.append((server, client, edit))
            except LspError as exc:
                client.close()
                if "method" not in str(exc).casefold():
                    raise
        if args.apply:
            root = matches[0]["root"] if matches else _git_root(cwd)
            if not _inside(root, source) or not _inside(root, destination):
                raise LspError("File rename must stay inside the workspace")
            if not destination.parent.is_dir():
                raise LspError(f"Destination directory does not exist: {destination.parent}")
            _move_no_replace(source, destination)
            try:
                combined: dict[str, Any] = {"changes": {}, "documentChanges": []}
                for _, _, edit in clients:
                    remapped = _remap_edit(edit, source.as_uri(), destination.as_uri())
                    for uri, edits in (remapped.get("changes") or {}).items():
                        combined["changes"].setdefault(uri, []).extend(edits)
                    combined["documentChanges"].extend(remapped.get("documentChanges") or [])
                edit_root = clients[0][0]["root"] if clients else root
                applied, reason = apply_workspace_edit(combined, edit_root)
                if not applied:
                    raise LspError(reason or "Could not apply rename references")
            except Exception:
                try:
                    _move_no_replace(destination, source)
                except OSError:
                    pass
                raise
            for _, client, _ in clients:
                try:
                    client.notify("workspace/didRenameFiles", pairs)
                except LspError:
                    pass
            data = {"success": True, "applied": True, "source": str(source), "destination": str(destination), "servers": [item[0]["name"] for item in clients]}
            human = f"Renamed {source} → {destination}"
        else:
            data = {"success": True, "applied": False, "source": str(source), "destination": str(destination), "edits": [_edit_summary(edit) for _, _, edit in clients]}
            human = f"Rename preview: {source} → {destination}\n" + "\n".join(f"{server['name']}: {summary[0]}" for (server, _, _), summary in zip(clients, data["edits"]))
        if args.json:
            print(json.dumps(data, ensure_ascii=False))
        else:
            print(human)
        return 0
    finally:
        for _, client, _ in clients:
            client.close()


def command_capabilities(args: argparse.Namespace, cwd: Path) -> int:
    configs = load_config(cwd, args.builtins_only)
    if args.file:
        path = resolve_file(args.file, cwd)
        servers = servers_for_file(available_servers(configs, path.parent), path)
    else:
        servers = available_servers(configs, cwd)
    result = []
    for server in servers:
        if server.get("isLinter"):
            continue
        try:
            with LspClient(server, server["root"], args.timeout) as client:
                result.append({"server": server["name"], "capabilities": client.capabilities})
        except (LspError, TimeoutError) as exc:
            result.append({"server": server["name"], "error": str(exc)})
    data = {"success": True, "servers": result}
    if args.json:
        print(json.dumps(data, ensure_ascii=False))
    else:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    return 0


def command_request(args: argparse.Namespace, cwd: Path) -> int:
    if args.method not in READ_ONLY_METHODS and not args.apply:
        raise LspError("Raw request methods require --apply unless listed as read-only")
    configs = load_config(cwd, args.builtins_only)
    if args.file:
        server, path, client, uri, text = _client_for_file(args, cwd, configs, allow_apply_edits=args.apply)
        params: Any = json.loads(args.payload) if args.payload else {}
        if not args.payload and args.method in {
            "textDocument/definition", "textDocument/declaration", "textDocument/typeDefinition",
            "textDocument/implementation", "textDocument/references", "textDocument/hover",
        }:
            params = _position_params(uri, text, args)
            if args.method == "textDocument/references":
                params["context"] = {"includeDeclaration": True}
        elif not args.payload and args.method.startswith("textDocument/"):
            params = {"textDocument": {"uri": uri}}
    else:
        servers = available_servers(configs, cwd)
        if not servers:
            raise LspError("No available language server for this workspace")
        server = next((item for item in servers if not item.get("isLinter")), servers[0])
        client = LspClient(server, server["root"], args.timeout, allow_apply_edits=args.apply)
        params = json.loads(args.payload) if args.payload else {}
    try:
        if args.apply:
            client.apply_edit_handler = lambda edit: apply_workspace_edit(edit, server["root"])
        result = client.request(args.method, params)
        applied = False
        if args.apply and isinstance(result, dict) and ("changes" in result or "documentChanges" in result):
            applied, reason = apply_workspace_edit(result, server["root"])
            if not applied:
                raise LspError(reason or "Could not apply returned workspace edit")
        data = {"success": True, "server": server["name"], "method": args.method, "applied": applied, "result": result}
        if args.json:
            print(json.dumps(data, ensure_ascii=False))
        else:
            print(json.dumps(data, ensure_ascii=False, indent=2))
        return 0
    finally:
        client.close()


def _add_common(parser: argparse.ArgumentParser, needs_file: bool = True, position: bool = False) -> None:
    parser.add_argument("--file", required=needs_file, help="Source file path")
    if position:
        parser.add_argument("--line", type=int, default=1, help="1-based line number")
        parser.add_argument("--symbol", help="Resolve this token on the line; append #N to select an occurrence")
        parser.add_argument("--column", type=int, help="1-based UTF-16 column when no symbol is given")
    parser.add_argument("--timeout", type=float, default=20, help="Request timeout in seconds (5..300)")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON")
    parser.add_argument("--builtins-only", action="store_true", help="Ignore user and project server overrides")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="codex-lsp", description="Query local language servers from agent workflows")
    parser.add_argument("--version", action="version", version=f"codex-lsp {__version__}")
    commands = parser.add_subparsers(dest="command", required=True)

    status = commands.add_parser("status", help="List available language servers")
    status.add_argument("--json", action="store_true")
    status.add_argument("--builtins-only", action="store_true")
    status.add_argument("--global-bins-only", action="store_true", help=argparse.SUPPRESS)

    doctor = commands.add_parser("doctor", help="Check LSP configuration and server health")
    doctor.add_argument("--timeout", type=float, default=20, help="Initialize timeout per server in seconds (5..300)")
    doctor.add_argument("--json", action="store_true", help="Print machine-readable JSON")

    setup = commands.add_parser("setup", help="Configure language servers for selected languages")
    setup.add_argument("languages", nargs="+", metavar="LANGUAGE", help="Language names or server IDs; separate with spaces or English/Chinese commas")
    setup.add_argument("--project", action="store_true", help="Write to <git-root>/.codex/lsp.json instead of ~/.codex/lsp.json")

    diagnostics = commands.add_parser("diagnostics", help="Get diagnostics for one file or changed files")
    _add_common(diagnostics, needs_file=False)
    diagnostics.add_argument("--changed", action="store_true", help="Check files changed from Git HEAD, including untracked files")
    diagnostics.add_argument("--global-bins-only", action="store_true", help=argparse.SUPPRESS)

    for name, help_text in (
        ("definition", "Find symbol definitions"), ("references", "Find symbol references"), ("hover", "Get hover information"),
        ("type-definition", "Find type definitions"), ("implementation", "Find implementations"),
    ):
        command = commands.add_parser(name, help=help_text)
        _add_common(command, position=True)

    symbols = commands.add_parser("symbols", help="List document or workspace symbols")
    _add_common(symbols, needs_file=False)
    symbols.add_argument("--workspace", action="store_true")
    symbols.add_argument("--query")

    rename = commands.add_parser("rename", help="Preview or apply a symbol rename")
    _add_common(rename, position=True)
    rename.add_argument("--new-name", required=True)
    rename.add_argument("--apply", action="store_true", help="Apply the returned workspace edit")

    rename_file = commands.add_parser("rename-file", help="Preview or apply a file rename with LSP reference updates")
    _add_common(rename_file)
    rename_file.add_argument("--new-name", required=True, help="Destination path")
    rename_file.add_argument("--apply", action="store_true", help="Move the file and apply server reference edits")

    actions = commands.add_parser("code-actions", help="List or apply code actions")
    _add_common(actions, position=True)
    actions.add_argument("--query", help="Filter by title, or select an action when applying")
    actions.add_argument("--apply", action="store_true", help="Apply a selected action")

    capabilities = commands.add_parser("capabilities", help="Inspect server capabilities")
    _add_common(capabilities, needs_file=False)

    request = commands.add_parser("request", help="Send a raw LSP request")
    _add_common(request, needs_file=False, position=True)
    request.add_argument("--method", required=True)
    request.add_argument("--payload", help="JSON params")
    request.add_argument("--apply", action="store_true", help="Allow a write-capable request and edits")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if hasattr(args, "timeout"):
        args.timeout = max(5, min(300, args.timeout))
    cwd = Path.cwd().resolve()
    try:
        if args.command == "setup":
            return command_setup(args, cwd)
        if args.command == "status":
            return command_status(args, cwd)
        if args.command == "doctor":
            return command_doctor(args, cwd)
        if args.command == "diagnostics":
            if bool(args.changed) == bool(args.file):
                raise LspError("Choose exactly one of --file or --changed")
            return command_diagnostics(args, cwd)
        if args.command == "definition":
            return command_navigate(args, cwd, "textDocument/definition")
        if args.command == "references":
            return command_navigate(args, cwd, "textDocument/references")
        if args.command == "hover":
            return command_navigate(args, cwd, "textDocument/hover")
        if args.command == "type-definition":
            return command_navigate(args, cwd, "textDocument/typeDefinition")
        if args.command == "implementation":
            return command_navigate(args, cwd, "textDocument/implementation")
        if args.command == "symbols":
            if not args.workspace and not args.file:
                raise LspError("--file is required unless --workspace is set")
            return command_symbols(args, cwd)
        if args.command == "rename":
            return command_rename(args, cwd)
        if args.command == "rename-file":
            return command_rename_file(args, cwd)
        if args.command == "code-actions":
            return command_code_actions(args, cwd)
        if args.command == "capabilities":
            return command_capabilities(args, cwd)
        if args.command == "request":
            return command_request(args, cwd)
        parser.error(f"Unknown command: {args.command}")
    except (LspError, TimeoutError, OSError, ValueError, json.JSONDecodeError) as exc:
        if getattr(args, "json", False):
            print(json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False))
        else:
            print(f"codex-lsp: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
