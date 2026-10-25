"""Focused offline checks: PYTHONPATH=src python3 scripts/check_dx.py."""

import contextlib
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from codex_lsp import cli
from codex_lsp.protocol import LspClient, LspError


repo = Path(__file__).resolve().parents[1]
for manifest in ("plugin.json", ".claude-plugin/plugin.json"):
    assert json.loads((repo / manifest).read_text())["version"] == cli.__version__
assert f'version = "{cli.__version__}"' in (repo / "pyproject.toml").read_text()

client = MagicMock(config={"name": "typescript-language-server"}, capabilities={})
client.wait_for_push_diagnostics.return_value = []
assert cli._diagnostics_for_client(client, "file:///source.ts", 60) == ([], True)
client.wait_for_push_diagnostics.assert_called_once_with("file:///source.ts", 60)

workspace = LspClient.__new__(LspClient)
workspace.server_status = None
workspace._next_message = MagicMock(side_effect=[
    {"method": "experimental/serverStatus", "params": {"quiescent": False, "health": "ok"}},
    {"method": "experimental/serverStatus", "params": {"quiescent": True, "health": "ok"}},
])
workspace.wait_for_workspace(1)
assert workspace._next_message.call_count == 2
workspace.server_status = {"quiescent": True, "health": "warning", "message": "Missing Cargo dependencies"}
try:
    workspace.wait_for_workspace(1)
except LspError as exc:
    assert "Missing Cargo dependencies" in str(exc)
else:
    raise AssertionError("Incomplete workspaces must fail")
workspace.server_status = None
try:
    workspace.wait_for_workspace(0)
except TimeoutError:
    pass
else:
    raise AssertionError("Workspace waits must respect the deadline")

