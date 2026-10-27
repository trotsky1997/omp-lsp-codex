import { textPrefix } from "./output.js";
const textFields = new Set(["hover", "snippet", "documentation", "detail", "message", "error", "hint", "description", "title"]);
const omittedFields = new Set(["workspaceEdit", "workspaceEdits", "data", "relatedInformation"]);
const flags = ["truncated", "textTruncated", "errorTruncated", "workspaceEditOmitted", "detailsOmitted"];
export function budgetData(data, maximum) {
    if (!Number.isSafeInteger(maximum) || maximum < 512)
        throw new Error("--budget must be an integer of at least 512 characters");
    const originalCharacters = JSON.stringify(data).length, result = structuredClone(data);
    const budget = { maximum, originalCharacters, characters: 0, omittedItems: 0, omittedFields: 0, clipped: false };
    result.budget = budget;
    const size = () => {
        for (let i = 0; i < 4; i++)
            budget.characters = JSON.stringify(result).length;
        return Number(budget.characters);
    };
    if (size() <= maximum)
        return result;
    const texts = [];
    const arrays = [];
    const initialFlags = new Map();
    const visit = (owner, path) => {
        initialFlags.set(owner, Object.fromEntries(flags.filter(key => Object.hasOwn(owner, key)).map(key => [key, owner[key]])));
        for (const [key, value] of Object.entries(owner)) {
            if (key === "budget")
                continue;
            if (key === "hint" && owner.success === true && owner.supported !== false && owner.found !== false && owner.verified !== false && owner.total !== 0) {
                delete owner[key];
                budget.omittedFields = Number(budget.omittedFields) + 1;
            }
            else if (omittedFields.has(key)) {
                delete owner[key];
                budget.omittedFields = Number(budget.omittedFields) + 1;
                owner[key.startsWith("workspaceEdit") ? "workspaceEditOmitted" : "detailsOmitted"] = true;
                initialFlags.get(owner)[key.startsWith("workspaceEdit") ? "workspaceEditOmitted" : "detailsOmitted"] = true;
            }
            else if (typeof value === "string" && textFields.has(key)) {
                texts.push({ owner, key, value, state: owner, minimum: key === "error" ? 32 : key === "message" ? 24 : 0 });
            }
            else if (Array.isArray(value)) {
                if (["locations", "symbols", "diagnostics", "edits", "snippets"].includes(key)) {
                    const rank = path.endsWith(".references") ? 0 : key === "symbols" ? 1 : key === "diagnostics" ? 2 : path.endsWith(".type-definition") ? 3 : key === "edits" ? 4 : key === "snippets" ? 5 : 6;
                    arrays.push({ owner, key, items: value, length: value.length, rank, minimum: key === "snippets" ? 2 : path.endsWith(".definition") ? 1 : 0 });
                }
                for (const [index, item] of value.entries()) {
                    if (item && typeof item === "object" && !Array.isArray(item))
                        visit(item, `${path}.${key}`);
                    else if (key === "errors" && typeof item === "string")
                        texts.push({ owner: value, key: String(index), value: item, state: owner, minimum: 32 });
                }
            }
            else if (value && typeof value === "object")
                visit(value, `${path}.${key}`);
        }
    };
    visit(result, "");
    arrays.sort((a, b) => a.rank - b.rank);
    const apply = (cap) => {
        let clipped = Number(budget.omittedItems) > 0 || Number(budget.omittedFields) > 0;
        for (const [owner, original] of initialFlags)
            for (const key of flags) {
                if (Object.hasOwn(original, key))
                    owner[key] = original[key];
                else
                    delete owner[key];
            }
        for (const text of texts) {
            const shown = textPrefix(text.value, Math.max(text.minimum, cap));
            text.owner[text.key] = shown;
            if (shown.length < text.value.length) {
                clipped = true;
                text.state.truncated = true;
                text.state[text.key === "error" || Array.isArray(text.owner) ? "errorTruncated" : "textTruncated"] = true;
            }
            if (["hover", "snippet"].includes(text.key)) {
                const characters = text.owner.characters;
                if (characters && typeof characters === "object")
                    characters.shown = shown.length;
                if (text.key === "hover" && Object.hasOwn(text.owner, "shown"))
                    text.owner.shown = shown ? shown.split("\n").length : 0;
            }
        }
        for (const array of arrays) {
            if (Object.hasOwn(array.owner, "shown"))
                array.owner.shown = array.items.length;
            if (array.items.length < array.length)
                array.owner.truncated = true;
        }
        for (const owner of initialFlags.keys())
            if (Array.isArray(owner.checked) && Object.hasOwn(owner, "shown"))
                owner.shown = owner.checked.reduce((sum, row) => sum + (Array.isArray(row.diagnostics) ? row.diagnostics.length : 0), 0);
        budget.clipped = clipped;
        if (clipped) {
            result.truncated = true;
            budget.hint = "Output clipped by --budget; increase it or omit --budget.";
        }
        else
            delete budget.hint;
        return size();
    };
    const prune = (target, retainFirst) => {
        while (apply(0) > target) {
            const array = arrays.find(array => array.items.length > (retainFirst ? array.minimum : 0));
            if (!array)
                break;
            array.items.pop();
            budget.omittedItems = Number(budget.omittedItems) + 1;
        }
    };
    // Reserve some of the shared budget for source text after structural previews.
    prune(maximum - Math.min(1024, Math.floor(maximum / 3)), true);
    prune(maximum, false);
    const minimum = apply(0);
    if (minimum > maximum)
        throw new Error(`Budget ${maximum} cannot retain required inspection state (${minimum} characters); increase --budget or select fewer fields`);
    let low = 0, high = Math.max(0, ...texts.map(text => text.value.length));
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (apply(middle) <= maximum)
            low = middle;
        else
            high = middle - 1;
    }
    apply(low);
    return result;
}
