export function parseRange(value) {
    const match = /^([1-9]\d*):([1-9]\d*)-([1-9]\d*):([1-9]\d*)$/.exec(value);
    const numbers = match?.slice(1).map(Number);
    if (!numbers || !numbers.every(Number.isSafeInteger))
        throw new Error("--range must be START_LINE:COL-END_LINE:COL, using one-based UTF-16 positions");
    const [line, character, endLine, endCharacter] = numbers.map(value => value - 1);
    if (endLine < line || endLine === line && endCharacter < character)
        throw new Error("--range end must follow its start");
    return { start: { line, character }, end: { line: endLine, character: endCharacter } };
}
