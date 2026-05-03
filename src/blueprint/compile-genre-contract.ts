import defaultPresets from "./genre-defaults.json" with { type: "json" };

import { config } from "../config.js";
import { generateStructuredOutput, hasOpenAiCredentials } from "../api/openai.js";
import type {
  GenreContract,
  GenreRuntimeControls,
  ParsedStoryBlueprint,
} from "../types/index.js";
import { normalizeLookupKey } from "../utils/index.js";

const GENRE_CONTROL_KEYS = [
  "pacingCurve",
  "sceneDensity",
  "dialogueRatioTarget",
  "interiorityRatioTarget",
  "revealCadence",
  "hookStyle",
  "endingMode",
  "povDistance",
  "ambiguityTolerance",
  "sensoryDensity",
  "proseCompression",
  "emotionalDwellExpectation",
  "violenceExplicitness",
  "romanceProminence",
] as const;

type GenrePresetDocument = {
  default: GenreRuntimeControls;
  presets: Record<string, GenreRuntimeControls>;
};

type GenreRefinementResponse = GenreRuntimeControls & {
  notes: string[];
};

const genreRefinementSchema = {
  type: "object",
  properties: {
    pacingCurve: { type: "string", minLength: 1 },
    sceneDensity: { type: "string", minLength: 1 },
    dialogueRatioTarget: { type: "string", minLength: 1 },
    interiorityRatioTarget: { type: "string", minLength: 1 },
    revealCadence: { type: "string", minLength: 1 },
    hookStyle: { type: "string", minLength: 1 },
    endingMode: { type: "string", minLength: 1 },
    povDistance: { type: "string", minLength: 1 },
    ambiguityTolerance: { type: "string", minLength: 1 },
    sensoryDensity: { type: "string", minLength: 1 },
    proseCompression: { type: "string", minLength: 1 },
    emotionalDwellExpectation: { type: "string", minLength: 1 },
    violenceExplicitness: { type: "string", minLength: 1 },
    romanceProminence: { type: "string", minLength: 1 },
    validatorThresholdOverrides: {
      type: "array",
      items: { type: "string" },
    },
    notes: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: [
    "pacingCurve",
    "sceneDensity",
    "dialogueRatioTarget",
    "interiorityRatioTarget",
    "revealCadence",
    "hookStyle",
    "endingMode",
    "povDistance",
    "ambiguityTolerance",
    "sensoryDensity",
    "proseCompression",
    "emotionalDwellExpectation",
    "violenceExplicitness",
    "romanceProminence",
    "validatorThresholdOverrides",
    "notes",
  ],
  additionalProperties: false,
} as const;

function mergeControls(
  base: GenreRuntimeControls,
  updates: Partial<GenreRuntimeControls>,
): GenreRuntimeControls {
  return {
    ...base,
    ...updates,
    validatorThresholdOverrides: updates.validatorThresholdOverrides ?? base.validatorThresholdOverrides,
  };
}

function splitGenreLabels(value: string): string[] {
  return value
    .split(/[\/,;]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolvePresetKeys(blueprint: ParsedStoryBlueprint, document: GenrePresetDocument): string[] {
  const candidates = [
    ...splitGenreLabels(blueprint.genre.primaryGenre),
    ...blueprint.genre.subgenres,
  ].map(normalizeLookupKey);

  return Object.keys(document.presets).filter((presetKey) => {
    const normalizedPreset = normalizeLookupKey(presetKey);
    return candidates.some((candidate) => (
      candidate.includes(normalizedPreset) || normalizedPreset.includes(candidate)
    ));
  });
}

export async function compileGenreContract(
  blueprint: ParsedStoryBlueprint,
  options: { noGenreAi: boolean },
): Promise<GenreContract> {
  const document = defaultPresets as GenrePresetDocument;
  const matchedPresetKeys = resolvePresetKeys(blueprint, document);

  let controls = { ...document.default };
  for (const presetKey of matchedPresetKeys) {
    const preset = document.presets[presetKey];
    if (preset) {
      controls = mergeControls(controls, preset);
    }
  }

  const explicitOverrides = blueprint.genre.runtimeOverrides;
  controls = mergeControls(controls, explicitOverrides);

  const explicitOverrideKeys = new Set(Object.keys(explicitOverrides));
  let aiRefinementUsed = false;
  let aiRefinementNotes: string[] = [];

  if (!options.noGenreAi && hasOpenAiCredentials()) {
    const result = await generateStructuredOutput<GenreRefinementResponse>({
      stage: config.stageProfiles.genreCompilation,
      instructions: [
        "You compile machine-readable genre behavior for a chapter-by-chapter fiction runtime.",
        "Respect explicit blueprint overrides as locked values.",
        "Use market positioning, tone, and comparables to refine unspecified controls.",
        "Return concise values that materially change pacing, reveal behavior, and prose handling.",
      ].join("\n"),
      prompt: [
        `Blueprint title: ${blueprint.metadata.title}`,
        `Primary genre: ${blueprint.genre.primaryGenre}`,
        `Subgenres: ${blueprint.genre.subgenres.join(", ") || "None"}`,
        `Tone keywords: ${blueprint.genre.toneKeywords.join(", ") || "None"}`,
        `Reader experience: ${blueprint.genre.readerExperience || "Not specified"}`,
        `Market positioning: ${blueprint.marketPositioning.shelfPositioning || "Not specified"}`,
        `Comparables: ${blueprint.marketPositioning.comparables.join(", ") || "None"}`,
        `Current controls: ${JSON.stringify(controls, null, 2)}`,
        `Locked override keys: ${Array.from(explicitOverrideKeys).join(", ") || "None"}`,
        "Refine the controls for runtime use.",
      ].join("\n\n"),
      schemaName: "genre_contract_refinement",
      schema: genreRefinementSchema,
    });

    for (const key of GENRE_CONTROL_KEYS) {
      if (!explicitOverrideKeys.has(key)) {
        controls[key] = result.value[key];
      }
    }

    if (!explicitOverrideKeys.has("validatorThresholdOverrides")) {
      controls.validatorThresholdOverrides = result.value.validatorThresholdOverrides;
    }

    aiRefinementUsed = true;
    aiRefinementNotes = result.value.notes;
  }

  return {
    primaryGenre: blueprint.genre.primaryGenre,
    contributingGenres: matchedPresetKeys,
    toneKeywords: blueprint.genre.toneKeywords,
    readerExperience: blueprint.genre.readerExperience,
    controls,
    aiRefinementUsed,
    aiRefinementNotes,
  };
}
