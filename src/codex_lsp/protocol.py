from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Callable

from codex_lsp import __version__


class LspError(RuntimeError):
    pass


class LspClient:
    def __init__(self, config: dict[str, Any], root: Path, timeout: float, allow_apply_edits: bool = False):
        command = [config["resolvedCommand"], *config.get("args", [])]
        command = [str(os.getpid()) if arg == "$PID" else arg for arg in command]
        try:
            self.proc = subprocess.Popen(
                command,
                cwd=root,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=-1,
                env={**os.environ, "RUSTUP_AUTO_INSTALL": "0"},
            )
        except OSError as exc:
            raise LspError(f"Could not start {config['name']}: {exc}") from exc

        self.config = config
        self.root = root.resolve()
        self.timeout = timeout
        self.allow_apply_edits = allow_apply_edits
        self.messages: queue.Queue[Any] = queue.Queue()
        self.diagnostics: dict[str, list[dict[str, Any]]] = {}
        self.progress: dict[str, dict[str, Any]] = {}
        self.progress_seen: set[str] = set()
        self._request_id = 0
        self._stderr: deque[str] = deque(maxlen=40)
        self._closed = False
        self.apply_edit_handler: Callable[[dict[str, Any]], tuple[bool, str | None]] | None = None
        self._reader = threading.Thread(target=self._read_messages, daemon=True)
        self._stderr_reader = threading.Thread(target=self._read_stderr, daemon=True)
        self._reader.start()
        self._stderr_reader.start()

        root_uri = self.root.as_uri()
        try:
            self.initialize_result = self.request(
                "initialize",
                {
                    "processId": os.getpid(),
                    "clientInfo": {"name": "codex-lsp", "version": __version__},
                    "rootUri": root_uri,
                    "rootPath": str(self.root),
                    "workspaceFolders": [{"uri": root_uri, "name": self.root.name}],
                    "initializationOptions": config.get("initOptions", {}),
                    "capabilities": {
                        "general": {"positionEncodings": ["utf-16"]},
                        "workspace": {
                            "applyEdit": allow_apply_edits,
                            "workspaceEdit": {"documentChanges": True},
                            "configuration": True,
                            "workspaceFolders": True,
                        },
                        "window": {"workDoneProgress": True},
                        "textDocument": {
                            "publishDiagnostics": {"relatedInformation": True},
                            "diagnostic": {"dynamicRegistration": False},
                        },
                    },
                    "trace": "off",
                },
                timeout=max(timeout, float(config.get("warmupTimeoutMs", 5000)) / 1000),
            ) or {}
            self.capabilities = self.initialize_result.get("capabilities", {})
            self.notify("initialized", {})
            if isinstance(config.get("settings"), dict):
                self.notify("workspace/didChangeConfiguration", {"settings": config["settings"]})
        except Exception:
            self.close()
            raise

    def _read_messages(self) -> None:
        stream = self.proc.stdout
        if stream is None:
            self.messages.put(LspError("LSP stdout is unavailable"))
            return
        try:
            while True:
                headers: dict[str, str] = {}
                while True:
                    line = stream.readline()
                    if not line:
                        self.messages.put(EOFError())
                        return
                    if line in (b"\r\n", b"\n"):
                        break
                    key, sep, value = line.decode("ascii", "replace").partition(":")
                    if sep:
                        headers[key.strip().lower()] = value.strip()
                length = int(headers.get("content-length", "-1"))
                if length < 0 or length > 64 * 1024 * 1024:
                    raise LspError(f"Invalid LSP Content-Length: {length}")
                body = stream.read(length)
                if len(body) != length:
                    raise EOFError()
                self.messages.put(json.loads(body))
        except Exception as exc:
            self.messages.put(exc)

    def _read_stderr(self) -> None:
        stream = self.proc.stderr
        if stream is None:
            return
        for line in iter(stream.readline, b""):
            self._stderr.append(line.decode("utf-8", "replace").rstrip())

    def _send(self, value: dict[str, Any]) -> None:
        if self.proc.poll() is not None:
            raise LspError(self._exit_message())
        if self.proc.stdin is None:
            raise LspError("LSP stdin is unavailable")
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        frame = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body
        try:
            self.proc.stdin.write(frame)
            self.proc.stdin.flush()
        except OSError as exc:
            raise LspError(self._exit_message()) from exc

    def _next_message(self, timeout: float) -> Any:
        try:
            item = self.messages.get(timeout=max(0.0, timeout))
        except queue.Empty as exc:
            raise TimeoutError("LSP request timed out") from exc
        if isinstance(item, BaseException):
            raise LspError(self._exit_message()) from item
        return item

    def _dispatch(self, message: dict[str, Any]) -> dict[str, Any] | None:
        if not isinstance(message, dict):
            return None
        method = message.get("method")
        if not method:
            return message
        params = message.get("params") or {}
        if method == "textDocument/publishDiagnostics":
            self.diagnostics[params.get("uri", "")] = params.get("diagnostics", [])
        if method == "$/progress":
            token = params.get("token")
            value = params.get("value")
            if token is not None and isinstance(value, dict):
                token = str(token)
                self.progress_seen.add(token)
                if value.get("kind") == "end":
                    self.progress.pop(token, None)
                else:
                    self.progress[token] = value
            return None
        if "id" in message:
            result: Any = None
            error: dict[str, Any] | None = None
            if method == "workspace/configuration":
                section = (params.get("items") or [{}])[0].get("section", "")
                result = self.config.get("settings", {}).get(section, {})
                if isinstance(params.get("items"), list):
                    result = [self.config.get("settings", {}).get(item.get("section", ""), {}) for item in params["items"]]
            elif method == "workspace/applyEdit":
                if not self.allow_apply_edits or not self.apply_edit_handler:
                    result = {"applied": False, "failureReason": "This invocation is read-only"}
                else:
                    try:
                        applied, reason = self.apply_edit_handler(params.get("edit", {}))
                        result = {"applied": applied}
                        if reason:
                            result["failureReason"] = reason
                    except Exception as exc:
                        result = {"applied": False, "failureReason": str(exc)}
            elif method not in ("client/registerCapability", "client/unregisterCapability", "window/workDoneProgress/create"):
                error = {"code": -32601, "message": f"Unsupported client request: {method}"}
            response: dict[str, Any] = {"jsonrpc": "2.0", "id": message["id"]}
            response["error" if error else "result"] = error if error else result
            self._send(response)
            return None
        return None

    def request(self, method: str, params: Any, timeout: float | None = None) -> Any:
        self._request_id += 1
        request_id = self._request_id
        self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + (self.timeout if timeout is None else timeout)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                try:
                    self.notify("$/cancelRequest", {"id": request_id})
                except LspError:
                    pass
                raise TimeoutError(f"LSP request {method} timed out")
            try:
                message = self._next_message(remaining)
            except TimeoutError:
                try:
                    self.notify("$/cancelRequest", {"id": request_id})
                except LspError:
                    pass
                raise TimeoutError(f"LSP request {method} timed out") from None
            response = self._dispatch(message)
            if response is None or response.get("id") != request_id:
                continue
            if "error" in response:
                error = response["error"] or {}
                raise LspError(error.get("message", f"LSP request {method} failed"))
            return response.get("result")

    def notify(self, method: str, params: Any = None) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def wait_for_push_diagnostics(self, uri: str, timeout: float) -> list[dict[str, Any]] | None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if uri in self.diagnostics:
                return self.diagnostics[uri]
            try:
                message = self._next_message(deadline - time.monotonic())
            except TimeoutError:
                return self.diagnostics.get(uri)
            self._dispatch(message)
        return self.diagnostics.get(uri)

    def wait_for_progress_idle(self, prefixes: tuple[str, ...], timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        probe_deadline = min(deadline, time.monotonic() + 0.25)
        idle_since: float | None = None
        while True:
            seen = any(token.startswith(prefixes) for token in self.progress_seen)
            active = any(token.startswith(prefixes) for token in self.progress)
            now = time.monotonic()
            if seen and not active:
                idle_since = idle_since or now
                if now - idle_since >= 0.1:
                    return True
            else:
                idle_since = None
            remaining = deadline - now
            if remaining <= 0 or (not seen and now >= probe_deadline):
                return False
            if idle_since:
                wait = min(remaining, max(0.0, 0.1 - (now - idle_since)))
            elif not seen:
                wait = min(remaining, probe_deadline - now)
            else:
                wait = remaining
            try:
                self._dispatch(self._next_message(wait))
            except TimeoutError:
                return seen and not active

    def _exit_message(self) -> str:
        detail = "\n".join(self._stderr)
        status = self.proc.poll()
        return f"Language server exited ({status})" + (f":\n{detail}" if detail else "")

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self.proc.poll() is None:
            try:
                self.request("shutdown", None, timeout=2)
            except Exception:
                pass
            try:
                self.notify("exit", None)
            except Exception:
                pass
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            if stream:
                stream.close()

    def __enter__(self) -> LspClient:
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()