with TemporaryDirectory() as directory:
    root = Path(directory).resolve()
    source = root / "source.py"
    source.write_text("hello = 1\n")
    (root / "pyproject.toml").touch()
    config = {"command": cli.sys.executable, "rootMarkers": ["pyproject.toml"], "fileTypes": [".py"],
              "settings": {"python": {"analysis": {"typeCheckingMode": "strict"}}}}
    for platform in ("darwin", "linux", "win32"):
        executable = "Scripts/python.exe" if platform == "win32" else "bin/python"
        for name in (".venv", "venv"):
            interpreter = root / name / executable
            interpreter.parent.mkdir(parents=True, exist_ok=True)
            interpreter.touch()
            interpreter.chmod(0o755)
        for name in ("pyright", "basedpyright"):
            with patch.object(cli.sys, "platform", platform):
                server = cli.available_servers({name: config}, root)[0]
            assert server["settings"]["python"]["pythonPath"] == str(root / ".venv" / executable)
            assert server["settings"]["python"]["analysis"]["typeCheckingMode"] == "strict"
            assert "pythonPath" not in config["settings"]["python"]
        (root / ".venv" / executable).unlink()
        with patch.object(cli.sys, "platform", platform):
            server = cli.available_servers({"pyright": config}, root)[0]
        assert server["settings"]["python"]["pythonPath"] == str(root / "venv" / executable)
    config["settings"]["python"]["pythonPath"] = "/explicit/python"
    server = cli.available_servers({"pyright": config}, root)[0]
    assert server["settings"]["python"]["pythonPath"] == "/explicit/python"
    try:
        cli.available_servers({"pyright": {**config, "settings": {"python": None}}}, root)
    except LspError as exc:
        assert "settings.python" in str(exc)
    else:
        raise AssertionError("Invalid Python settings must fail")
    with patch.object(cli, "load_config", return_value={"pyright": config}), \
         patch.object(cli, "available_servers", return_value=[server]), \
         patch.object(cli, "LspClient"), contextlib.redirect_stdout(io.StringIO()) as out:
        assert cli.command_doctor(SimpleNamespace(file=None, timeout=5, json=True), root) == 0
    assert json.loads(out.getvalue())["servers"][0]["pythonPath"] == "/explicit/python"
    configs = {"pyright": config, "unrelated": {**config, "fileTypes": [".ts"]}}

    def scoped_servers(selected, context):
        assert list(selected) == ["pyright"] and context == source.parent
        return [server]

    with patch.object(cli, "load_config", return_value=configs), \
         patch.object(cli, "_read_overrides", return_value=configs), \
         patch.object(cli, "available_servers", side_effect=scoped_servers), \
         patch.object(cli, "LspClient"), contextlib.redirect_stdout(io.StringIO()) as out:
        args = cli.build_parser().parse_args(["doctor", "--file", str(source), "--json"])
        assert cli.command_doctor(args, repo) == 0
    assert len(json.loads(out.getvalue())["servers"]) == 1

    args = SimpleNamespace(file=str(source), changed=False, builtins_only=True,
                           global_bins_only=True, timeout=60, json=True)
    with patch.object(cli, "available_servers", return_value=[]), contextlib.redirect_stdout(io.StringIO()) as out:
        assert cli.command_diagnostics(args, root) == 1
    data = json.loads(out.getvalue())
    assert data["success"] is False and data["verified"] is False and data["hasErrors"] is False

    client = MagicMock()
    client.request.return_value = {"contents": "hello: int"}
    args.line, args.symbol, args.column = 1, "hello", None
    with patch.object(cli, "_client_for_file", return_value=(
        {"name": "pyright"}, source, client, source.as_uri(), source.read_text()
    )), contextlib.redirect_stdout(io.StringIO()):
        assert cli.command_navigate(args, root, "textDocument/hover") == 0
    assert client.request.call_args.kwargs["timeout"] > 59
    client.request.return_value = [{"uri": source.as_uri(), "range": {"start": {"line": 0, "character": 0}}}]
    with patch.object(cli, "_client_for_file", return_value=(
        {"name": "pyright"}, source, client, source.as_uri(), source.read_text()
    )), contextlib.redirect_stdout(io.StringIO()):
        assert cli.command_navigate(args, root, "textDocument/definition") == 0
    assert client.request.call_args.kwargs["timeout"] > 59
    with patch.object(cli, "_client_for_file", return_value=(
        {"name": "rust-analyzer"}, source, client, source.as_uri(), source.read_text()
    )), contextlib.redirect_stdout(io.StringIO()) as out:
        client.request.side_effect = [LspError("ContentModified"), client.request.return_value]
        assert cli.command_navigate(args, root, "textDocument/definition") == 0
    assert json.loads(out.getvalue())["found"] is True
    client.wait_for_workspace.assert_called_once_with(60)

    server = {"name": "pyright", "root": root}
    client = MagicMock(capabilities={"workspaceSymbolProvider": True})
    client.__enter__.return_value = client
    client.wait_for_push_diagnostics.return_value = []

    def workspace_query(*_args, **_kwargs):
        client.wait_for_push_diagnostics.assert_called_once_with(source.as_uri(), 60)
        return []

    client.request.side_effect = workspace_query
    args.workspace, args.query = True, "missing_symbol"
    with patch.object(cli, "available_servers", return_value=[server]), \
         patch.object(cli, "servers_for_file", return_value=[server]), \
         patch.object(cli, "open_document", return_value=(source.as_uri(), source.read_text())), \
         patch.object(cli, "LspClient", return_value=client):
        with contextlib.redirect_stdout(io.StringIO()):
            assert cli.command_symbols(args, root) == 0
        client.wait_for_push_diagnostics.reset_mock()
        client.wait_for_push_diagnostics.return_value = None
        client.request.reset_mock()
        with contextlib.redirect_stdout(io.StringIO()) as out:
            assert cli.command_symbols(args, root) == 1
        assert json.loads(out.getvalue())["errors"]
        client.request.assert_not_called()

    rename_args = cli.build_parser().parse_args([
        "rename", "--file", str(source), "--line", "1", "--symbol", "hello", "--new-name", "renamed", "--json",
    ])
    edit = {"changes": {source.as_uri(): [{"range": {"start": {"line": 0, "character": 0},
                                                       "end": {"line": 0, "character": 5}}, "newText": "renamed"}]}}
    for name in ("pyright", "basedpyright"):
        server = {"name": name, "root": root, "fileTypes": [".py"]}
        client = MagicMock()
        client.wait_for_push_diagnostics.return_value = []

        def ready_rename(*_args, **_kwargs):
            client.wait_for_push_diagnostics.assert_called_once_with(source.as_uri(), rename_args.timeout)
            return edit

        client.request.side_effect = ready_rename
        with patch.object(cli, "load_config", return_value={}), \
             patch.object(cli, "available_servers", return_value=[server]), \
             patch.object(cli, "LspClient", return_value=client):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                assert cli.command_rename(rename_args, root) == 0
            assert json.loads(out.getvalue())["workspaceEdit"] == edit
            client.close.assert_called_once()
            client.reset_mock()
            client.wait_for_push_diagnostics.return_value = None
            try:
                cli.command_rename(rename_args, root)
            except TimeoutError:
                pass
            else:
                raise AssertionError("Python semantic requests must wait for file analysis")
            client.request.assert_not_called()
            client.close.assert_called_once()

    for rename_args.apply in (False, True):
        for empty in (None, {}, {"changes": {}}, {"changes": {source.as_uri(): []}},
                      {"documentChanges": [{"textDocument": {"uri": source.as_uri()}, "edits": []}]}):
            client = MagicMock()
            client.request.return_value = empty
            with patch.object(cli, "_client_for_file", return_value=(server, source, client, source.as_uri(), source.read_text())), \
                 patch.object(cli, "apply_workspace_edit") as apply:
                try:
                    cli.command_rename(rename_args, root)
                except LspError:
                    pass
                else:
                    raise AssertionError("An empty rename must fail without applying edits")
                apply.assert_not_called()
                client.close.assert_called_once()

    request_args = cli.build_parser().parse_args([
        "request", "--method", "textDocument/codeAction", "--file", str(source), "--json",
    ])
    client = MagicMock()
    client.request.return_value = [{"title": "Suggested edit", "edit": edit}]
    with patch.object(cli, "_client_for_file", return_value=(server, source, client, source.as_uri(), source.read_text())) as factory, \
         patch.object(cli, "apply_workspace_edit") as apply, contextlib.redirect_stdout(io.StringIO()) as out:
        assert cli.command_request(request_args, root) == 0
        factory.assert_called_once_with(request_args, root, allow_apply_edits=False)
        assert json.loads(out.getvalue())["applied"] is False
        apply.assert_not_called()

    with patch("codex_lsp.protocol.subprocess.Popen", side_effect=OSError("not installed")) as popen:
        try:
            LspClient({"resolvedCommand": "rust-analyzer", "name": "rust-analyzer"}, root, 5)
        except LspError:
            pass
        else:
            raise AssertionError("Missing executable must fail")
    assert popen.call_args.kwargs["env"]["RUSTUP_AUTO_INSTALL"] == "0"

print("DX checks passed")
