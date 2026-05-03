import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import { cleanupTempRoot, createTempRoot, readJson, runChapterCli, writeRootBlueprint } from "./helpers.js";
import { INVALID_BLUEPRINT } from "./fixtures/blueprint-fixture.js";

test("smoke pipeline writes delta and rolling memory artifacts", async (t) => {
  const rootDir = await createTempRoot();
  t.after(async () => {
    await cleanupTempRoot(rootDir);
  });

  const run1 = runChapterCli(["--smoke"], rootDir);
  assert.equal(run1.status, 0, run1.stderr || run1.stdout);

  const delta = await readJson<any>(path.join(rootDir, "artifacts", "chapters", "chapter-1-delta.json"));
  const memory = await readJson<any>(path.join(rootDir, "artifacts", "memory", "after-chapter-1.json"));

  assert.ok(Array.isArray(delta.data.entityMentions));
  assert.ok(delta.data.entityMentions.length > 0);
  assert.equal(typeof delta.data.nextChapterOpeningHandoff, "string");
  assert.ok(Array.isArray(memory.data.unresolvedThreads));
  assert.equal(typeof memory.data.nextChapterOpeningHandoff.openingSituation, "string");
  assert.ok(Array.isArray(delta.data.characterEmotionalStates), "delta must include characterEmotionalStates");
  assert.ok(Array.isArray(memory.data.emotionalStates), "memory must include emotionalStates");
  assert.ok(Array.isArray(memory.data.nextChapterOpeningHandoff.characterStates), "handoff must include characterStates");

  const run2 = runChapterCli(["--smoke", "--chapter", "2"], rootDir);
  assert.equal(run2.status, 0, run2.stderr || run2.stdout);
  const memory2 = await readJson<any>(path.join(rootDir, "artifacts", "memory", "after-chapter-2.json"));
  assert.ok(memory2.data.lastChapterSummary.includes("Chapter 2"));
});

test("smoke rerun and estimate paths reuse checkpoints", async (t) => {
  const rootDir = await createTempRoot();
  t.after(async () => {
    await cleanupTempRoot(rootDir);
  });

  assert.equal(runChapterCli(["--smoke"], rootDir).status, 0);

  const rerun = runChapterCli(["--smoke", "--rerun-from", "judge"], rootDir);
  assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
  assert.match(rerun.stdout, /Reused artifacts:/);

  const auditOnly = runChapterCli(["--smoke", "--audit-only"], rootDir);
  assert.equal(auditOnly.status, 0, auditOnly.stderr || auditOnly.stdout);
  assert.match(auditOnly.stdout, /selected-review/);

  const estimate = runChapterCli(["--smoke", "--estimate-cost"], rootDir);
  assert.equal(estimate.status, 0, estimate.stderr || estimate.stdout);
  const costEstimate = await readJson<any>(path.join(rootDir, "artifacts", "chapters", "chapter-1-cost-estimate.json"));
  assert.ok(Array.isArray(costEstimate.data.stages));
  assert.ok(costEstimate.data.stages.length > 0);
  assert.ok(
    costEstimate.data.stages.every((stage: any) => stage.withinBudget === true),
    "smoke estimate should keep every stage within budget",
  );

  const stageNames: string[] = costEstimate.data.stages.map((s: any) => s.stage);
  assert.ok(stageNames.includes("spec-critique"), "must include spec-critique");
  assert.ok(stageNames.includes("literary-judge-revision"), "must include revision judge stage");
  assert.ok(stageNames.includes("final-audit-localized-1"), "must include localized re-audit stage");
});

test("cost estimate with --skip-spec-critique suppresses critique for non-high-risk chapters", async (t) => {
  const rootDir = await createTempRoot();
  t.after(async () => {
    await cleanupTempRoot(rootDir);
  });

  // Chapter 2 needs chapter 1's memory
  assert.equal(runChapterCli(["--smoke"], rootDir).status, 0);

  // Chapter 2 = medium-risk, max profile: skip flag suppresses the preferred critique
  const estimate = runChapterCli(["--smoke", "--estimate-cost", "--chapter", "2", "--skip-spec-critique"], rootDir);
  assert.equal(estimate.status, 0, estimate.stderr || estimate.stdout);
  const costEstimate = await readJson<any>(path.join(rootDir, "artifacts", "chapters", "chapter-2-cost-estimate.json"));
  const stageNames: string[] = costEstimate.data.stages.map((s: any) => s.stage);
  assert.ok(!stageNames.includes("spec-critique"), "skip flag must suppress critique on non-high-risk chapter");

  // But high-risk chapter 1: skip flag is ignored, critique still present
  const estimate2 = runChapterCli(["--smoke", "--estimate-cost", "--chapter", "1", "--skip-spec-critique"], rootDir);
  assert.equal(estimate2.status, 0, estimate2.stderr || estimate2.stdout);
  const costEstimate2 = await readJson<any>(path.join(rootDir, "artifacts", "chapters", "chapter-1-cost-estimate.json"));
  const stageNames2: string[] = costEstimate2.data.stages.map((s: any) => s.stage);
  assert.ok(stageNames2.includes("spec-critique"), "skip flag must NOT suppress critique on high-risk chapter");
});

test("real blueprint compile blocks on under-specified template", async (t) => {
  const rootDir = await createTempRoot();
  t.after(async () => {
    await cleanupTempRoot(rootDir);
  });

  await writeRootBlueprint(rootDir, INVALID_BLUEPRINT);
  const blocked = runChapterCli(["--compile-blueprint"], rootDir);

  assert.equal(blocked.status, 2, blocked.stderr || blocked.stdout);
  assert.match(blocked.stdout, /BLOCKED_BLUEPRINT_UNDERSPECIFIED/);

  const statusArtifact = await readJson<any>(path.join(rootDir, "artifacts", "chapters", "chapter-1-status.json"));
  assert.equal(statusArtifact.data.status, "BLOCKED_BLUEPRINT_UNDERSPECIFIED");
});
