import assert from "node:assert/strict";
import test from "node:test";

import { buildTrackedIssues } from "../src/pipeline/track-issues.js";
import type { DraftReview, FinalAuditReport, ReviewScoreBreakdown } from "../src/types/index.js";

const scores: ReviewScoreBreakdown = {
  beatCoverage: 90,
  tension: 90,
  forwardMotion: 90,
  characterTruth: 90,
  voiceConsistency: 90,
  specificity: 90,
  thematicEmbodiment: 90,
  openingPower: 90,
  endingHookStrength: 90,
  revealControl: 90,
  freshness: 90,
  repetitionPenalty: 5,
  proseQuality: 90,
  dialogueAuthenticity: 90,
  sensoryImmersion: 90,
};

test("buildTrackedIssues assigns stable judge origins and mandatory flags", () => {
  const review: DraftReview = {
    candidateId: "draft",
    overallScore: 80,
    passesThreshold: false,
    scoreBreakdown: scores,
    strengths: [],
    weaknesses: ["Weakness"],
    blockingIssues: ["Blocker"],
    revisionActions: ["Revise this"],
    issues: [
      { severity: "error", category: "POV", detail: "Leak", suggestedFix: "Remove it" },
      { severity: "warning", category: "Style", detail: "Dense" },
    ],
    summary: "Needs work.",
  };

  const issues = buildTrackedIssues({ review });
  assert.deepEqual(issues.map((issue) => issue.id), [
    "judge-blocking#1",
    "judge-weakness#1",
    "judge-revision-action#1",
    "judge-issue-error#1",
    "judge-issue-warning#1",
  ]);
  assert.equal(issues.find((issue) => issue.origin === "judge-issue-warning")?.mandatory, false);
  assert.ok(issues.filter((issue) => issue.origin !== "judge-issue-warning").every((issue) => issue.mandatory));
});

test("buildTrackedIssues distinguishes model and validator audit findings", () => {
  const audit: FinalAuditReport = {
    status: "issues_found",
    summary: "Issues.",
    factualConfidence: 0.8,
    requiresFix: true,
    issues: [
      { severity: "error", title: "Model error", description: "x", fixInstruction: "fix", source: "model" },
      { severity: "error", title: "Validator error", description: "x", fixInstruction: "fix", source: "validator" },
      { severity: "warning", title: "Model warning", description: "x", fixInstruction: "fix", source: "model" },
      { severity: "warning", title: "Validator warning", description: "x", fixInstruction: "fix", source: "validator" },
    ],
  };

  const issues = buildTrackedIssues({ audit });
  assert.deepEqual(issues.map((issue) => issue.id), [
    "audit-error-model#1",
    "audit-error-validator#1",
    "audit-warning-model#1",
    "audit-warning-validator#1",
  ]);
  assert.equal(issues.find((issue) => issue.id === "audit-error-validator#1")?.mandatory, true);
  assert.equal(issues.find((issue) => issue.id === "audit-warning-validator#1")?.mandatory, false);
});
