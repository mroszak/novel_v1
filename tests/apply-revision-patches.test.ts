import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { applyRevisionPatches } from "../src/pipeline/apply-revision-patches.js";
import { buildTrackedIssues } from "../src/pipeline/track-issues.js";
import type { ArtifactEnvelope, FinalAuditReport, RevisionPlan, TrackedIssue } from "../src/types/index.js";

const issue = (id: string, mandatory = true): TrackedIssue => ({
  id,
  origin: mandatory ? "audit-error-model" : "audit-warning-model",
  title: id,
  fixHint: null,
  mandatory,
});

test("applyRevisionPatches applies patches in order and reports coverage", () => {
  const trackedIssues = [issue("audit-error-model#1"), issue("audit-error-model#2")];
  const plan: RevisionPlan = {
    patches: [
      {
        errorRef: "audit-error-model#1",
        originalText: "red wire",
        replacementText: "blue wire",
        justification: "Corrects the wire color.",
      },
      {
        errorRef: "audit-error-model#2",
        originalText: "blue wire hummed",
        replacementText: "blue wire stayed silent",
        justification: "Uses the post-first-patch text.",
      },
    ],
    scopedExtension: null,
    issueOutcomes: trackedIssues.map((tracked) => ({ id: tracked.id, status: "patched", reason: "patched" })),
    notes: [],
    requiresStructuralRewrite: false,
    structuralRewriteReason: null,
  };

  const diff = applyRevisionPatches({
    prose: "The red wire hummed once.",
    plan,
    trackedIssues,
    maxPatches: 5,
  });

  assert.equal(diff.status, "applied");
  assert.equal(diff.finalProse, "The blue wire stayed silent once.");
  assert.equal(diff.appliedPatches.length, 2);
  assert.ok(diff.issueCoverage.every((entry) => entry.status === "patched"));
});

test("applyRevisionPatches skips invalid patches with stable reasons", () => {
  const trackedIssues = [issue("known"), issue("other")];
  const plan: RevisionPlan = {
    patches: [
      { errorRef: "known", originalText: "missing", replacementText: "x", justification: "none" },
      { errorRef: "known", originalText: "repeat", replacementText: "x", justification: "multi" },
      { errorRef: "unknown", originalText: "unique", replacementText: "x", justification: "unknown" },
      { errorRef: "known", originalText: "Whole prose repeat repeat unique.", replacementText: "x", justification: "whole" },
    ],
    scopedExtension: null,
    issueOutcomes: [],
    notes: [],
    requiresStructuralRewrite: false,
    structuralRewriteReason: null,
  };

  const diff = applyRevisionPatches({
    prose: "Whole prose repeat repeat unique.",
    plan,
    trackedIssues,
    maxPatches: 5,
  });

  assert.deepEqual(diff.skippedPatches.map((patch) => patch.skipReason), [
    "zero-match",
    "multi-match",
    "unknown-error-ref",
    "whole-prose-replacement",
  ]);
  assert.equal(diff.issueCoverage.find((entry) => entry.id === "known")?.status, "skip-validation");
  assert.equal(diff.issueCoverage.find((entry) => entry.id === "other")?.status, "unaddressed");
});

test("applyRevisionPatches honors patch budget", () => {
  const trackedIssues = [issue("one"), issue("two")];
  const plan: RevisionPlan = {
    patches: [
      { errorRef: "one", originalText: "one", replacementText: "1", justification: "first" },
      { errorRef: "two", originalText: "two", replacementText: "2", justification: "second" },
    ],
    scopedExtension: null,
    issueOutcomes: [],
    notes: [],
    requiresStructuralRewrite: false,
    structuralRewriteReason: null,
  };

  const diff = applyRevisionPatches({ prose: "one two", plan, trackedIssues, maxPatches: 1 });
  assert.equal(diff.finalProse, "1 two");
  assert.equal(diff.skippedPatches[0]?.skipReason, "patch-budget-exceeded");
});

