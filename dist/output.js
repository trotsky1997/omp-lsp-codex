export function textPrefix(text, maximum) {
    let end = Math.min(text.length, maximum);
    if (end < text.length && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff)
        end--;
    return text.slice(0, Math.max(0, end));
}
export function failure(error, limit = 50) {
    const original = error instanceof Error ? error.message : String(error), message = limit ? textPrefix(original, 6000) : original;
    return { success: false, error: message, ...(message.length < original.length ? { errorTruncated: true, hint: "Error text clipped; use --limit 0 --json for complete output." } : {}) };
}
export function compactText(items, fields, limit) {
    const texts = items.flatMap(item => fields.map(field => item[field]).filter((value) => typeof value === "string"));
    if (!limit || texts.reduce((sum, text) => sum + text.length, 0) <= 6000)
        return { items };
    const maximum = Math.floor(6000 / texts.length);
    return {
        items: items.map(item => {
            const row = { ...item };
            for (const field of fields)
                if (typeof row[field] === "string")
                    row[field] = textPrefix(row[field], maximum);
            return row;
        }),
        truncated: true, textTruncated: true, hint: "Text clipped; use --limit 0 --json for complete output.",
    };
}
