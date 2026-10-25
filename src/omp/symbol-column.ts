import {readFile} from "node:fs/promises";
const readTextFromDisk=(file:string)=>readFile(file,"utf8");
const isEnoent=(error:unknown)=>!!error && typeof error==="object" && "code" in error && error.code==="ENOENT";

function firstNonWhitespaceColumn(lineText: string): number {
	const match = lineText.match(/\S/);
	return match ? (match.index ?? 0) : 0;
}

const BARE_IDENTIFIER_RE = /^[$A-Za-z_][\w$]*$/;
const IDENTIFIER_CHAR_RE = /[A-Za-z0-9_$]/;

function findSymbolMatchIndexes(lineText: string, symbol: string, caseInsensitive = false): number[] {
	if (symbol.length === 0) return [];
	const haystack = caseInsensitive ? lineText.toLowerCase() : lineText;
	const needle = caseInsensitive ? symbol.toLowerCase() : symbol;
	const requireWordBoundary = BARE_IDENTIFIER_RE.test(symbol);
	const indexes: number[] = [];
	let fromIndex = 0;
	while (fromIndex <= haystack.length - needle.length) {
		const matchIndex = haystack.indexOf(needle, fromIndex);
		if (matchIndex === -1) break;
		if (requireWordBoundary) {
			const before = matchIndex > 0 ? haystack[matchIndex - 1] : "";
			const afterIdx = matchIndex + needle.length;
			const after = afterIdx < haystack.length ? haystack[afterIdx] : "";
			if (IDENTIFIER_CHAR_RE.test(before) || IDENTIFIER_CHAR_RE.test(after)) {
				fromIndex = matchIndex + 1;
				continue;
			}
		}
		indexes.push(matchIndex);
		fromIndex = matchIndex + needle.length;
	}
	return indexes;
}

/**
 * Parses a symbol spec of the form `name` or `name#N` where N is the 1-indexed
 * occurrence on the target line. Returns `name` and `occurrence` (default 1).
 *
 * Greedy match on `.+` so `#name#2` parses as symbol=`#name` (TS private field)
 * with occurrence 2. Specs without a trailing `#\d+` are treated as literal.
 */
function parseSymbolSpec(spec: string): { symbol: string; occurrence: number } {
	const match = spec.match(/^(.+)#(\d+)$/);
	if (!match) return { symbol: spec, occurrence: 1 };
	const occurrence = Math.max(1, Number.parseInt(match[2], 10));
	return { symbol: match[1], occurrence };
}

export async function resolveSymbolColumn(filePath: string, line: number, symbolSpec?: string): Promise<number> {
	const lineNumber = Math.max(1, line);
	try {
		const fileText = await readTextFromDisk(filePath);
		const lines = fileText.split("\n");
		const targetLine = lines[lineNumber - 1] ?? "";
		if (!symbolSpec) {
			return firstNonWhitespaceColumn(targetLine);
		}

		const { symbol, occurrence } = parseSymbolSpec(symbolSpec);
		const exactIndexes = findSymbolMatchIndexes(targetLine, symbol);
		const fallbackIndexes = exactIndexes.length > 0 ? exactIndexes : findSymbolMatchIndexes(targetLine, symbol, true);
		if (fallbackIndexes.length === 0) {
			throw new Error(`Symbol "${symbol}" not found on line ${lineNumber}`);
		}
		if (occurrence > fallbackIndexes.length) {
			throw new Error(
				`Symbol "${symbol}" occurrence ${occurrence} is out of bounds on line ${lineNumber} (found ${fallbackIndexes.length})`,
			);
		}
		return fallbackIndexes[occurrence - 1];
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`File not found: ${filePath}`);
		}
		throw error;
	}
}
