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

test("tooling budgets: provider details yield space to plan state while scope totals stay exact", () => {
  const data = budgetData({ command: "lint", success: true, verified: true, hasErrors: true, applied: false,
    saved: true, plan: "/tmp/fix.json", checkedFiles: 20, changedFiles: 1, diagnosticCount: 2, ignoredFiles: 1, skippedCount: 1,
    total: 1, shown: 1, diagnostics: [{ message: "unused import" }], files: [{ file: "/source.py", diff: "diff ".repeat(1000) }],
    checked: Array.from({ length: 20 }, () => ({ file: "/long/project/path/".repeat(20) + "source.py", verified: true, providers: [{ name: "ruff", command: "/venv/".repeat(30) + "ruff", verified: true }] })),
  }, 1000);
  assert.ok(JSON.stringify(data).length <= 1000); assert.equal(data.saved, true); assert.equal(data.plan, "/tmp/fix.json");
  assert.equal(data.verified, true); assert.equal(data.hasErrors, true); assert.equal(data.checkedFiles, 20); assert.equal(data.changedFiles, 1);
  assert.equal(data.diagnosticCount, 2); assert.equal(data.ignoredFiles, 1); assert.equal(data.skippedCount, 1);
  assert.equal(data.checkedTotal, 20); assert.equal(data.checkedShown, (data.checked as unknown[]).length);
  assert.equal(data.shown, (data.files as unknown[]).length); assert.equal(data.truncated, true);
});

test("tooling budgets: applied verification keeps its state and comparison counts within a small budget", () => {
  const data = budgetData({ success: true, applied: true, applicationState: "applied", verification: "pending", toolVerification: "verified", plan: "/tmp/fixes.json",
    files: ["/source.py"], toolResults: { success: true, verified: true, hasErrors: false,
      checked: [{ file: "/long/project/".repeat(40) + "source.py", verified: true, diagnosticCount: 0, providers: [{ name: "ruff", command: "/venv/".repeat(40) + "ruff", verified: true }] }],
      errors: [],
    },
    comparison: { verified: true, matching: "file, trimmed source line, severity, code, source and message (multiset)", newErrors: 0, counts: { new: 0, resolved: 2, existing: 0 },
      new: { total: 0, shown: 0, truncated: false, issues: [] }, existing: { total: 0, shown: 0, truncated: false, issues: [] },
      resolved: { total: 2, shown: 2, truncated: false, issues: Array.from({ length: 2 }, () => ({ file: "/long/project/".repeat(20) + "source.py", message: "unused import", severity: 1 })) },
    },
  }, 1000);
  assert.ok(JSON.stringify(data).length <= 1000); assert.equal(data.applied, true); assert.equal(data.applicationState, "applied"); assert.equal(data.toolVerification, "verified");
  const results = data.toolResults as Record<string, unknown>, comparison = data.comparison as Record<string, unknown>;
  assert.equal(results.verified, true); assert.equal(results.hasErrors, false); assert.equal(comparison.verified, true); assert.equal(comparison.newErrors, 0);
  assert.deepEqual(comparison.counts, { new: 0, resolved: 2, existing: 0 }); assert.equal(data.truncated, true);
});
