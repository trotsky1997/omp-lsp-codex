export function textPrefix(text: string, maximum: number): string {
  let end = Math.min(text.length, maximum);
  if (end < text.length && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
  return text.slice(0, Math.max(0, end));
}

export function failure(error: unknown, limit = 50) {
  const original = error instanceof Error ? error.message : String(error), message = limit ? textPrefix(original, 6000) : original;
  return { success: false, error: message, ...(message.length < original.length ? { errorTruncated: true, hint: "Error text clipped; use --limit 0 --json for complete output." } : {}) };
}
