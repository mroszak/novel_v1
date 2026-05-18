import assert from "node:assert/strict";
import test from "node:test";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseBlueprint } from "../src/blueprint/parse-blueprint.js";
import { buildDraftSystemPrompt } from "../src/pipeline/generate-draft.js";
import {
  buildJudgeInstructions,
  buildVoiceCardSummary,
} from "../src/pipeline/judge-draft.js";
import {
  chapterSpecSchema,
} from "../src/pipeline/generate-spec.js";
import { chapterDeltaSchema } from "../src/pipeline/extract-chapter-delta.js";
import { buildSpecPacketView } from "../src/pipeline/prompt-packet-views.js";
import { createSmokeDelta, createSmokeSpec } from "../src/pipeline/smoke-helpers.js";
import { compileChapterPacket } from "../src/pipeline/compile-chapter-packet.js";
import {
  applyMistakenBeliefDeltas,
  loadPersistedContinuityState,
  normalizeChapterDelta,
} from "../src/pipeline/update-continuity-state.js";
import {
  buildEffectTics,
  EFFECT_TICS_SEED,
  loadVoiceTargetIfPresent,
} from "../src/blueprint/extract-voice-fingerprint.js";
import {
  applyVoiceGritPatches,
  buildEffectTicLookup,
} from "../src/pipeline/voice-grit-pass.js";
import { compileBlueprintRuntime } from "../src/pipeline/compile-blueprint.js";
import { config } from "../src/config.js";
import type {
  ArtifactEnvelope,
  ChapterDelta,
  ChapterFunctionProfile,
  ChapterPacket,
  ChapterSpec,
  CharacterCard,
  ContinuityState,
  GenreContract,
  GritPatch,
  MarketPositioningSection,
  MistakenBelief,
  StoryPromiseSection,
  VoiceCard,
  VoiceTarget,
} from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCharacterCard(overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    name: "Erik Halvorsen",
    role: "protagonist",
    desire: "Survive the gala without lying.",
    fear: "Being seen as the same kind of man as Vauclair.",
    contradiction: "He wants to belong to a class he no longer trusts.",
    publicFace: "Composed engineer at a society event.",
    privateTruth: "He still flinches when things hum in the wrong frequency.",
    voiceNotes: ["Counts before he speaks", "Reads rooms by their exits"],
    knowledgeBoundary: "Does not yet know the cause of the flicker.",
    rawBody: "Erik card body.",
    ...overrides,
  };
}

function makeMinimalChapterPacket(activeCast: CharacterCard[]): ChapterPacket {
  const chapterFunction: ChapterFunctionProfile = {
    function: "opening",
    riskLevel: "medium",
    pacingDirective: "Steady setup with one sharp pressure beat.",
    judgeWeights: {},
  };

  return {
    chapterNumber: 1,
    title: "Opening Pressure",
    riskLevel: "medium",
    purpose: "Establish pressure and stakes.",
    chapterFunction,
    openingHandoff: "Pre-chapter handoff.",
    previousChapterExcerpt: null,
    activeCast,
    mandatoryBeats: ["Establish the central pressure."],
    secondaryCameoBeats: [],
    revealBudget: { show: [], hint: [], reveal: [], withhold: [] },
    callbackObligations: [],
    targetWordBand: { min: 100, target: 200, max: 300 },
    endingHookTarget: "End on the first irreversible flicker.",
    voiceGuidance: [],
    pacingGuidance: [],
    continuityNotes: [],
    chapterNotes: [],
    rollingMemory: null,
    handoffMemory: null,
    compactContext: {
      previousChapterFull: null,
      olderHistory: [],
      revealLedger: [],
      knowledgeWarnings: [],
    },
    voiceTarget: null,
    marketPromise: null,
    continuityActiveSlice: null,
    locations: null,
    authorBrief: {
      authorialPersona: "Test persona.",
      craftDirectives: [],
      source: "deterministic",
    },
    mistakenBeliefs: {},
  };
}

function makeMinimalGenreContract(): GenreContract {
  return {
    primaryGenre: "thriller",
    contributingGenres: [],
    toneKeywords: ["precise"],
    readerExperience: "Sealed-environment dread.",
    controls: {
      pacingCurve: "steady",
      sceneDensity: "medium",
      dialogueRatioTarget: "balanced",
      interiorityRatioTarget: "balanced",
      revealCadence: "measured",
      hookStyle: "kinetic",
      endingMode: "irreversible",
      povDistance: "close",
      ambiguityTolerance: "medium",
      sensoryDensity: "rich",
      proseCompression: "tight",
      emotionalDwellExpectation: "earned",
      violenceExplicitness: "restrained",
      romanceProminence: "minor",
      validatorThresholdOverrides: [],
    },
    aiRefinementUsed: false,
    aiRefinementNotes: [],
  };
}

function makeMinimalStoryPromise(): StoryPromiseSection {
  return {
    corePremise: "Premise.",
    storyPromise: "Sealed pressure builds and collapses.",
    readerPromise: "Watch elegance turn into entrapment.",
    endingPromise: "Survival at a cost.",
  };
}

function makeMinimalMarketPositioning(): MarketPositioningSection {
  return {
    marketCategory: "thriller",
    audience: "fans of sealed-disaster fiction",
    shelfPositioning: "literary thriller shelf",
    comparables: ["The Abyss", "Hunt for Red October"],
  };
}

