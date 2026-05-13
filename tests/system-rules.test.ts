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
import { chapterSpecSchema } from "../src/pipeline/generate-spec.js";
import { buildSpecPacketView } from "../src/pipeline/prompt-packet-views.js";
import { createSmokeSpec } from "../src/pipeline/smoke-helpers.js";
import type {
  ChapterFunctionProfile,
  ChapterPacket,
  ChapterSpec,
  CharacterCard,
  GenreContract,
  MarketPositioningSection,
  StoryPromiseSection,
  VoiceCard,
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
});

test("buildJudgeInstructions includes SCENE TURN CHECK and NAMED WITHOUT FUTURE USE blocks", () => {
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
