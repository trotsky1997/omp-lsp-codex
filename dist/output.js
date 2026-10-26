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
const STATE_FIELDS = ["success", "found", "supported", "provider", "verified", "hasErrors", "applied", "verification", "failedSections", "error", "errors", "hint", "truncated", "textTruncated", "errorTruncated", "documentationOmitted", "detailsOmitted", "workspaceEditOmitted"];
export function selectFields(data, fields) {
    const selected = new Map(), missing = [];
    const state = (value, prefix) => {
        for (const key of STATE_FIELDS)
            if (Object.hasOwn(value, key) && value[key] !== undefined)
                selected.set(prefix + key, value[key]);
    };
    state(data, "");
    for (const field of fields) {
        const parts = field.split(".");
        let value = data, found = true;
        for (let index = 0; index < parts.length; index++) {
            if (value === null || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, parts[index]) || value[parts[index]] === undefined) {
                found = false;
                break;
            }
            value = value[parts[index]];
            if (index < parts.length - 1 && value !== null && typeof value === "object" && !Array.isArray(value))
                state(value, parts.slice(0, index + 1).join(".") + ".");
        }
        if (found)
            selected.set(field, value);
        else
            missing.push(field);
    }
    const result = Object.create(null);
    for (const [field, value] of selected) {
        const parts = field.split(".");
        if (parts.some((_, index) => index > 0 && selected.has(parts.slice(0, index).join("."))))
            continue;
        let target = result;
        for (const part of parts.slice(0, -1)) {
            target[part] ??= Object.create(null);
            target = target[part];
        }
        target[parts.at(-1)] = value;
    }
    if (missing.length)
        result.missingFields = missing;
    return result;
}
