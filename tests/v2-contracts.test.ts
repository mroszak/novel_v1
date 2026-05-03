import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseBlueprint } from "../src/blueprint/parse-blueprint.js";
import { runContinuityManifestValidators } from "../src/validators/continuity-manifest.js";
import { applyVoiceGritPatches } from "../src/pipeline/voice-grit-pass.js";
import type {
  ChapterPacket,
  ContinuityManifest,
  GritPatch,
} from "../src/types/index.js";

const MARKET_AND_MANIFEST_BLUEPRINT = `---
title: "Test"
author: "Test"
version: "1.0.0"
---

# STORY BLUEPRINT

## Metadata
- Title: Test
- Author: Test
- Blueprint Version: 1.0.0
- Total Chapter Count: 2
- Default Chapter Word Count: 4000

## Story Promise and Ending Promise
- Core Premise: A premise.
- Story Promise: A promise.
- Reader Promise: A reader promise.
- Ending Promise: An ending promise.

## Market Positioning
- Market Category: thriller
- Audience: thriller readers
- Shelf Positioning: A thriller.
- Comparables:
  - Comp One

## Market Promise
- Reader Avatar: Tense reader who finishes in a sitting.
- Shelf / Comps:
  - Comp One
  - Comp Two
- Core Commercial Hook: One sealed deathtrap; one buried lie.
- Trope Stack:
  - sealed-environment disaster
  - buried military secret
- Freshness Angle: The architecture is military, not natural.
- Pacing Contract: Slow burn pressure with violent ruptures.
- Emotional Promise: Elegant spectacle collapsing into trapped survival.
- Cover/Blurb Keywords:
  - keyword one
- Series Potential: Standalone with a survivor's last image.
- Chapter-Level Retention Strategy:
  - opening: make the premise irresistible
  - early-escalation: prove the danger is real
  - midpoint: change what the reader thinks the story is
  - climax: pay off pressure and revelation in a single beat

## Genre Contract
- Primary Genre: thriller
- Tone Keywords:
  - Tense
- Reader Experience: Compounding pressure.

## Tonal Contract and Reader Experience
Tonal text.

## Canon Law and World Rules
- A rule.

## Character Architecture
### Protagonist
- Name: Lena Vale
- Role: protagonist
- Desire: Escape.
- Fear: Failure.
- Contradiction: Hides her competence.
- Public Face: Calm.
- Private Truth: Burned out.
- Voice Notes:
  - Clipped under pressure.
- Knowledge Boundary: Cannot know architect identity yet.

## Relationship Dynamics
Pressure lines.

## Belief Arcs and Internal Contradictions
Belief text.

## Knowledge Boundaries and Reveal Timing
Reveal discipline.

## Act Spine and Chapter-by-Chapter Obligations
Macro architecture.

## Setup/Payoff Map and Ghost-Thread Map
Setups and payoffs.

## Continuity Manifest

### Persistent Objects
- Eleanor's memo | sealed in case | Eleanor | 0
- Dock Two key | dropped in promenade | Lena | 0

### Spatial Registry
- Promenade | main concourse | guests and staff | normal
- Dock Two | service intake | crew only | normal

### Timeline Anchors
- T+0:00 | story begins | baseline
- T+0:30 | first scene close | +0:30 from start

### Reveal Schedule
- The architect identity | reader | 4 | hint
- The architect identity | protagonist | 6 | reveal

### Relationship States
- Lena Vale x Antagonist | trust=10 | distance=high | dependency=low | rivalry=high

### Motif States
- white seam | low | 0 | introduced

## Style Bible and Prose Rules
- Lean on close third.

## Motif/Symbol Bank and Imagery Palette
- Motifs:
  - white seams

## Anti-Patterns and Genre Failure Modes
- Banned Moves:
  - No miracle fixes.

## Chapter Outline
### Chapter 1
- Title: Opening
- Function: opening
- POV: Lena Vale
- Summary: Open.
- Chapter Goal: Establish.
- Target Word Count: 4000
- Ending Hook: Hook.
- Active Cast:
  - Lena Vale
- Mandatory Beats:
  - Establish pressure.
- Show:
  - the lobby
- Hint:
  - the dock
- Reveal:
  - small fact
- Withhold:
  - the architect
- Risk Flags:
  - anchor
- Notes: []

### Chapter 2
- Title: Escalation
- Function: escalation
- POV: Lena Vale
- Summary: Escalate.
- Chapter Goal: Tighten.
- Target Word Count: 4000
- Ending Hook: Sharp turn.
- Active Cast:
  - Lena Vale
- Mandatory Beats:
  - Raise stakes.
- Show: []
- Hint: []
- Reveal: []
- Withhold:
  - the architect
- Risk Flags:
  - complex
- Notes: []
`;

