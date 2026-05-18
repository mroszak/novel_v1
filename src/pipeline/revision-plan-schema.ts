import type { RevisionPlan } from "../types/index.js";

function assertObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string.`);
  }
}

function assertStringOrNull(value: unknown, path: string): asserts value is string | null {
  if (value !== null && typeof value !== "string") {
    throw new Error(`${path} must be a string or null.`);
  }
}

function assertBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean.`);
  }
}

function assertStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  value.forEach((item, index) => assertString(item, `${path}[${index}]`));
}

const OUTCOME_STATUSES = new Set(["patched", "skipped", "unaddressed"]);

export function validateRevisionPlan(raw: unknown): RevisionPlan {
  assertObject(raw, "RevisionPlan");

  if (!Array.isArray(raw.patches)) {
    throw new Error("RevisionPlan.patches must be an array.");
  }
  raw.patches.forEach((patch, index) => {
    assertObject(patch, `RevisionPlan.patches[${index}]`);
    assertString(patch.errorRef, `RevisionPlan.patches[${index}].errorRef`);
    assertString(patch.originalText, `RevisionPlan.patches[${index}].originalText`);
    assertString(patch.replacementText, `RevisionPlan.patches[${index}].replacementText`);
    assertString(patch.justification, `RevisionPlan.patches[${index}].justification`);
  });

  if (raw.scopedExtension !== undefined) {
    assertStringOrNull(raw.scopedExtension, "RevisionPlan.scopedExtension");
  }

  if (!Array.isArray(raw.issueOutcomes)) {
    throw new Error("RevisionPlan.issueOutcomes must be an array.");
  }
  raw.issueOutcomes.forEach((outcome, index) => {
    assertObject(outcome, `RevisionPlan.issueOutcomes[${index}]`);
    assertString(outcome.id, `RevisionPlan.issueOutcomes[${index}].id`);
    assertString(outcome.status, `RevisionPlan.issueOutcomes[${index}].status`);
    if (!OUTCOME_STATUSES.has(outcome.status)) {
      throw new Error(`RevisionPlan.issueOutcomes[${index}].status is not supported.`);
    }
    assertString(outcome.reason, `RevisionPlan.issueOutcomes[${index}].reason`);
  });

  assertStringArray(raw.notes, "RevisionPlan.notes");
  assertBoolean(raw.requiresStructuralRewrite, "RevisionPlan.requiresStructuralRewrite");
  assertStringOrNull(raw.structuralRewriteReason, "RevisionPlan.structuralRewriteReason");

  return {
    patches: raw.patches,
    scopedExtension: raw.scopedExtension,
    issueOutcomes: raw.issueOutcomes,
    notes: raw.notes,
    requiresStructuralRewrite: raw.requiresStructuralRewrite,
    structuralRewriteReason: raw.structuralRewriteReason,
  } as RevisionPlan;
}
