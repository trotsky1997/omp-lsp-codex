import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetData } from "../src/budget.ts";

test("tooling budgets: flattened lint counts follow visible diagnostics rather than provider summaries", () => {
  const data = budgetData({ success: true, verified: true, hasErrors: true, total: 30, shown: 30, diagnosticCount: 30,
    checked: [{ file: "/source.ts", diagnosticCount: 30, providers: [{ name: "eslint", verified: true }] }],
    diagnostics: Array.from({ length: 30 }, (_, line) => ({ line, message: "issue ".repeat(100) })),
  }, 1000);
  assert.equal(data.shown, (data.diagnostics as unknown[]).length); assert.equal(data.total, 30); assert.equal(data.diagnosticCount, 30);
  assert.ok(JSON.stringify(data).length <= 1000); assert.equal(data.truncated, true);
});

test("tooling budgets: edit-plan and format-check shown counts follow visible files", () => {
  for (const command of ["plan", "check"]) {
    const data = budgetData({ success: true, applied: false, command: command === "check" ? "format" : "lint", ...(command === "check" ? { check: true } : { saved: true }),
      total: 3, shown: 3, diagnosticCount: 1, checked: [{ file: "/a.ts", diagnosticCount: 1 }],
      diagnostics: [{ message: "lint issue" }], files: Array.from({ length: 3 }, (_, index) => ({ file: `/${index}.ts`, diff: "diff ".repeat(1000) })),
    }, 1000);
    assert.equal(data.shown, (data.files as unknown[]).length); assert.equal(data.total, 3); assert.equal(data.diagnosticCount, 1);
    assert.ok(JSON.stringify(data).length <= 1000); assert.equal(data.truncated, true);
  }
});
