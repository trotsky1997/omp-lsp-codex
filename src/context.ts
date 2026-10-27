import { dirname } from "node:path";
import { object, readText, resolveFile, type ObjectValue } from "./config.ts";
import { compactText, failure } from "./output.ts";
import { syntaxLanguage, syntaxSnippet, syntaxTool } from "./syntax.ts";
import type { Position } from "./omp/types.ts";
import type { Options, Result } from "./commands.ts";

export async function inspectContext(args: Options, source: { path: string; text: string }, pos: Position, results: ObjectValue): Promise<Result> {
  const targets: { role: string; file: string; line: number; column: number }[] = [
    { role: "source", file: source.path, line: pos.line + 1, column: pos.character + 1 },
  ];
  let omitted = 0;
  for (const [section, role] of [["definition", "definition"], ["type-definition", "type"], ["references", "reference"]]) {
    const result = object(results[section]), locations = Array.isArray(result.locations) ? result.locations : [];
    const chosen = args.limit ? locations.slice(0, 3) : locations;
    omitted += Math.max(0, Number(result.total ?? locations.length) - chosen.length);
    for (const value of chosen) {
      const location = object(value);
      if (typeof location.file === "string" && Number.isSafeInteger(location.line) && Number(location.line) > 0 && Number.isSafeInteger(location.column) && Number(location.column) > 0)
        targets.push({ role, file: location.file, line: Number(location.line), column: Number(location.column) });
    }
  }
  const snippets: ObjectValue[] = [], errors: ObjectValue[] = [];
  const texts = new Map<string, string>();
  for (const target of targets) {
    try {
      const file = resolveFile(target.file, args.cwd), text = texts.get(file) ?? readText(file);
      if (file === source.path && text !== source.text) throw new Error("Source changed during inspect; retry with a current anchor");
      texts.set(file, text);
      const lines = text.split("\n"), selectedLine = lines[target.line - 1];
      if (selectedLine === undefined || target.column > selectedLine.length + 1 || selectedLine.charCodeAt(target.column - 1) >= 0xdc00 && selectedLine.charCodeAt(target.column - 1) <= 0xdfff)
        throw new Error("Context location is outside the current source or splits a UTF-16 character");
      const point = { line: target.line, column: target.column };
      const existing = snippets.find(snippet => {
        const range = snippet.range as { start: typeof point; end: typeof point };
        return snippet.file === file && (range.start.line < point.line || range.start.line === point.line && range.start.column <= point.column) &&
          (point.line < range.end.line || point.line === range.end.line && point.column < range.end.column);
      });
      if (existing) { if (!(existing.roles as string[]).includes(target.role)) (existing.roles as string[]).push(target.role); continue; }
      if (args.limit && snippets.length >= args.limit) { omitted++; continue; }
      let selected: { text: string; start: Position; end: Position } | undefined, hint: string | undefined;
      if (syntaxLanguage(file) && syntaxTool(dirname(file), args.globalBinsOnly)) {
        try { selected = await syntaxSnippet(file, text, target.line, target.column, undefined, args.globalBinsOnly); }
        catch (error) { hint = `Enclosing declaration unavailable: ${failure(error).error}`; }
      }
      if (!selected) {
        const first = Math.max(0, target.line - 4), last = Math.min(lines.length, target.line + 3);
        selected = { text: lines.slice(first, last).join("\n"), start: { line: first, character: 0 }, end: { line: last - 1, character: lines[last - 1].length } };
        hint ??= "Showing nearby lines; install ast-grep for Rust/Python/JavaScript/TypeScript enclosing declarations.";
      }
      if (readText(file) !== text) throw new Error("Context file changed while extracting its declaration; retry inspect");
      snippets.push({ file, roles: [target.role], provider: hint ? "lines" : "ast-grep",
        range: { start: { line: selected.start.line + 1, column: selected.start.character + 1 }, end: { line: selected.end.line + 1, column: selected.end.character + 1 } },
        snippet: selected.text, characters: { total: selected.text.length, shown: selected.text.length }, ...(hint ? { hint } : {}) });
    } catch (error) { errors.push({ ...target, ...failure(error, args.limit) }); }
  }
  // Check every captured file again after extraction so a later parser run cannot stale an earlier snippet.
  for (const [file, text] of texts) {
    try { if (readText(file) !== text) throw new Error("Context source changed during inspect; retry with current anchors"); }
    catch (error) { errors.push({ file, ...failure(error, args.limit) }); for (let i = snippets.length - 1; i >= 0; i--) if (snippets[i].file === file) snippets.splice(i, 1); }
  }
  const { items, ...preview } = compactText(snippets, ["snippet"], args.limit);
  for (const item of items) item.characters = { total: object(item.characters).total, shown: String(item.snippet).length };
  const truncated = !!omitted || !!preview.truncated;
  const hint = truncated ? "Context sampled or clipped; use --limit 0 --json for complete snippets and locations." : undefined;
  const success = !errors.length;
  return { data: { success, total: snippets.length, shown: items.length, omittedLocations: omitted, ...preview, truncated, snippets: items, errors, ...(hint ? { hint } : {}) },
    code: success ? 0 : 1, human: [
      ...items.map(item => `${(item.roles as string[]).join(", ")} — ${item.file}:${object(object(item.range).start).line}\n${item.snippet}${item.hint ? `\n${item.hint}` : ""}`),
      ...errors.map(error => `ERROR ${error.file}: ${error.error}`), hint,
    ].filter(Boolean).join("\n\n") };
}