test("applyRevisionPatches rejects whole-prose replacement against current working prose", () => {
  const trackedIssues = [issue("one"), issue("two")];
  const plan: RevisionPlan = {
    patches: [
      {
        errorRef: "one",
        originalText: "First sentence.",
        replacementText: "",
        justification: "Deletes the opener.",
      },
      {
        errorRef: "two",
        originalText: "Second sentence.",
        replacementText: "A full rewrite.",
        justification: "Attempts to replace the remaining whole prose.",
      },
    ],
    scopedExtension: null,
    issueOutcomes: [],
    notes: [],
    requiresStructuralRewrite: false,
    structuralRewriteReason: null,
  };

  const diff = applyRevisionPatches({
    prose: "First sentence.Second sentence.",
    plan,
    trackedIssues,
    maxPatches: 5,
  });

  assert.equal(diff.finalProse, "Second sentence.");
  assert.equal(diff.skippedPatches[0]?.skipReason, "whole-prose-replacement");
});

test("applyRevisionPatches requires covered-by-other outcomes to cite an applied issue id", () => {
  const trackedIssues = [issue("primary"), issue("secondary")];
  const plan: RevisionPlan = {
    patches: [
      {
        errorRef: "primary",
        originalText: "bad timestamp",
        replacementText: "correct timestamp",
        justification: "Fixes the timestamp.",
      },
    ],
    scopedExtension: null,
    issueOutcomes: [
      { id: "primary", status: "patched", reason: "patched directly" },
      { id: "secondary", status: "patched", reason: "patched by the same sentence" },
    ],
    notes: [],
    requiresStructuralRewrite: false,
    structuralRewriteReason: null,
  };

  const overCredited = applyRevisionPatches({
    prose: "The bad timestamp stayed.",
    plan,
    trackedIssues,
    maxPatches: 5,
  });
  assert.equal(overCredited.issueCoverage.find((entry) => entry.id === "secondary")?.status, "unaddressed");

  const explicitlyLinked = applyRevisionPatches({
    prose: "The bad timestamp stayed.",
    plan: {
      ...plan,
      issueOutcomes: [
        { id: "primary", status: "patched", reason: "patched directly" },
        { id: "secondary", status: "patched", reason: "covered by [primary]" },
      ],
    },
    trackedIssues,
    maxPatches: 5,
  });
  assert.equal(
    explicitlyLinked.issueCoverage.find((entry) => entry.id === "secondary")?.status,
    "covered-by-other",
  );
});

test("applyRevisionPatches requires exact bracketed ids for covered-by-other", () => {
  const trackedIssues = [issue("audit-error-model#1"), issue("audit-error-model#10")];
  const plan: RevisionPlan = {
    patches: [
      {
        errorRef: "audit-error-model#10",
        originalText: "bad line",
        replacementText: "fixed line",
        justification: "Fixes the directly patched issue.",
      },
    ],
    scopedExtension: null,
    issueOutcomes: [
      { id: "audit-error-model#10", status: "patched", reason: "patched directly" },
      { id: "audit-error-model#1", status: "patched", reason: "covered by audit-error-model#10" },
    ],
    notes: [],
    requiresStructuralRewrite: false,
    structuralRewriteReason: null,
  };

  const diff = applyRevisionPatches({
    prose: "The bad line stayed.",
    plan,
    trackedIssues,
    maxPatches: 5,
  });

  assert.equal(
    diff.issueCoverage.find((entry) => entry.id === "audit-error-model#1")?.status,
    "unaddressed",
  );
});

