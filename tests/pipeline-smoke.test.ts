import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import { cleanupTempRoot, createTempRoot, readJson, runChapterCli, writeRootBlueprint } from "./helpers.js";
import { FIXTURE_BLUEPRINT, INVALID_BLUEPRINT } from "./fixtures/blueprint-fixture.js";
import { EFFECT_TICS_SEED } from "../src/blueprint/extract-voice-fingerprint.js";

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

test("compileChapterPacket forwards Secondary Cameo Beats from blueprint onto chapter packet artifact", async (t) => {
  const rootDir = await createTempRoot();
  t.after(async () => {
    await cleanupTempRoot(rootDir);
  });

  await writeRootBlueprint(rootDir, FIXTURE_BLUEPRINT);
  const result = runChapterCli(
    ["--packet-only", "--chapter", "1", "--no-genre-ai"],
    rootDir,
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const packet = await readJson<{ data: { secondaryCameoBeats: string[]; mandatoryBeats: string[] } }>(
    path.join(rootDir, "artifacts", "chapters", "chapter-1-packet.json"),
  );
  assert.deepEqual(packet.data.secondaryCameoBeats, [
    "One human detail for a background courier in passing through Mira's POV.",
    "Rowan briefly registers an analyst he respects without naming her.",
  ]);
  assert.ok(packet.data.mandatoryBeats.length > 0, "Sanity: packet still carries mandatoryBeats");
});

test("Named Character Cap + Surname Alias propagate from blueprint markdown into the chapter packet artifact", async (t) => {
  const rootDir = await createTempRoot();
  t.after(async () => {
    await cleanupTempRoot(rootDir);
  });

  const customBlueprint = FIXTURE_BLUEPRINT
    .replace(
      "- Knowledge Boundary: She must not know the architect in chapter 1.",
      "- Knowledge Boundary: She must not know the architect in chapter 1.\n- Surname Alias: true",
    )
    .replace(
      "- Target Word Count: 2200\n- Ending Hook: Rowan arrives knowing the package contents before Mira tells him what she is carrying.",
      "- Target Word Count: 2200\n- Named Character Cap: 5\n- Ending Hook: Rowan arrives knowing the package contents before Mira tells him what she is carrying.",
    );

  await writeRootBlueprint(rootDir, customBlueprint);
  const result = runChapterCli(
    ["--packet-only", "--chapter", "1", "--no-genre-ai"],
    rootDir,
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const packet = await readJson<{
    data: {
      namedCharacterCap?: number;
      activeCast: Array<{ name: string; surnameAlias?: boolean }>;
    };
  }>(path.join(rootDir, "artifacts", "chapters", "chapter-1-packet.json"));

  assert.equal(
    packet.data.namedCharacterCap,
    5,
    "namedCharacterCap from chapter outline must reach the chapter packet artifact",
  );

  const mira = packet.data.activeCast.find((c) => c.name === "Mira Sol");
  const rowan = packet.data.activeCast.find((c) => c.name === "Rowan Hale");
  assert.ok(mira, "Mira Sol must be in activeCast");
  assert.ok(rowan, "Rowan Hale must be in activeCast");
  assert.equal(mira.surnameAlias, true, "Mira's Surname Alias: true must propagate through activeCast");
  assert.equal(
    rowan.surnameAlias,
    undefined,
    "Characters without the flag must NOT have surnameAlias set on the card",
  );
});

test("compile-blueprint seeds voice-target.json with the seed effectTics catalog when none exists", async (t) => {
  const rootDir = await createTempRoot();
  t.after(async () => {
    await cleanupTempRoot(rootDir);
  });

  await writeRootBlueprint(rootDir, FIXTURE_BLUEPRINT);
  const compile = runChapterCli(["--compile-blueprint", "--no-genre-ai"], rootDir);
  assert.equal(compile.status, 0, compile.stderr || compile.stdout);

  const voiceTarget = await readJson<any>(
    path.join(rootDir, "artifacts", "blueprint", "voice-target.json"),
  );
  assert.equal(voiceTarget.artifactType, "voice-target");
  assert.equal(voiceTarget.data.source, "blueprint-fallback");
  assert.deepEqual(voiceTarget.data.derivedFromChapters, []);
  assert.deepEqual(
    voiceTarget.data.fingerprint.effectTics,
    EFFECT_TICS_SEED,
    "first-chapter voice-grit needs the seed catalog as the deterministic fallback",
  );

  // Idempotent: re-compile must not clobber an existing voice-target.
  const beforeMtime = voiceTarget.createdAt;
  const recompile = runChapterCli(["--compile-blueprint", "--no-genre-ai"], rootDir);
  assert.equal(recompile.status, 0, recompile.stderr || recompile.stdout);
  const afterRecompile = await readJson<any>(
    path.join(rootDir, "artifacts", "blueprint", "voice-target.json"),
  );
  assert.equal(
    afterRecompile.createdAt,
    beforeMtime,
    "ensureVoiceTargetSeeded must leave an existing voice-target.json untouched",
  );
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
