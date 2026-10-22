import json
import os
import subprocess
import sys
from pathlib import Path


def main() -> int:
    event = json.load(sys.stdin)
    plugin_root = Path(os.environ.get("PLUGIN_ROOT", Path(__file__).resolve().parents[1]))
    cli = plugin_root / "bin" / "codex-lsp"
    try:
        result = subprocess.run(
            [sys.executable, str(cli), "status", "--json"],
            cwd=event.get("cwd") or None,
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
        data = json.loads(result.stdout)
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return 0
    servers = data.get("servers", [])
    if servers:
        names = ", ".join(item["name"] for item in servers[:12])
        if len(servers) > 12:
            names += f", and {len(servers) - 12} more"
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": f"Available LSP servers: {names}. Use the codex-lsp skill for navigation and diagnostics.",
            }
        }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
