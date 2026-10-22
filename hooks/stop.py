import json
import os
import subprocess
import sys
from pathlib import Path


def emit(value: dict) -> None:
    print(json.dumps(value, ensure_ascii=False))


def main() -> int:
    event = json.load(sys.stdin)
    if event.get("stop_hook_active"):
        emit({"continue": True})
        return 0

    plugin_root = Path(os.environ.get("PLUGIN_ROOT", Path(__file__).resolve().parents[1]))
    cli = plugin_root / "bin" / "codex-lsp"
    try:
        result = subprocess.run(
            [sys.executable, str(cli), "diagnostics", "--changed", "--builtins-only", "--global-bins-only", "--json"],
            cwd=event.get("cwd") or None,
            capture_output=True,
            text=True,
            timeout=110,
            check=False,
        )
        data = json.loads(result.stdout)
    except subprocess.TimeoutExpired:
        emit({"systemMessage": "LSP diagnostics timed out; the turn can stop, and the CLI remains available for a manual check."})
        return 0
    except (OSError, json.JSONDecodeError) as exc:
        emit({"systemMessage": f"LSP diagnostics could not run: {exc}"})
        return 0

    if data.get("hasErrors"):
        issues = []
        for item in data.get("checked", []):
            for diagnostic in item.get("diagnostics", []):
                if diagnostic.get("severity", 1) == 1:
                    start = diagnostic.get("range", {}).get("start", {})
                    issues.append(f"{item['file']}:{start.get('line', 0) + 1}: {diagnostic.get('message', '')}")
        summary = "\n".join(issues[:12])
        if len(issues) > 12:
            summary += f"\n... and {len(issues) - 12} more"
        emit({"decision": "block", "reason": f"LSP found errors in changed files. Fix them, or explain why they are expected.\n{summary}"})
    else:
        emit({"continue": True})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