async function withTempBlueprint<T>(content: string, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2-blueprint-"));
  const target = path.join(dir, "blueprint.md");
  await writeFile(target, content, "utf8");
  try {
    return await fn(target);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("parser reads Market Promise into structured fields", async () => {
  await withTempBlueprint(MARKET_AND_MANIFEST_BLUEPRINT, async (p) => {
    const parsed = await parseBlueprint(p);
    const promise = parsed.marketPromise;
    assert.ok(promise, "marketPromise must be parsed");
    assert.equal(promise!.coreCommercialHook, "One sealed deathtrap; one buried lie.");
    assert.deepEqual(promise!.tropeStack, [
      "sealed-environment disaster",
      "buried military secret",
    ]);
    assert.equal(promise!.chapterRetentionStrategy.length, 4);
    const opening = promise!.chapterRetentionStrategy.find((e) => e.chapterFunction === "opening");
    assert.ok(opening);
    assert.equal(opening!.readerJob, "make the premise irresistible");
  });
});

test("parser reads Continuity Manifest pipe-delimited fields", async () => {
  await withTempBlueprint(MARKET_AND_MANIFEST_BLUEPRINT, async (p) => {
    const parsed = await parseBlueprint(p);
    const manifest = parsed.continuityManifest;
    assert.ok(manifest, "continuityManifest must be parsed");
    assert.equal(manifest!.persistentObjects.length, 2);
    assert.equal(manifest!.persistentObjects[0]!.name, "Eleanor's memo");
    assert.equal(manifest!.persistentObjects[0]!.state, "sealed in case");
    assert.equal(manifest!.timelineAnchors.length, 2);
    assert.equal(manifest!.revealSchedule.length, 2);
    assert.equal(manifest!.revealSchedule[0]!.chapter, 4);
    assert.equal(manifest!.revealSchedule[0]!.mode, "hint");
    assert.equal(manifest!.motifStates.length, 1);
    assert.equal(manifest!.motifStates[0]!.stage, "introduced");
  });
});

test("parser returns null Market Promise / Continuity Manifest when sections absent", async () => {
  const minimal = MARKET_AND_MANIFEST_BLUEPRINT
    .replace(/\n## Market Promise[\s\S]*?(?=\n## Genre Contract)/, "\n")
    .replace(/\n## Continuity Manifest[\s\S]*?(?=\n## Style Bible)/, "\n");
  await withTempBlueprint(minimal, async (p) => {
    const parsed = await parseBlueprint(p);
    assert.equal(parsed.marketPromise, null);
    assert.equal(parsed.continuityManifest, null);
  });
});

function makeManifest(overrides: Partial<ContinuityManifest> = {}): ContinuityManifest {
  return {
    persistentObjects: [],
    spatialRegistry: [],
    timelineAnchors: [],
    revealSchedule: [],
    relationshipStates: [],
    motifStates: [],
    ...overrides,
  };
}

function makePacket(overrides: Partial<ChapterPacket> = {}): ChapterPacket {
  return {
    chapterNumber: 2,
    title: "Test",
    riskLevel: "medium",
    purpose: "Test.",
    chapterFunction: { function: "escalation", riskLevel: "medium", pacingDirective: "rise", judgeWeights: {} },
    openingHandoff: "Open.",
    previousChapterExcerpt: null,
    activeCast: [],
    mandatoryBeats: [],
    revealBudget: { show: [], hint: [], reveal: [], withhold: [] },
    callbackObligations: [],
    targetWordBand: { min: 1, target: 100, max: 1000 },
    endingHookTarget: "End.",
    voiceGuidance: [],
    pacingGuidance: [],
    continuityNotes: [],
    chapterNotes: [],
    rollingMemory: null,
    handoffMemory: null,
    compactContext: { previousChapterFull: null, olderHistory: [], revealLedger: [], knowledgeWarnings: [] },
    voiceTarget: null,
    marketPromise: null,
    continuityActiveSlice: null,
    authorBrief: { authorialPersona: "x", craftDirectives: ["x"], source: "deterministic" },
    ...overrides,
  };
}

test("continuity validator flags sealed-section regression", () => {
  const issues = runContinuityManifestValidators({
    manifest: makeManifest({
      persistentObjects: [{ name: "Dock Two", state: "sealed in case", possessor: "Lena", lastSeenChapter: 1 }],
    }),
    packet: makePacket(),
    prose: "She watched as Dock Two open before her.",
  });
  assert.ok(issues.some((i) => i.code === "CONTINUITY_SEALED_REGRESSION" && i.severity === "error"));
});

test("continuity validator flags timeline reversal", () => {
  const issues = runContinuityManifestValidators({
    manifest: makeManifest({
      timelineAnchors: [
        { label: "T+1:30", description: "Later", offset: "+1:30" },
        { label: "T+0:30", description: "Earlier", offset: "+0:30" },
      ],
    }),
    packet: makePacket(),
    prose: "Some prose.",
  });
  assert.ok(issues.some((i) => i.code === "CONTINUITY_TIMELINE_REVERSAL" && i.severity === "error"));
});

test("continuity validator flags premature reveal", () => {
  const issues = runContinuityManifestValidators({
    manifest: makeManifest({
      revealSchedule: [{ thread: "the architect identity", learner: "reader", chapter: 6, mode: "hint" }],
    }),
    packet: makePacket({ chapterNumber: 2 }),
    prose: "She finally understood the architect identity.",
  });
  assert.ok(issues.some((i) => i.code === "CONTINUITY_PREMATURE_REVEAL" && i.severity === "error"));
});

test("continuity validator flags motif stage skip", () => {
  const issues = runContinuityManifestValidators({
    manifest: makeManifest({
      motifStates: [{ motif: "white seam", intensity: "high", lastChapter: 0, stage: "inverted" }],
    }),
    packet: makePacket(),
    prose: "Prose.",
  });
  assert.ok(issues.some((i) => i.code === "CONTINUITY_MOTIF_STAGE_SKIP" && i.severity === "warning"));
});

const MID_PARAGRAPH_FILLER = "Opening filler that pushes past the protected first 200 words. ".repeat(40).trim();

function buildGritProse(midSentence: string): string {
  return [
    "Title",
    MID_PARAGRAPH_FILLER,
    `She turned the corner. ${midSentence} The hallway stretched on after that.`,
    "More prose. Filler line two. Filler line three.",
    "The closing paragraph lands quietly on a held breath.",
  ].join("\n\n");
}

test("voice-grit validator rejects voice-tic without ticSource", () => {
  const target = "MID-VOICE-TIC-ANCHOR.";
  const prose = buildGritProse(target);
  const patches: GritPatch[] = [
    {
      texture: "voice-tic",
      originalText: target,
      replacementText: "MID-VOICE-TIC-CLIPPED.",
      earnedJustification: "Surface clipped trait.",
    },
  ];
  const result = applyVoiceGritPatches({
    prose,
    patches,
    voiceCards: { activeTraits: new Set(["Clipped"]), dialogueHabits: new Set(), taboos: new Set() },
  });
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0]!.skipReason, /ticSource/);
});

test("voice-grit validator rejects ticSource that matches a taboo", () => {
  const target = "MID-TABOO-ANCHOR.";
  const prose = buildGritProse(target);
  const patches: GritPatch[] = [
    {
      texture: "voice-tic",
      originalText: target,
      replacementText: "MID-TABOO-REPLACED.",
      earnedJustification: "Surface trait.",
      ticSource: "Do not name the architect",
    },
  ];
  const result = applyVoiceGritPatches({
    prose,
    patches,
    voiceCards: {
      activeTraits: new Set(["Clipped"]),
      dialogueHabits: new Set(),
      taboos: new Set(["Do not name the architect"]),
    },
  });
  assert.equal(result.applied.length, 0);
  assert.match(result.skipped[0]!.skipReason, /tabooNotes/);
});

test("voice-grit validator enforces total patch cap (6)", () => {
  const tokens = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"];
  const prose = [
    "Title line",
    MID_PARAGRAPH_FILLER,
    `She paced the deck. ${tokens.map((t) => `MID-${t}-ANCHOR.`).join(" Then ")} Then she stopped at the rail.`,
    "More prose lines. Three sentences here. To buffer the rejudge zone.",
    "The closing line stays sealed against any patch.",
  ].join("\n\n");
  const patches: GritPatch[] = tokens.map((t) => ({
    texture: "specificity-swap" as const,
    originalText: `MID-${t}-ANCHOR.`,
    replacementText: `MID-${t}-REPLACED.`,
    earnedJustification: "Sharper concrete detail.",
  }));
  const result = applyVoiceGritPatches({
    prose,
    patches,
    voiceCards: { activeTraits: new Set(), dialogueHabits: new Set(), taboos: new Set() },
  });
  assert.ok(result.applied.length <= 6, `applied <= 6, got ${result.applied.length}`);
  assert.ok(result.skipped.some((s) => /Total patch cap/.test(s.skipReason)));
});

test("voice-grit validator enforces once-per-chapter texture caps", () => {
  const prose = [
    "Title",
    MID_PARAGRAPH_FILLER,
    "She turned the corner. MID-ALPHA-ANCHOR. MID-BRAVO-ANCHOR. The hallway stretched on after that.",
    "More prose. Filler line two. Filler line three.",
    "Closing line at the end.",
  ].join("\n\n");
  const patches: GritPatch[] = [
    {
      texture: "interrupted-observation",
      originalText: "MID-ALPHA-ANCHOR.",
      replacementText: "MID-ALPHA-INTERRUPTED—",
      earnedJustification: "Trailing observation.",
    },
    {
      texture: "interrupted-observation",
      originalText: "MID-BRAVO-ANCHOR.",
      replacementText: "MID-BRAVO-INTERRUPTED—",
      earnedJustification: "Trailing observation.",
    },
  ];
  const result = applyVoiceGritPatches({
    prose,
    patches,
    voiceCards: { activeTraits: new Set(), dialogueHabits: new Set(), taboos: new Set() },
  });
  assert.equal(result.applied.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0]!.skipReason, /one per chapter/);
});

test("voice-grit validator rejects originalText not present in prose", () => {
  const prose = "Some prose.\n\nMore prose.\n\nFinal line.";
  const patches: GritPatch[] = [{
    texture: "specificity-swap",
    originalText: "Text that does not appear",
    replacementText: "Replacement",
    earnedJustification: "Sharper.",
  }];
  const result = applyVoiceGritPatches({
    prose,
    patches,
    voiceCards: { activeTraits: new Set(), dialogueHabits: new Set(), taboos: new Set() },
  });
  assert.equal(result.applied.length, 0);
  assert.match(result.skipped[0]!.skipReason, /verbatim exactly once/);
});