// Minimal recursive validator for the OpenAI strict-schema shape we use.
function validateAgainstSchema(value: unknown, schema: any, path: string = "$"): string[] {
  const errors: string[] = [];

  if (schema.anyOf) {
    const subErrors: string[][] = schema.anyOf.map((sub: any) => validateAgainstSchema(value, sub, path));
    if (!subErrors.some((e) => e.length === 0)) {
      errors.push(`${path}: matches no anyOf branch (${subErrors.map((e) => e[0]).join(" | ")})`);
    }
    return errors;
  }

  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(`${path}: expected object`);
        return errors;
      }
      const obj = value as Record<string, unknown>;
      const required: string[] = schema.required ?? [];
      for (const key of required) {
        if (!(key in obj)) errors.push(`${path}.${key}: missing required property`);
      }
      if (schema.additionalProperties === false) {
        const allowed = new Set(Object.keys(schema.properties ?? {}));
        for (const key of Object.keys(obj)) {
          if (!allowed.has(key)) errors.push(`${path}.${key}: additional property not allowed`);
        }
      }
      for (const [key, subSchema] of Object.entries(schema.properties ?? {})) {
        if (key in obj) {
          errors.push(...validateAgainstSchema(obj[key], subSchema, `${path}.${key}`));
        }
      }
      return errors;
    }
    case "array": {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array`);
        return errors;
      }
      if (schema.minItems != null && value.length < schema.minItems) {
        errors.push(`${path}: expected at least ${schema.minItems} items`);
      }
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          errors.push(...validateAgainstSchema(value[i], schema.items, `${path}[${i}]`));
        }
      }
      return errors;
    }
    case "string": {
      if (typeof value !== "string") errors.push(`${path}: expected string`);
      else if (schema.minLength != null && value.length < schema.minLength) {
        errors.push(`${path}: string shorter than minLength=${schema.minLength}`);
      }
      return errors;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) errors.push(`${path}: expected integer`);
      return errors;
    }
    case "number": {
      if (typeof value !== "number") errors.push(`${path}: expected number`);
      return errors;
    }
    case "boolean": {
      if (typeof value !== "boolean") errors.push(`${path}: expected boolean`);
      return errors;
    }
    case "null": {
      if (value !== null) errors.push(`${path}: expected null`);
      return errors;
    }
    default:
      return errors;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("parseCharacters reads `Noticing Engine:` when present and omits when absent", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "blueprint-noticing-"));
  try {
    const blueprintPath = path.join(tmpRoot, "blueprint.md");
    const body = [
      "# STORY BLUEPRINT",
      "",
      "## Metadata",
      "- Title: Test",
      "- Author: Test",
      "- Blueprint Version: 0.1.0",
      "- Total Chapter Count: 1",
      "- Default Chapter Word Count: 4000",
      "",
      "## Character Architecture",
      "### Protagonist",
      "- Name: Erik",
      "- Role: protagonist",
      "- Desire: Survive.",
      "- Fear: Being unmasked.",
      "- Contradiction: Wants to belong to what he distrusts.",
      "- Public Face: Composed engineer.",
      "- Private Truth: Still hears the wrong frequency.",
      "- Voice Notes:",
      "  - Counts before he speaks",
      "- Knowledge Boundary: Does not yet know the cause.",
      "- Noticing Engine: Reads rooms by exits and load paths first.",
      "",
      "### Antagonist",
      "- Name: Vauclair",
      "- Role: antagonist",
      "- Desire: Keep the gala open.",
      "- Fear: Being remembered for what he allowed.",
      "- Contradiction: Charm purchased with silence.",
      "- Public Face: The host.",
      "- Private Truth: The architecture is failing.",
      "- Voice Notes:",
      "  - Speaks like a host even alone",
      "- Knowledge Boundary: Knows the structure is failing.",
      "",
      "## Chapter Outline",
      "### Chapter 1",
      "- Title: Opening",
      "- Function: opening",
      "- POV: Erik",
      "- Summary: Open the gala.",
      "- Chapter Goal: Establish pressure.",
      "- Target Word Count: 4000",
      "- Ending Hook: First flicker.",
      "- Active Cast:",
      "  - Erik",
      "- Mandatory Beats:",
      "  - The gala begins.",
      "- Callback Obligations:",
      "  - Pressure carries forward.",
    ].join("\n");
    await writeFile(blueprintPath, body, "utf8");

    const parsed = await parseBlueprint(blueprintPath);
    const protagonist = parsed.characters.find((c) => c.name === "Erik");
    const antagonist = parsed.characters.find((c) => c.name === "Vauclair");

    assert.ok(protagonist, "Protagonist must be parsed");
    assert.ok(antagonist, "Antagonist must be parsed");
    assert.equal(
      protagonist!.noticingEngine,
      "Reads rooms by exits and load paths first.",
      "noticingEngine must be parsed when present",
    );
    assert.equal(
      "noticingEngine" in antagonist!,
      false,
      "noticingEngine must be omitted entirely when absent in blueprint",
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("smoke ChapterSpec round-trips through chapterSpecSchema", () => {
  const cast = [makeCharacterCard()];
  const packet = makeMinimalChapterPacket(cast);
  const spec = createSmokeSpec(packet);

  const errors = validateAgainstSchema(spec, chapterSpecSchema);
  assert.deepEqual(errors, [], "Smoke spec must validate against the strict chapterSpecSchema");

  // Sanity: required new fields are populated as expected by the smoke helper.
  assert.deepEqual(spec.physicalClueAnchors, [], "Smoke spec must populate physicalClueAnchors as []");
  for (const scene of spec.scenePlan) {
    assert.equal(scene.humanGrain, null, "Smoke scenes must set humanGrain to null");
  }
});

test("populated ChapterSpec with anchor + non-null humanGrain validates against schema", () => {
  const populated: ChapterSpec = {
    title: "Opening Night",
    purpose: "Stage the gala and the first flicker.",
    openingImage: "Descent in the elevator-pod.",
    scenePlan: [
      {
        sceneNumber: 1,
        location: "Atrium",
        objective: "Stage charm.",
        summary: "Vauclair charms the room.",
        turn: "Erik notices the load path.",
        revealHandling: "Hint only.",
        exitCondition: "Exit on the toast.",
        emotionalArc: "Composed to wary.",
        sensoryAnchor: "Glass and warm light.",
        dialogueStrategy: "Subtext under formal speech.",
        humanGrain: "A waiter trips on a cable cover; nothing breaks.",
      },
    ],
    mandatoryBeatCoverage: [
      { beat: "Stage the toast.", deliveryPlan: "Vauclair speaks; lights dip mid-sentence." },
    ],
    callbackPlan: [],
    revealControl: { show: [], hint: ["the inspection tick"], reveal: [], withhold: ["the cause"] },
    continuityWatchouts: [],
    proseGuidance: ["Tight prose under formal speech."],
    physicalClueAnchors: [
      {
        clue: "Inspection tick on the southwest acrylic",
        anchor: "Fourth screw in the south frame",
        beforeState: "Tick stops one fingerwidth short of the screw.",
        afterState: "Tick passes the screw and hooks downward.",
      },
    ],
    endingBeat: "End on the second flicker.",
  };

  const errors = validateAgainstSchema(populated, chapterSpecSchema);
  assert.deepEqual(errors, [], "Populated spec with anchor entry + non-null humanGrain must validate");
});

test("buildDraftSystemPrompt includes the CHAPTER-1 LESSONS section", () => {
  const prompt = buildDraftSystemPrompt({
    genreContract: makeMinimalGenreContract(),
    storyPromise: makeMinimalStoryPromise(),
    marketPositioning: makeMinimalMarketPositioning(),
    chapterFunction: {
      function: "opening",
      riskLevel: "medium",
      pacingDirective: "Steady.",
      judgeWeights: {},
    },
    styleRules: [],
    antiPatterns: [],
    comparables: [],
  });

  assert.ok(
    prompt.includes("CHAPTER-1 LESSONS — HARD RULES"),
    "Drafter prompt must include the CHAPTER-1 LESSONS hard-rules header",
  );
  assert.ok(
    prompt.includes("H1. Every scene must turn the story."),
    "Drafter prompt must include rule H1 verbatim",
  );
  assert.ok(
    prompt.includes("CHAPTER-1 LESSONS — DEFAULTS"),
    "Drafter prompt must include the CHAPTER-1 LESSONS defaults header",
  );
  assert.ok(
    prompt.includes("CLARITY FLOOR:"),
    "Drafter H3 must carry the CLARITY FLOOR plain-sentence requirement at danger reveals",
  );
  assert.ok(
    prompt.includes("at least one short plain sentence stating the change"),
    "Drafter H3 must require at least one plain restatable sentence alongside any lyrical compression",
  );
  assert.ok(
    prompt.includes("answer 'why didn't they just tell someone?' from material already on the page"),
    "Drafter D2 must carry the expert-inaction-justified requirement using the falsifiable reader-question test",
  );
  assert.ok(
    prompt.includes("Tragic hesitation is earned; plot-convenient silence is a craft failure."),
    "Drafter D2 must include the tragic-vs-plot-convenient framing",
  );
});

test("buildJudgeInstructions includes scene-turn, named-without-future-use, and density-governor blocks", () => {
  const instructions = buildJudgeInstructions(80, "Make the premise irresistible.");

  assert.ok(
    instructions.includes("SCENE TURN CHECK (feeds forwardMotion)."),
    "Judge instructions must include the SCENE TURN CHECK header",
  );
  assert.ok(
    instructions.includes("Atmosphere alone is not a turn."),
    "Judge instructions must include the SCENE TURN CHECK rule line",
  );
  assert.ok(
    instructions.includes("NAMED WITHOUT FUTURE USE (feeds freshness)."),
    "Judge instructions must include the NAMED WITHOUT FUTURE USE header",
  );
  assert.ok(
    instructions.includes("Required active-cast names are not flagged."),
    "Judge instructions must include the NAMED WITHOUT FUTURE USE rule line",
  );
  assert.ok(
    instructions.includes("PHYSICAL CLUE ANCHOR CHECK (feeds specificity)."),
    "Judge instructions must include the conditional clue-anchor signal",
  );
  assert.ok(
    instructions.includes("NOTICING ENGINE CHECK (feeds voiceConsistency)."),
    "Judge instructions must include the conditional noticing-engine signal",
  );

  // Density governors (B.1–B.5 from the density-discipline pass).
  assert.ok(
    instructions.includes("statable in one sentence each, anchored to a single fixed marker"),
    "Physical Clue Anchor block must include the one-sentence-each-side tightening",
  );
  assert.ok(
    instructions.includes("inventories three or more named figures"),
    "Named Without Future Use block must include the inventory-to-consequence clause",
  );
  assert.ok(
    instructions.includes("WITHHELD ACTION VARIETY (feeds freshness)."),
    "Judge instructions must include the WITHHELD ACTION VARIETY header that mirrors the validator",
  );
  assert.ok(
    instructions.includes("OVER-COMPOSED CLUSTER CHECK (feeds proseQuality)."),
    "Judge instructions must include the OVER-COMPOSED CLUSTER CHECK header",
  );
  assert.ok(
    instructions.includes("densest 10%"),
    "Over-composed cluster block must include the densest-10% revision target",
  );
  assert.ok(
    instructions.includes("by its opening phrase"),
    "Over-composed cluster block must require identification by opening phrase, not paragraph index",
  );
  assert.ok(
    instructions.includes("Judge by necessity, not abundance"),
    "Anti-committee block must include the necessity-over-abundance principle",
  );
  assert.ok(
    instructions.includes("DOMINANT JOB DISCIPLINE (feeds forwardMotion)."),
    "Judge instructions must include the DOMINANT JOB DISCIPLINE header",
  );
  assert.ok(
    instructions.includes("the chapter's dominant job"),
    "Dominant-job block must reference the chapter's dominant job",
  );

  // B.1 and B.2 must produce concrete revisionActions (not just weaknesses
  // entries) so the revision pass has a directive — pins the AGENTS.md
  // wording that "all five density signals surface in revisionActions."
  assert.ok(
    instructions.includes("revisionAction asking for the supporting geometry to be compressed"),
    "Physical Clue Anchor block must request a revisionAction, not only a weakness entry",
  );
  assert.ok(
    instructions.includes("revisionAction asking for unnecessary names to be compressed"),
    "Inventory-to-consequence clause must request a revisionAction, not only a weakness entry",
  );
});

test("buildJudgeInstructions includes CLARITY FLOOR and EXPERT INACTION JUSTIFICATION blocks", () => {
  const instructions = buildJudgeInstructions(80, null);

  assert.ok(
    instructions.includes("CLARITY FLOOR AT DANGER REVEALS (feeds proseQuality)."),
    "Judge instructions must include the CLARITY FLOOR AT DANGER REVEALS header",
  );
  assert.ok(
    instructions.includes("at least one short plain sentence that restates the change"),
    "Clarity Floor block must require at least one plain restatable sentence",
  );
  assert.ok(
    instructions.includes("The plain sentence does not replace the lyricism; it anchors it."),
    "Clarity Floor block must keep the 'plain sentence anchors the lyricism' framing so it does not strip-mine the prose",
  );
  assert.ok(
    instructions.includes("ONLY through compressed metaphor"),
    "Clarity Floor block must only fire when the change is delivered exclusively through metaphor",
  );

  assert.ok(
    instructions.includes("EXPERT INACTION JUSTIFICATION (feeds characterTruth)."),
    "Judge instructions must include the EXPERT INACTION JUSTIFICATION header",
  );
  assert.ok(
    instructions.includes("the prose must make the reason for inaction legible"),
    "Expert Inaction block must require a legible reason for the expert's silence",
  );
  assert.ok(
    instructions.includes("Distinguish tragic hesitation from plot-convenient stupidity"),
    "Expert Inaction block must include the tragic-vs-plot-convenient framing",
  );
  assert.ok(
    instructions.includes("Bias toward not flagging when at least one concrete reason is legible"),
    "Expert Inaction block must bias against false positives when at least one reason is on the page",
  );

  const weaknessOnlyClause = "This is a weakness signal only; never add it to `blockingIssues`.";
  const clarityFloorIndex = instructions.indexOf("CLARITY FLOOR AT DANGER REVEALS (feeds proseQuality).");
  const expertInactionIndex = instructions.indexOf("EXPERT INACTION JUSTIFICATION (feeds characterTruth).");
  const overComposedIndex = instructions.indexOf("OVER-COMPOSED CLUSTER CHECK (feeds proseQuality).");
  assert.ok(clarityFloorIndex >= 0 && expertInactionIndex >= 0 && overComposedIndex >= 0, "header indices must resolve");
  const clarityFloorClauseIndex = instructions.indexOf(weaknessOnlyClause, clarityFloorIndex);
  const expertInactionClauseIndex = instructions.indexOf(weaknessOnlyClause, expertInactionIndex);
  assert.ok(
    clarityFloorClauseIndex > clarityFloorIndex && clarityFloorClauseIndex < expertInactionIndex,
    "Clarity Floor block must end with the weakness-only-never-blocking clause before the next header",
  );
  assert.ok(
    expertInactionClauseIndex > expertInactionIndex && expertInactionClauseIndex < overComposedIndex,
    "Expert Inaction block must end with the weakness-only-never-blocking clause before the next header",
  );
});

test("buildVoiceCardSummary appends notices=\"...\" when noticingEngine is set; omits otherwise", () => {
  const withEngine = makeCharacterCard({
    name: "Erik",
    role: "protagonist",
    noticingEngine: "Reads rooms by exits and load paths first.",
  });
  const withoutEngine = makeCharacterCard({
    name: "Vauclair",
    role: "antagonist",
    voiceNotes: ["Speaks like a host"],
  });

  const runtimeCard: VoiceCard = {
    character: "Erik",
    activeTraits: ["Calm under pressure"],
    stressPattern: "Goes quieter when wary.",
    dialogueHabits: ["Cuts to the question"],
    tabooNotes: [],
    updatedFromChapter: 1,
  };

  const withRuntimeCard = buildVoiceCardSummary([withEngine], [runtimeCard]);
  assert.ok(
    withRuntimeCard.includes('notices="Reads rooms by exits and load paths first."'),
    "Runtime-card path must append the notices= segment when noticingEngine is set",
  );

  const voiceNotesPathWith = buildVoiceCardSummary([withEngine], []);
  assert.ok(
    voiceNotesPathWith.includes('notices="Reads rooms by exits and load paths first."'),
    "Voice-notes-only path must append the notices= segment when noticingEngine is set",
  );

  const voiceNotesPathWithout = buildVoiceCardSummary([withoutEngine], []);
  assert.equal(
    voiceNotesPathWithout.includes("notices="),
    false,
    "Summary must omit the notices= segment when noticingEngine is not set",
  );

  const runtimeWithoutEngine = buildVoiceCardSummary([withoutEngine], [{
    ...runtimeCard,
    character: "Vauclair",
  }]);
  assert.equal(
    runtimeWithoutEngine.includes("notices="),
    false,
    "Runtime-card path must also omit the notices= segment when noticingEngine is not set",
  );
});

test("buildSpecPacketView surfaces noticingEngine when set; omits the key when not set", () => {
  const cast: CharacterCard[] = [
    makeCharacterCard({
      name: "Erik",
      noticingEngine: "Reads rooms by exits and load paths first.",
    }),
    makeCharacterCard({
      name: "Vauclair",
      role: "antagonist",
    }),
  ];
  const packet = makeMinimalChapterPacket(cast);
  const view = buildSpecPacketView(packet);

  const erik = view.activeCast.find((c) => c.name === "Erik")!;
  const vauclair = view.activeCast.find((c) => c.name === "Vauclair")!;

  assert.equal(
    erik.noticingEngine,
    "Reads rooms by exits and load paths first.",
    "noticingEngine must be surfaced on the spec view when set on the source card",
  );
  assert.equal(
    "noticingEngine" in vauclair,
    false,
    "noticingEngine key must be entirely omitted when not set on the source card",
  );
});

// ---------------------------------------------------------------------------
// Part C — mistakenBeliefs + effectTics regression tests
// ---------------------------------------------------------------------------

function makeBelief(overrides: Partial<MistakenBelief> = {}): MistakenBelief {
  return {
    belief: "The flicker is a transformer fault.",
    basis: "He matched it to a rumble he half-recognized.",
    introducedInChapter: 1,
    lastReinforcedInChapter: null,
    status: "active",
    readerKnowsItIsWrong: true,
    consequence: "He will not warn the steward in time.",
    ...overrides,
  };
}

test("C1. MistakenBeliefDelta round-trips through chapterDeltaSchema (empty + populated)", () => {
  const cast = [makeCharacterCard()];
  const packet = makeMinimalChapterPacket(cast);
  const selected = {
    winner: "draft" as const,
    prose: "Some prose.",
    wordCount: 2,
    review: {} as never,
    selection: {} as never,
  };
  const smokeDelta = createSmokeDelta(packet, selected);
  assert.deepEqual(
    smokeDelta.mistakenBeliefDeltas,
    [],
    "Smoke delta must default mistakenBeliefDeltas to []",
  );
  const smokeErrors = validateAgainstSchema(smokeDelta, chapterDeltaSchema);
  assert.deepEqual(smokeErrors, [], "Smoke delta must validate against chapterDeltaSchema");

  const populated: ChapterDelta = {
    ...smokeDelta,
    mistakenBeliefDeltas: [
      {
        character: "Erik",
        op: "introduce",
        belief: "The flicker is a transformer fault.",
        basis: "Half-recognized rumble.",
        readerKnowsItIsWrong: true,
        consequence: "He fails to warn the steward.",
      },
      {
        character: "Erik",
        op: "reinforce",
        belief: "The flicker is a transformer fault.",
        basis: null,
        readerKnowsItIsWrong: true,
        consequence: null,
      },
      {
        character: "Erik",
        op: "question",
        belief: "The flicker is a transformer fault.",
        basis: null,
        readerKnowsItIsWrong: true,
        consequence: null,
      },
      {
        character: "Erik",
        op: "correct",
        belief: "The flicker is a transformer fault.",
        basis: null,
        readerKnowsItIsWrong: true,
        consequence: "He understands the breach.",
      },
      {
        character: "Vauclair",
        op: "exploit",
        belief: "The room respects him.",
        basis: null,
        readerKnowsItIsWrong: false,
        consequence: "He overstates his control.",
      },
    ],
  };
  const populatedErrors = validateAgainstSchema(populated, chapterDeltaSchema);
  assert.deepEqual(
    populatedErrors,
    [],
    `Populated delta must validate against chapterDeltaSchema; got: ${populatedErrors.join("; ")}`,
  );
});

test("C2. applyMistakenBeliefDeltas: introduce/reinforce/question/correct/exploit semantics + consequence", () => {
  const empty: Record<string, MistakenBelief[]> = {};
  // introduce adds
  const after1 = applyMistakenBeliefDeltas({
    current: empty,
    deltas: [{
      character: "Erik",
      op: "introduce",
      belief: "Flicker is a transformer fault.",
      basis: "rumble",
      readerKnowsItIsWrong: true,
      consequence: "He fails to warn.",
    }],
    chapterNumber: 1,
  });
  assert.equal(after1.Erik!.length, 1);
  assert.equal(after1.Erik![0]!.status, "active");
  assert.equal(after1.Erik![0]!.introducedInChapter, 1);
  assert.equal(after1.Erik![0]!.lastReinforcedInChapter, null);
  assert.equal(after1.Erik![0]!.consequence, "He fails to warn.");

  // duplicate introduce folds into a reinforce (case-insensitive trim match)
  const after2 = applyMistakenBeliefDeltas({
    current: after1,
    deltas: [{
      character: "Erik",
      op: "introduce",
      belief: "  flicker is a transformer fault.  ",
      basis: null,
      readerKnowsItIsWrong: true,
      consequence: null,
    }],
    chapterNumber: 2,
  });
  assert.equal(after2.Erik!.length, 1, "Duplicate introduce must fold into reinforce");
  assert.equal(after2.Erik![0]!.lastReinforcedInChapter, 2);
  assert.equal(after2.Erik![0]!.status, "active");
  assert.equal(
    after2.Erik![0]!.consequence,
    "He fails to warn.",
    "Null consequence must preserve prior consequence",
  );

  // question flips status + bumps lastReinforced
  const after3 = applyMistakenBeliefDeltas({
    current: after2,
    deltas: [{
      character: "Erik",
      op: "question",
      belief: "Flicker is a transformer fault.",
      basis: null,
      readerKnowsItIsWrong: true,
      consequence: "He starts to doubt.",
    }],
    chapterNumber: 3,
  });
  assert.equal(after3.Erik![0]!.status, "questioned");
  assert.equal(after3.Erik![0]!.lastReinforcedInChapter, 3);
  assert.equal(
    after3.Erik![0]!.consequence,
    "He starts to doubt.",
    "Non-null consequence must overwrite prior value",
  );

  // correct flips to corrected
  const after4 = applyMistakenBeliefDeltas({
    current: after3,
    deltas: [{
      character: "Erik",
      op: "correct",
      belief: "Flicker is a transformer fault.",
      basis: null,
      readerKnowsItIsWrong: true,
      consequence: null,
    }],
    chapterNumber: 4,
  });
  assert.equal(after4.Erik![0]!.status, "corrected");
  assert.equal(after4.Erik![0]!.lastReinforcedInChapter, 4);

  // exploit flips a fresh belief to exploited
  const after5 = applyMistakenBeliefDeltas({
    current: { Vauclair: [makeBelief({ belief: "The room respects him.", introducedInChapter: 1 })] },
    deltas: [{
      character: "Vauclair",
      op: "exploit",
      belief: "The room respects him.",
      basis: null,
      readerKnowsItIsWrong: false,
      consequence: null,
    }],
    chapterNumber: 5,
  });
  assert.equal(after5.Vauclair![0]!.status, "exploited");
  assert.equal(after5.Vauclair![0]!.lastReinforcedInChapter, 5);
});

test("C3. loadPersistedContinuityState defaults mistakenBeliefs to {} when absent on older artifact", async () => {
  const { writeFile: writeFileFn, mkdir: mkdirFn, rm: rmFn } = await import("node:fs/promises");
  const targetDir = config.paths.blueprintArtifacts;
  const chapterNumber = 9991;
  const targetPath = path.join(targetDir, `continuity-state-after-${chapterNumber}.json`);
  await mkdirFn(targetDir, { recursive: true });
  const legacyArtifact = {
    schemaVersion: config.artifactSchemaVersion,
    artifactType: "continuity-state",
    createdAt: new Date().toISOString(),
    blueprintHash: "test-hash",
    blueprintVersion: "1.0.0",
    chapterNumber,
    data: {
      chapterNumber,
      persistentObjects: [],
      spatialRegistry: [],
      timelineAnchors: [],
      revealSchedule: [],
      relationshipStates: [],
      motifStates: [],
      notes: ["legacy"],
    },
  };
  await writeFileFn(targetPath, JSON.stringify(legacyArtifact, null, 2), "utf8");
  try {
    const loaded = await loadPersistedContinuityState({ chapterNumber });
    assert.ok(loaded, "Legacy artifact must load (soft default rather than throw)");
    assert.deepEqual(
      loaded.data.mistakenBeliefs,
      {},
      "Missing mistakenBeliefs must default to {}",
    );
    assert.deepEqual(loaded.data.notes, ["legacy"], "Other fields must pass through unchanged");
  } finally {
    await rmFn(targetPath, { force: true });
  }
});

test("C4. normalizeChapterDelta backfills mistakenBeliefDeltas: []; round-trip through merge", () => {
  const legacyDelta = {
    entityMentions: [],
    sceneLedgerDelta: [],
    knowledgeChanges: [],
    irreversibleChanges: [],
    plotThreadProgression: [],
    revealPayoffMovement: [],
    activePressures: [],
    unresolvedThreads: [],
    nextChapterOpeningHandoff: "Continue.",
    activeVoiceSignals: [],
    storySpineUpdate: "Spine.",
    characterEmotionalStates: [],
  };
  const normalized = normalizeChapterDelta(legacyDelta as never);
  assert.deepEqual(normalized.mistakenBeliefDeltas, []);
  assert.equal(normalized.nextChapterOpeningHandoff, "Continue.", "Pre-existing fields must pass through");

  const fullDelta: ChapterDelta = {
    ...legacyDelta,
    mistakenBeliefDeltas: [{
      character: "Erik",
      op: "introduce",
      belief: "Flicker is a transformer fault.",
      basis: null,
      readerKnowsItIsWrong: true,
      consequence: null,
    }],
  };
  const noop = normalizeChapterDelta(fullDelta);
  assert.equal(noop.mistakenBeliefDeltas.length, 1, "Already-normalized delta must pass through");

  // Round-trip through merge: merge consumes the normalized deltas
  const merged = applyMistakenBeliefDeltas({
    current: {},
    deltas: noop.mistakenBeliefDeltas,
    chapterNumber: 1,
  });
  assert.equal(merged.Erik!.length, 1);
});

test("C5. compileChapterPacket reads mistakenBeliefs from prior state directly (NOT via projectStateToManifest)", async () => {
  // The static blueprint manifest projection (`ContinuityManifest`) is
  // unchanged. The new `mistakenBeliefs` field flows through a separate
  // top-level packet field by direct read from `ContinuityState`. We verify
  // by writing a synthetic `continuity-state-after-1.json` with beliefs
  // alongside a synthetic rolling memory, then driving `compileChapterPacket`
  // for chapter 2 against the live blueprint.
  const compiled = await compileBlueprintRuntime({
    blueprintPath: config.paths.blueprint,
    noGenreAi: true,
  });
  const ch2 = compiled.parsed.chapterOutline.find((o) => o.chapterNumber === 2);
  if (!ch2) return;
  const blueprintHash = compiled.parsed.blueprintHash;
  const blueprintVersion = compiled.parsed.metadata.blueprintVersion;
  const characterName = ch2.activeCast[0] ?? compiled.parsed.characters[0]?.name;
  if (!characterName) return;

  const stateArtifact: ArtifactEnvelope<ContinuityState> = {
    schemaVersion: config.artifactSchemaVersion,
    artifactType: "continuity-state",
    createdAt: new Date().toISOString(),
    blueprintHash,
    blueprintVersion,
    chapterNumber: 1,
    data: {
      chapterNumber: 1,
      persistentObjects: [],
      spatialRegistry: [],
      timelineAnchors: [],
      revealSchedule: [],
      relationshipStates: [],
      motifStates: [],
      notes: [],
      mistakenBeliefs: {
        [characterName]: [
          makeBelief({ belief: "The system held last night.", status: "active" }),
        ],
      },
    },
  };
  const memoryArtifact = {
    schemaVersion: config.artifactSchemaVersion,
    artifactType: "rolling-memory",
    createdAt: new Date().toISOString(),
    blueprintHash,
    blueprintVersion,
    chapterNumber: 1,
    data: {
      storySpine: "Spine.",
      unresolvedThreads: [],
      activePressures: [],
      knowledgeMatrix: [],
      activeCharacterVoiceCards: [],
      revealPayoffLedger: [],
      nextChapterOpeningHandoff: {
        openingSituation: "Open.",
        physicalState: [],
        emotionalState: [],
        causalState: [],
        mandatoryCallbacks: [],
        characterStates: [],
      },
      compressedHistory: [],
      lastChapterSummary: "Ch1.",
      emotionalStates: [],
    },
  };
  const stateTarget = path.join(config.paths.blueprintArtifacts, "continuity-state-after-1.json");
  const memoryTarget = path.join(config.paths.memoryArtifacts, "after-chapter-1.json");
  const { writeFile: writeFn, mkdir: mkdirFn, rm: rmFn, readFile: readFn } = await import("node:fs/promises");
  await mkdirFn(config.paths.blueprintArtifacts, { recursive: true });
  await mkdirFn(config.paths.memoryArtifacts, { recursive: true });
  const stateBackup = await readFn(stateTarget, "utf8").catch(() => null);
  const memoryBackup = await readFn(memoryTarget, "utf8").catch(() => null);
  try {
    await writeFn(stateTarget, JSON.stringify(stateArtifact, null, 2), "utf8");
    await writeFn(memoryTarget, JSON.stringify(memoryArtifact, null, 2), "utf8");

    const packetArtifact = await compileChapterPacket({
      chapterNumber: 2,
      blueprintArtifacts: compiled.artifacts,
    });
    const packet = packetArtifact.data;
    assert.ok(
      Object.prototype.hasOwnProperty.call(packet, "mistakenBeliefs"),
      "Packet must carry top-level mistakenBeliefs",
    );
    assert.equal(
      packet.mistakenBeliefs[characterName]?.length,
      1,
      "Packet must surface beliefs from ContinuityState directly",
    );
    assert.equal(packet.mistakenBeliefs[characterName]![0]!.belief, "The system held last night.");
  } finally {
    if (stateBackup !== null) await writeFn(stateTarget, stateBackup, "utf8");
    else await rmFn(stateTarget, { force: true });
    if (memoryBackup !== null) await writeFn(memoryTarget, memoryBackup, "utf8");
    else await rmFn(memoryTarget, { force: true });
  }
});

test("C5b. compileChapterPacket defaults mistakenBeliefs to {} when no prior state exists", () => {
  // Pure unit-level check on the empty-default behavior: a minimal packet
  // built via the test helper (which surfaces no prior state) must already
  // carry `mistakenBeliefs: {}`.
  const cast = [makeCharacterCard()];
  const packet = makeMinimalChapterPacket(cast);
  assert.deepEqual(packet.mistakenBeliefs, {});
});

test("C6. PromptCharacterView projects only active and questioned beliefs", () => {
  const cast: CharacterCard[] = [
    makeCharacterCard({ name: "Erik" }),
    makeCharacterCard({ name: "Vauclair", role: "antagonist" }),
  ];
  const packet = makeMinimalChapterPacket(cast);
  packet.mistakenBeliefs = {
    Erik: [
      makeBelief({ belief: "Active belief", status: "active" }),
      makeBelief({ belief: "Questioned belief", status: "questioned" }),
      makeBelief({ belief: "Corrected belief", status: "corrected" }),
      makeBelief({ belief: "Exploited belief", status: "exploited" }),
    ],
    Vauclair: [],
  };
  const view = buildSpecPacketView(packet);
  const erik = view.activeCast.find((c) => c.name === "Erik")!;
  assert.deepEqual(
    erik.mistakenBeliefs,
    ["Active belief", "Questioned belief"],
    "Only active + questioned beliefs must surface to the spec view",
  );
  const vauclair = view.activeCast.find((c) => c.name === "Vauclair")!;
  assert.deepEqual(vauclair.mistakenBeliefs, []);
});

test("C7. buildVoiceCardSummary appends believes=[...] when active/questioned beliefs exist; omits otherwise", () => {
  const character = makeCharacterCard({ name: "Erik", role: "protagonist" });
  const runtimeCard: VoiceCard = {
    character: "Erik",
    activeTraits: ["Calm under pressure"],
    stressPattern: "Goes quieter when wary.",
    dialogueHabits: ["Cuts to the question"],
    tabooNotes: [],
    updatedFromChapter: 1,
  };
  const withBeliefs = buildVoiceCardSummary([character], [runtimeCard], {
    Erik: ["Flicker is a transformer fault.", "The room respects him."],
  });
  assert.ok(
    withBeliefs.includes(`believes=["Flicker is a transformer fault.", "The room respects him."]`),
    `Voice-card summary must append believes=[...] for active/questioned beliefs; got: ${withBeliefs}`,
  );

  const withoutBeliefs = buildVoiceCardSummary([character], [runtimeCard], {});
  assert.equal(
    withoutBeliefs.includes("believes="),
    false,
    "Voice-card summary must omit the believes= segment when the array is empty/absent",
  );
});

test("C8. buildEffectTics: deterministic fallback emits seed catalog when text is empty; corpus path can override", () => {
  const fallback = buildEffectTics("");
  assert.deepEqual(
    fallback,
    EFFECT_TICS_SEED,
    "Empty corpus must emit the seed catalog as the deterministic fallback",
  );

  // Corpus-derived path: produce text that exercises body-anchor frequency.
  const corpus = "He set his palm flat on the rail. The palm pressed against acrylic. "
    + "Her palm rested on the cold panel. As if the room had decided. As though it had not.";
  const tics = buildEffectTics(corpus);
  assert.ok(
    tics.bodyAnchors.includes("palm"),
    `Corpus path must keep body-anchor 'palm' (>=3 occurrences); got: ${tics.bodyAnchors.join(", ")}`,
  );
});

test("C9. loadVoiceTargetIfPresent defaults effectTics to all-empty arrays when absent on legacy artifact", async () => {
  const { writeFile: writeFn, mkdir: mkdirFn, rm: rmFn, readFile: readFn } = await import("node:fs/promises");
  await mkdirFn(config.paths.blueprintArtifacts, { recursive: true });
  const targetPath = path.join(config.paths.blueprintArtifacts, "voice-target.json");
  const backup = await readFn(targetPath, "utf8").catch(() => null);
  try {
    const legacyArtifact = {
      schemaVersion: config.artifactSchemaVersion,
      artifactType: "voice-target",
      createdAt: new Date().toISOString(),
      blueprintHash: "test-hash",
      blueprintVersion: "1.0.0",
      data: {
        source: "derived",
        derivedFromChapters: [1],
        fingerprint: {
          sentenceLength: { mean: 0, stdDev: 0, median: 0, p90: 0, histogram: [] },
          paragraphRhythm: { meanWords: 0, medianWords: 0, shortParagraphRatio: 0, longParagraphRatio: 0 },
          signatureLexicon: [],
          recurringMetaphorFamilies: [],
          dialogueTagConventions: { tagsPer1000Words: 0, saidShare: 0, variedTagShare: 0, sampleTags: [] },
          povInteriorityDensity: { interiorMarkersPer1000Words: 0, sampleMarkers: [] },
          // effectTics intentionally absent — emulates pre-update artifact
        },
        guidanceLines: [],
      },
    };
    await writeFn(targetPath, JSON.stringify(legacyArtifact, null, 2), "utf8");
    const loaded = await loadVoiceTargetIfPresent({
      blueprintHash: "test-hash",
      blueprintVersion: "1.0.0",
    });
    assert.ok(loaded, "Legacy voice-target.json must load (soft default rather than throw)");
    const tics = loaded.data.fingerprint.effectTics;
    assert.deepEqual(tics, {
      bodyAnchors: [],
      rhetoricalStructures: [],
      modifierTics: [],
      sensoryTics: [],
      gestureTics: [],
      abstractionTics: [],
      balancedClauseTics: [],
    });
  } finally {
    if (backup !== null) {
      await writeFn(targetPath, backup, "utf8");
    } else {
      await rmFn(targetPath, { force: true });
    }
  }
});

test("C10. buildEffectTicLookup constructs sets from VoiceTarget; null returns all-empty sets", () => {
  const empty = buildEffectTicLookup(null);
  for (const key of [
    "bodyAnchors",
    "rhetoricalStructures",
    "modifierTics",
    "sensoryTics",
    "gestureTics",
    "abstractionTics",
    "balancedClauseTics",
  ] as const) {
    assert.equal(empty[key].size, 0, `${key} must be an empty set when voiceTarget is null`);
  }

  const voiceTarget: VoiceTarget = {
    source: "derived",
    derivedFromChapters: [1],
    fingerprint: {
      sentenceLength: { mean: 0, stdDev: 0, median: 0, p90: 0, histogram: [] },
      paragraphRhythm: { meanWords: 0, medianWords: 0, shortParagraphRatio: 0, longParagraphRatio: 0 },
      signatureLexicon: [],
      recurringMetaphorFamilies: [],
      dialogueTagConventions: { tagsPer1000Words: 0, saidShare: 0, variedTagShare: 0, sampleTags: [] },
      povInteriorityDensity: { interiorMarkersPer1000Words: 0, sampleMarkers: [] },
      effectTics: {
        bodyAnchors: ["ribs", "palm"],
        rhetoricalStructures: ["as if"],
        modifierTics: ["small"],
        sensoryTics: [],
        gestureTics: [],
        abstractionTics: [],
        balancedClauseTics: [],
      },
    },
    guidanceLines: [],
  };
  const populated = buildEffectTicLookup(voiceTarget);
  assert.equal(populated.bodyAnchors.has("ribs"), true);
  assert.equal(populated.bodyAnchors.has("palm"), true);
  assert.equal(populated.rhetoricalStructures.has("as if"), true);
  assert.equal(populated.modifierTics.has("small"), true);
  assert.equal(populated.sensoryTics.size, 0);
});

const VG_FILLER = "Opening filler that pushes past the protected first 200 words. ".repeat(40).trim();

function makeVgProse(midSentence: string): string {
  return [
    "Title",
    VG_FILLER,
    `She turned the corner. ${midSentence} The hallway stretched on after that.`,
    "More prose. Filler line two. Filler line three.",
    "The closing paragraph lands quietly on a held breath.",
  ].join("\n\n");
}

const VG_LOOKUP: Parameters<typeof applyVoiceGritPatches>[0]["effectTics"]
  = (() => {
    const target: VoiceTarget = {
      source: "derived",
      derivedFromChapters: [1],
      fingerprint: {
        sentenceLength: { mean: 0, stdDev: 0, median: 0, p90: 0, histogram: [] },
        paragraphRhythm: { meanWords: 0, medianWords: 0, shortParagraphRatio: 0, longParagraphRatio: 0 },
        signatureLexicon: [],
        recurringMetaphorFamilies: [],
        dialogueTagConventions: { tagsPer1000Words: 0, saidShare: 0, variedTagShare: 0, sampleTags: [] },
        povInteriorityDensity: { interiorMarkersPer1000Words: 0, sampleMarkers: [] },
        effectTics: {
          bodyAnchors: ["ribs", "palm"],
          rhetoricalStructures: ["as if"],
          modifierTics: ["small"],
          sensoryTics: [],
          gestureTics: [],
          abstractionTics: [],
          balancedClauseTics: [],
        },
      },
      guidanceLines: [],
    };
    return buildEffectTicLookup(target);
  })();

test("C11. voice-grit patch validator: repeated-effect + voice-tic ticSource shape rules", () => {
  const target = "MID-EFFECT-ANCHOR.";
  const prose = makeVgProse(target);

  // 11a: canonical repeated-effect ticSource that matches the lookup → applied
  const okPatch: GritPatch = {
    texture: "repeated-effect",
    originalText: target,
    replacementText: "MID-EFFECT-VARIED.",
    earnedJustification: "Third 'ribs' body anchor; no escalation.",
    ticSource: "effectTics.bodyAnchors:ribs",
  };
  const okResult = applyVoiceGritPatches({
    prose,
    patches: [okPatch],
    voiceCards: { activeTraits: new Set(), dialogueHabits: new Set(), taboos: new Set() },
    effectTics: VG_LOOKUP,
  });
  assert.equal(okResult.applied.length, 1);
  assert.equal(okResult.skipped.length, 0);

  // 11b: ticSource entry not in lookup → skipped
  const missingPatch: GritPatch = {
    texture: "repeated-effect",
    originalText: target,
    replacementText: "MID-EFFECT-VARIED.",
    earnedJustification: "x",
    ticSource: "effectTics.bodyAnchors:notpresent",
  };
  const missingResult = applyVoiceGritPatches({
    prose,
    patches: [missingPatch],
    voiceCards: { activeTraits: new Set(), dialogueHabits: new Set(), taboos: new Set() },
    effectTics: VG_LOOKUP,
  });
  assert.equal(missingResult.applied.length, 0);
  assert.equal(missingResult.skipped.length, 1);
  assert.match(missingResult.skipped[0]!.skipReason, /not present in effectTics/);

  // 11c: repeated-effect with activeTraits-shaped ticSource → wrong shape, skipped
  const wrongShape: GritPatch = {
    texture: "repeated-effect",
    originalText: target,
    replacementText: "MID-EFFECT-VARIED.",
    earnedJustification: "x",
    ticSource: "Counts before he speaks",
  };
  const wrongShapeResult = applyVoiceGritPatches({
    prose,
    patches: [wrongShape],
    voiceCards: { activeTraits: new Set(["Counts before he speaks"]), dialogueHabits: new Set(), taboos: new Set() },
    effectTics: VG_LOOKUP,
  });
  assert.equal(wrongShapeResult.applied.length, 0);
  assert.match(wrongShapeResult.skipped[0]!.skipReason, /canonical form/);

  // 11d: voice-tic with effectTics-shaped ticSource → wrong shape, skipped
  const crossShape: GritPatch = {
    texture: "voice-tic",
    originalText: target,
    replacementText: "MID-EFFECT-VARIED.",
    earnedJustification: "x",
    ticSource: "effectTics.bodyAnchors:ribs",
  };
  const crossShapeResult = applyVoiceGritPatches({
    prose,
    patches: [crossShape],
    voiceCards: { activeTraits: new Set(), dialogueHabits: new Set(), taboos: new Set() },
    effectTics: VG_LOOKUP,
  });
  assert.equal(crossShapeResult.applied.length, 0);
  assert.match(crossShapeResult.skipped[0]!.skipReason, /effectTics entry/);

  // 11e: tabooed entries excluded for both textures
  const tabooedRepeatedEffect: GritPatch = {
    texture: "repeated-effect",
    originalText: target,
    replacementText: "MID-EFFECT-VARIED.",
    earnedJustification: "x",
    ticSource: "effectTics.bodyAnchors:ribs",
  };
  const tabooResult = applyVoiceGritPatches({
    prose,
    patches: [tabooedRepeatedEffect],
    voiceCards: { activeTraits: new Set(), dialogueHabits: new Set(), taboos: new Set(["ribs"]) },
    effectTics: VG_LOOKUP,
  });
  assert.equal(tabooResult.applied.length, 0);
  assert.match(tabooResult.skipped[0]!.skipReason, /tabooNote/);
});

test("C12. repeated-effect patches honor reserved zones and per-scene cap via existing validator path", () => {
  // Reserved-zone case: place the original text in the chapter opening
  // (within the protected first ~200 words).
  const target = "MID-OPENING-EFFECT.";
  const reservedProse = [
    "Title",
    `${target} ` + "tail content. ".repeat(30).trim(),
    "Body paragraph two. With a few sentences. To buffer the rejudge zone.",
    "The closing paragraph lands quietly on a held breath.",
  ].join("\n\n");
  const reservedPatch: GritPatch = {
    texture: "repeated-effect",
    originalText: target,
    replacementText: "MID-OPENING-VARIED.",
    earnedJustification: "x",
    ticSource: "effectTics.bodyAnchors:ribs",
  };
  const reservedResult = applyVoiceGritPatches({
    prose: reservedProse,
    patches: [reservedPatch],
    voiceCards: { activeTraits: new Set(), dialogueHabits: new Set(), taboos: new Set() },
    effectTics: VG_LOOKUP,
  });
  assert.equal(reservedResult.applied.length, 0);
  assert.match(reservedResult.skipped[0]!.skipReason, /reserved zone/);

  // Per-scene cap: 3 repeated-effect patches in a single scene → only 2 apply.
  const sceneProse = [
    "Title",
    VG_FILLER,
    "She paced the deck. MID-A-ANCHOR. Then MID-B-ANCHOR. Then MID-C-ANCHOR. Then she stopped at the rail.",
    "More prose lines. Three sentences here. To buffer the rejudge zone.",
    "The closing line stays sealed against any patch.",
  ].join("\n\n");
  const scenePatches: GritPatch[] = ["A", "B", "C"].map((tag) => ({
    texture: "repeated-effect",
    originalText: `MID-${tag}-ANCHOR.`,
    replacementText: `MID-${tag}-VARIED.`,
    earnedJustification: "x",
    ticSource: "effectTics.bodyAnchors:ribs",
  }));
  const sceneResult = applyVoiceGritPatches({
    prose: sceneProse,
    patches: scenePatches,
    voiceCards: { activeTraits: new Set(), dialogueHabits: new Set(), taboos: new Set() },
    effectTics: VG_LOOKUP,
  });
  assert.equal(sceneResult.applied.length, 2);
  assert.equal(sceneResult.skipped.length, 1);
  assert.match(sceneResult.skipped[0]!.skipReason, /Per-scene cap/);
});
