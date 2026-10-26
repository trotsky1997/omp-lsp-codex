import { join } from "node:path";
import childProcess from "node:child_process";
import { json } from "node:stream/consumers";
import { object } from "./config.ts";
import type { Options } from "./commands.ts";
import { failure, textPrefix } from "./output.ts";

export async function hook(args: Options): Promise<void> {
  const event = object(await json(process.stdin));
  const kind = args.languages[0];
  const claude = !!process.env.CLAUDE_PLUGIN_ROOT;
  const allow = () => {
    if (!claude) console.log(JSON.stringify({ continue: true }));
  };
  if (kind !== "session-start" && kind !== "stop")
    throw new Error("Use hook session-start or hook stop");
  if (kind === "stop" && event.stop_hook_active) {
    allow();
    return;
  }
  const command =
    kind === "session-start"
      ? ["status", "--global-config-only", "--global-bins-only", "--json"]
      : ["diagnostics", "--changed", "--global-config-only", "--global-bins-only", "--limit", "12", "--json"];
  try {
    const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
      childProcess.execFile(process.execPath,
        [join(import.meta.dirname, "cli.js"), ...command, "--cwd", typeof event.cwd === "string" ? event.cwd : args.cwd],
        { cwd: args.cwd, encoding: "utf8", timeout: kind === "session-start" ? 8000 : 110000, killSignal: "SIGTERM", maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error && (typeof error.code !== "number" || error.killed || error.signal)) reject(error);
          else resolve({ stdout, stderr, code: error?.code as number ?? 0 });
        });
    });
    if (!stdout.trim())
      throw new Error(stderr.trim() || "LSP check timed out or produced no result");
    const data = object(JSON.parse(stdout));
    if (code !== 0 && !(kind === "stop" && code === 1 && data.success === false))
      throw new Error(typeof data.error === "string" ? data.error : stderr.trim() || `LSP check exited with code ${code}`);
    if (kind === "session-start") {
      const servers = Array.isArray(data.servers) ? data.servers : [];
      if (servers.length)
        console.log(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "SessionStart",
              additionalContext: `Available LSP servers: ${servers
                .slice(0, 12)
                .map((x) => object(x).name)
                .join(", ")}. Use the codex-lsp skill and CLI for navigation and diagnostics.`,
            },
          }),
        );
      return;
    }
    if (data.hasErrors === true) {
      const issues: string[] = [];
      for (const file of Array.isArray(data.checked) ? data.checked : [])
        for (const diagnostic of Array.isArray(object(file).diagnostics)
          ? (object(file).diagnostics as unknown[])
          : []) {
          const item = object(diagnostic);
          if ((item.severity ?? 1) === 1)
            issues.push(
              `${object(file).file}:${Number(object(object(item.range).start).line ?? 0) + 1}: ${item.message}`,
            );
        }
      const shown = issues.slice(0, 12), maximum = Math.floor(6000 / Math.max(1, shown.length));
      const total = Math.max(issues.length, Number(object(data.counts).errors) || 0);
      const clipped = shown.some(issue => issue.length > maximum);
      console.log(
        JSON.stringify({
          decision: "block",
          reason: `LSP found errors in changed files. Fix them, or explain why they are expected.\n${shown.map(issue => textPrefix(issue, maximum)).join("\n")}${total > shown.length ? `\n... and ${total - shown.length} more` : ""}${clipped || data.truncated ? "\nRun codex-lsp diagnostics --changed --global-config-only --global-bins-only --limit 0 --json for complete details." : ""}`,
        }),
      );
    } else if (data.success !== true) {
      const reasons = (Array.isArray(data.checked) ? data.checked : []).flatMap((file) => {
        const row = object(file);
        return (Array.isArray(row.errors) ? row.errors : [])
          .filter((error) => typeof error === "string")
          .map((error) => `${row.file}: ${error}`.slice(0, 300));
      }).slice(0, 3);
      console.log(
        JSON.stringify({
          systemMessage: ["LSP diagnostics could not verify every changed file; run codex-lsp --cwd <project-root> diagnostics --changed to inspect the result.", ...reasons].join("\n"),
        }),
      );
    } else allow();
  } catch (error) {
    if (kind === "stop") {
      const result = failure(error);
      console.log(JSON.stringify({ systemMessage: [`LSP diagnostics could not run: ${result.error}`, result.hint].filter(Boolean).join("\n") }));
    }
  }
}
