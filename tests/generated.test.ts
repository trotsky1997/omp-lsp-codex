import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeMessageFrame, MessageFramer } from "../src/omp/message-framing.ts";
import { applyTextEditsToString } from "../src/omp/text-edits.ts";
import type { TextEdit } from "../src/omp/types.ts";

function random(seed: number) {
  return (limit: number) => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % limit);
}
const tokens = ["a", " ", "中", "😀", "\n", "\r\n", "\uFEFF", "_", '"'];
function text(next: (limit: number) => number, count: number) {
  return Array.from({ length: count }, () => tokens[next(tokens.length)]).join("");
}
function position(source: string, offset: number) {
  const prefix = source.slice(0, offset).split("\n");
  return { line: prefix.length - 1, character: prefix.at(-1)!.length };
}

for (const [caseIndex, caseValue] of ([42, 20261026, 0x5eed]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = seed => {
  const next = random(seed);
  for (let trial = 0; trial < 150; trial++) {
    let source = "", expected = "";
    const changes: { start: number; end: number; value: string }[] = [];
    for (let index = 0; index < 8; index++) {
      const before = text(next, next(5)), old = text(next, 1 + next(5)), value = text(next, next(5));
      source += before; const start = source.length; source += old;
      changes.push({ start, end: source.length, value }); expected += before + value;
    }
    const tail = text(next, next(5)); source += tail; expected += tail;
    changes.push({ ...changes[next(changes.length)] });
    for (const value of ["first\n", "second😀"]) changes.push({ start: source.length, end: source.length, value });
    for (let index = changes.length - 1; index > 0; index--) {
      const other = next(index + 1); [changes[index], changes[other]] = [changes[other], changes[index]];
    }
    const edits: TextEdit[] = changes.map(change => ({ range: { start: position(source, change.start), end: position(source, change.end) }, newText: change.value }));
    expected += changes.filter(change => change.start === change.end).map(change => change.value).join("");
    assert.strictEqual(applyTextEditsToString(source, edits), expected);
  }
};
  test("generated edits: shuffled Unicode/CRLF batches match the string oracle, seed=%s".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};

for (const [caseIndex, caseValue] of ([42, 20261026, 0x5eed]).entries()) {
  const runCase: (value: typeof caseValue) => void | Promise<void> = seed => {
  const next = random(seed), messages = Array.from({ length: 256 }, (_, id) => ({ jsonrpc: "2.0", id, result: { text: text(next, next(24)), values: [id, null, true] } }));
  const bytes = Buffer.concat(messages.map(encodeMessageFrame)), framer = new MessageFramer(Buffer.alloc(0)), received: unknown[] = [];
  for (let offset = 0; offset < bytes.length;) {
    const end = Math.min(bytes.length, offset + 1 + next(97));
    framer.push(bytes.subarray(offset, end)); offset = end;
    received.push(...[...framer.drain(header => { throw new Error(`Unexpected header: ${header}`); })].map(value => JSON.parse(value)));
  }
  assert.deepStrictEqual(received, messages);
};
  test("generated framing: randomly fragmented multi-message streams preserve JSON, seed=%s".replaceAll(/%s|%j|%#/g, token => token === "%#" ? String(caseIndex) : token === "%j" ? JSON.stringify(caseValue) ?? String(caseValue) : String(caseValue)), () => runCase(caseValue));
};