test("applyRevisionPatches applies and guards scopedExtension", () => {
  const trackedIssues = [
    { ...issue("length"), title: "Chapter under word band" },
    issue("continuity"),
  ];
  const validExtension = Array.from({ length: 50 }, (_, index) => `word${index}`).join(" ");
  const basePlan: RevisionPlan = {
    patches: [
      { errorRef: "continuity", originalText: "wrong valve", replacementText: "right valve", justification: "fixes continuity" },
    ],
    scopedExtension: validExtension,
    issueOutcomes: [
      { id: "continuity", status: "patched", reason: "patched" },
      { id: "length", status: "patched", reason: "extension" },
    ],
    notes: [],
    requiresStructuralRewrite: false,
    structuralRewriteReason: null,
  };

  const applied = applyRevisionPatches({
    prose: "The wrong valve opened.",
    plan: basePlan,
    trackedIssues,
    maxPatches: 5,
  });
  assert.ok(applied.finalProse.endsWith(validExtension));
  assert.equal(applied.issueCoverage.find((entry) => entry.id === "length")?.status, "patched");

  const skipped = applyRevisionPatches({
    prose: "The wrong valve opened.",
    plan: { ...basePlan, scopedExtension: "too short" },
    trackedIssues,
    maxPatches: 5,
  });
  assert.equal(skipped.issueCoverage.find((entry) => entry.id === "length")?.status, "unaddressed");
  assert.match(skipped.issueCoverage.find((entry) => entry.id === "length")?.reason ?? "", /scoped-extension-skipped/);
});

test("chapter 2 regression fixture can be repaired by deterministic revision patches", async () => {
  const fixtureRoot = path.join(process.cwd(), "tests", "fixtures", "chapter-2-regression");
  const candidate = JSON.parse(
    await readFile(path.join(fixtureRoot, "chapter-2-publish-candidate.json"), "utf8"),
  ) as ArtifactEnvelope<{ prose: string }>;
  const audit = JSON.parse(
    await readFile(path.join(fixtureRoot, "chapter-2-final-audit.json"), "utf8"),
  ) as ArtifactEnvelope<FinalAuditReport>;
  const trackedIssues = buildTrackedIssues({ audit: audit.data });
  const issueOutcomes = trackedIssues.map((tracked) => ({
    id: tracked.id,
    status: tracked.origin.startsWith("audit-error-model") ? "patched" as const : "skipped" as const,
    reason: tracked.origin.startsWith("audit-error-model") ? "patched" : "fixture focuses on model-confirmed surgical errors",
  }));
  const plan: RevisionPlan = {
    patches: [
      {
        errorRef: "audit-error-model#1",
        originalText: "\"Say that again.\"",
        replacementText: "\"Say that again, please, and keep the line open.\"",
        justification: "Adds the missing word-band word without changing plot facts.",
      },
      {
        errorRef: "audit-error-model#2",
        originalText: "14 SEP 79, 2318Z",
        replacementText: "15 SEP 79, 0018Z",
        justification: "Moves the Navy log into the post-midnight engagement window.",
      },
      {
        errorRef: "audit-error-model#3",
        originalText: "three nautical miles east of that quiet drop",
        replacementText: "fourteen hundred yards east of that quiet drop",
        justification: "Aligns the opening distance with the final range geometry.",
      },
      {
        errorRef: "audit-error-model#4",
        originalText: "Set,\" Ennis said quietly, \"is one hundred ten, true",
        replacementText: "Set,\" Ennis said quietly, \"is from one hundred ten, true",
        justification: "Makes the current flow toward the plotted southwest debris path.",
      },
      {
        errorRef: "audit-error-model#5",
        originalText: "The collar of Cole's dungaree shirt sat too high on his neck, the way it sat on a sailor whose neck had not yet caught up with his shirt; his face under the red lamps had a sheen.",
        replacementText: "Beckwith could hear Cole holding himself too still on the circuit, a young sailor forcing his voice flat because the math had outrun the manual.",
        justification: "Removes visual access Beckwith cannot have over the handset.",
      },
    ],
    scopedExtension: null,
    issueOutcomes,
    notes: [],
    requiresStructuralRewrite: false,
    structuralRewriteReason: null,
  };

  const diff = applyRevisionPatches({
    prose: candidate.data.prose,
    plan,
    trackedIssues,
    maxPatches: 15,
  });

  assert.equal(diff.status, "applied");
  assert.equal(diff.appliedPatches.length, 5);
  assert.equal(diff.issueCoverage.filter((entry) => entry.status === "unaddressed").length, 0);
  assert.ok(diff.finalProse.length > diff.preProse.length);
});
