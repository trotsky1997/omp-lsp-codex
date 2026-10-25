import { dirname, join } from "node:path";
import { object } from "./config.ts";
import type { Options } from "./commands.ts";

export async function hook(args: Options): Promise<void> {
  const event = object(await Bun.stdin.json());
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
      ? ["status", "--builtins-only", "--global-bins-only", "--json"]
      : ["diagnostics", "--changed", "--builtins-only", "--global-bins-only", "--json"];
  try {
    const proc = Bun.spawn(
      [process.execPath, join(dirname(import.meta.path), "cli.ts"), ...command],
      {
        cwd: typeof event.cwd === "string" ? event.cwd : args.cwd,
        stdout: "pipe",
        stderr: "pipe",
        timeout: kind === "session-start" ? 8000 : 110000,
        killSignal: "SIGTERM",
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (!stdout.trim())
      throw new Error(stderr.trim() || "LSP check timed out or produced no result");
    const data = object(JSON.parse(stdout));
    if (code !== 0 && !(kind === "stop" && code === 1 && data.success === false))
      throw new Error(stderr.trim() || `LSP check exited with code ${code}`);
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
      console.log(
        JSON.stringify({
          decision: "block",
          reason: `LSP found errors in changed files. Fix them, or explain why they are expected.\n${issues.slice(0, 12).join("\n")}${issues.length > 12 ? `\n... and ${issues.length - 12} more` : ""}`,
        }),
      );
    } else if (data.success !== true)
      console.log(
        JSON.stringify({
          systemMessage:
            "LSP diagnostics could not verify every changed file; run codex-lsp diagnostics --changed to inspect the result.",
        }),
      );
    else allow();
  } catch (error) {
    if (kind === "stop")
      console.log(JSON.stringify({ systemMessage: `LSP diagnostics could not run: ${error}` }));
  }
}
