import assert from "node:assert/strict";
import test from "node:test";

import { validateRevisionPlan } from "../src/pipeline/revision-plan-schema.js";

const validPlan = {
  patches: [
    {
      errorRef: "audit-error-model#1",
      originalText: "old",
      replacementText: "new",
      justification: "Fixes the issue.",
    },
  ],
  scopedExtension: null,
  issueOutcomes: [
    {
      id: "audit-error-model#1",
      status: "patched",
      reason: "patched",
    },
  ],
  notes: [],
  requiresStructuralRewrite: false,
  structuralRewriteReason: null,
};

test("validateRevisionPlan accepts a valid plan", () => {
  assert.deepEqual(validateRevisionPlan(validPlan), validPlan);
});

test("validateRevisionPlan rejects missing or mistyped required fields", () => {
  assert.throws(() => validateRevisionPlan({ ...validPlan, patches: undefined }), /patches/);
  assert.throws(
    () => validateRevisionPlan({ ...validPlan, patches: [{ errorRef: "x" }] }),
    /originalText/,
  );
  assert.throws(
    () => validateRevisionPlan({ ...validPlan, requiresStructuralRewrite: "false" }),
    /requiresStructuralRewrite/,
  );
  assert.throws(
    () => validateRevisionPlan({
      ...validPlan,
      issueOutcomes: [{ id: "x", status: "done", reason: "bad" }],
    }),
    /status/,
  );
});

test("validateRevisionPlan accepts absent scopedExtension", () => {
  const { scopedExtension, ...withoutExtension } = validPlan;
  assert.equal(scopedExtension, null);
  assert.equal(validateRevisionPlan(withoutExtension).scopedExtension, undefined);
});
