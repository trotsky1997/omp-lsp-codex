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

with TemporaryDirectory() as directory:
    root = Path(directory)
    source = root / "source.py"
    source.write_text("hello = 1\n")
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

    with patch("codex_lsp.protocol.subprocess.Popen", side_effect=OSError("not installed")) as popen:
        try:
            LspClient({"resolvedCommand": "rust-analyzer", "name": "rust-analyzer"}, root, 5)
        except LspError:
            pass
        else:
            raise AssertionError("Missing executable must fail")
    assert popen.call_args.kwargs["env"]["RUSTUP_AUTO_INSTALL"] == "0"

print("DX checks passed")
