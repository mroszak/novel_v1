import { generateText as generateAnthropicText } from "../api/anthropic.js";
import { generateStructuredOutput } from "../api/openai.js";
import { config } from "../config.js";
import type {
  ArtifactEnvelope,
  BlueprintCompilationArtifacts,
  ChapterFunction,
  ChapterPacket,
  ChapterRetentionFunction,
  ChapterSpec,
  CompiledStoryBlueprint,
  GenreContract,
  OpusSpecCritique,
  SelfRedTeamReport,
} from "../types/index.js";
import { buildSpecPacketView } from "./prompt-packet-views.js";
import { createSmokeSelfRedTeam, createSmokeSpec } from "./smoke-helpers.js";
import { BlockedPipelineError, chapterArtifactPath, createArtifact } from "./stage-utils.js";
import { compactJson, normalizeLookupKey, writeJson } from "../utils/index.js";

export const chapterSpecSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
    purpose: { type: "string", minLength: 1 },
    openingImage: { type: "string", minLength: 1 },
    scenePlan: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          sceneNumber: { type: "integer", minimum: 1 },
          location: { type: "string", minLength: 1 },
          objective: { type: "string", minLength: 1 },
          summary: { type: "string", minLength: 1 },
          turn: { type: "string", minLength: 1 },
          revealHandling: { type: "string", minLength: 1 },
          exitCondition: { type: "string", minLength: 1 },
          emotionalArc: { type: "string", minLength: 1 },
          sensoryAnchor: { type: "string", minLength: 1 },
          dialogueStrategy: { type: "string", minLength: 1 },
          humanGrain: {
            anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
          },
        },
        required: [
          "sceneNumber",
          "location",
          "objective",
          "summary",
          "turn",
          "revealHandling",
          "exitCondition",
          "emotionalArc",
          "sensoryAnchor",
          "dialogueStrategy",
          "humanGrain",
        ],
        additionalProperties: false,
      },
    },
    mandatoryBeatCoverage: {
      type: "array",
      items: {
        type: "object",
        properties: {
          beat: { type: "string", minLength: 1 },
          deliveryPlan: { type: "string", minLength: 1 },
        },
        required: ["beat", "deliveryPlan"],
        additionalProperties: false,
      },
    },
    callbackPlan: {
      type: "array",
      items: { type: "string" },
    },
    revealControl: {
      type: "object",
      properties: {
        show: { type: "array", items: { type: "string" } },
        hint: { type: "array", items: { type: "string" } },
        reveal: { type: "array", items: { type: "string" } },
        withhold: { type: "array", items: { type: "string" } },
      },
      required: ["show", "hint", "reveal", "withhold"],
      additionalProperties: false,
    },
    continuityWatchouts: {
      type: "array",
      items: { type: "string" },
    },
    proseGuidance: {
      type: "array",
      items: { type: "string" },
    },
    physicalClueAnchors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          clue: { type: "string", minLength: 1 },
          anchor: { type: "string", minLength: 1 },
          beforeState: { type: "string", minLength: 1 },
          afterState: { type: "string", minLength: 1 },
        },
        required: ["clue", "anchor", "beforeState", "afterState"],
        additionalProperties: false,
      },
    },
    endingBeat: { type: "string", minLength: 1 },
  },
  required: [
    "title",
    "purpose",
    "openingImage",
    "scenePlan",
    "mandatoryBeatCoverage",
    "callbackPlan",
    "revealControl",
    "continuityWatchouts",
    "proseGuidance",
    "physicalClueAnchors",
    "endingBeat",
  ],
  additionalProperties: false,
} as const;

const selfRedTeamSchema = {
  type: "object",
  properties: {
    criticalIssues: {
      type: "array",
      items: { type: "string" },
    },
    weaknesses: {
      type: "array",
      items: { type: "string" },
    },
    missingBeats: {
      type: "array",
      items: { type: "string" },
    },
    confidenceScore: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
    needsOpusEscalation: {
      type: "boolean",
    },
    revisionActions: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: [
    "criticalIssues",
    "weaknesses",
    "missingBeats",
    "confidenceScore",
    "needsOpusEscalation",
    "revisionActions",
  ],
  additionalProperties: false,
} as const;

function parseAnthropicJson<T>(raw: string): T {
  const trimmed = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("Anthropic spec critique did not return valid JSON.");
    }
    return JSON.parse(match[0]) as T;
  }
}

const BEAT_COVERAGE_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is",
  "of", "on", "or", "the", "to", "with",
]);

const NUMBER_WORDS: Record<string, string> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
};

function normalizeBeatCoverageToken(token: string): string {
  const normalized = NUMBER_WORDS[token] ?? token;
  if (/^\d+$/.test(normalized)) return normalized;
  if (normalized.endsWith("ies") && normalized.length > 4) {
    return `${normalized.slice(0, -3)}y`;
  }
  if (normalized.endsWith("s") && normalized.length > 3) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function beatCoverageTokens(value: string): string[] {
  return normalizeLookupKey(value)
    .split(" ")
    .map(normalizeBeatCoverageToken)
    .filter((token) => token && !BEAT_COVERAGE_STOPWORDS.has(token));
}

function tokenSequenceIncludes(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || haystack.length < needle.length) return false;
  return haystack.some((_, index) => (
    needle.every((token, offset) => haystack[index + offset] === token)
  ));
}

function tokenSetCovers(haystack: string[], needle: string[]): boolean {
  const haystackSet = new Set(haystack);
  return needle.length > 0 && [...new Set(needle)].every((token) => haystackSet.has(token));
}

export function beatCovered(packetBeat: string, spec: ChapterSpec): boolean {
  const target = beatCoverageTokens(packetBeat);
  return spec.mandatoryBeatCoverage.some((item) => {
    const beatText = beatCoverageTokens(item.beat);
    const planText = beatCoverageTokens(item.deliveryPlan);
    const combinedText = [...beatText, ...planText];
    return tokenSequenceIncludes(beatText, target)
      || tokenSequenceIncludes(target, beatText)
      || tokenSequenceIncludes(planText, target)
      || tokenSetCovers(combinedText, target);
  });
}

/**
 * Snap each `mandatoryBeatCoverage[].beat` field to its matching packet
 * mandatoryBeat by Jaccard-like token overlap. The `beat` field is a label
 * referencing which packet beat the entry covers — `deliveryPlan` is what
 * the drafter consumes — so models that paraphrase the label should not
 * trip the deterministic coverage check.
 *
 * Snap only when an entry's combined beat+plan tokens cover at least 30%
 * of a packet beat's distinct content tokens, so genuinely-orphaned spec
 * entries are left alone and packet beats with no entry still fall
 * through to assertMandatoryBeatCoverage as a real coverage failure.
 */
export function alignMandatoryBeatCoverage(
  packetBeats: string[],
  spec: ChapterSpec,
): ChapterSpec {
  const packetTokenSets = packetBeats.map((beat) => ({
    beat,
    tokens: new Set(beatCoverageTokens(beat)),
  }));

  const aligned = spec.mandatoryBeatCoverage.map((entry) => {
    const entryTokens = new Set([
      ...beatCoverageTokens(entry.beat),
      ...beatCoverageTokens(entry.deliveryPlan),
    ]);
    let bestScore = 0;
    let bestBeat: string | null = null;
    for (const { beat, tokens } of packetTokenSets) {
      if (tokens.size === 0) continue;
      let overlap = 0;
      for (const token of tokens) if (entryTokens.has(token)) overlap += 1;
      const score = overlap / tokens.size;
      if (score > bestScore) {
        bestScore = score;
        bestBeat = beat;
      }
    }
    if (bestBeat && bestScore >= 0.3 && bestBeat !== entry.beat) {
      return { ...entry, beat: bestBeat };
    }
    return entry;
  });

  return { ...spec, mandatoryBeatCoverage: aligned };
}

function assertMandatoryBeatCoverage(packet: ChapterPacket, spec: ChapterSpec): void {
  const missing = packet.mandatoryBeats.filter((beat) => !beatCovered(beat, spec));
  if (missing.length > 0) {
    throw new BlockedPipelineError(
      "BLOCKED_QUALITY",
      "spec-revision",
      `Approved spec is missing mandatory beat coverage for: ${missing.join("; ")}`,
      { missingBeats: missing },
    );
  }
}

interface CritiqueDecision {
  run: boolean;
  required: boolean;
}

export function shouldRunOpusCritique(
  packetArtifact: ArtifactEnvelope<ChapterPacket>,
  report: SelfRedTeamReport,
  skip: boolean,
): CritiqueDecision {
  const required = packetArtifact.data.riskLevel === "high" || report.needsOpusEscalation;
  if (skip) {
    if (required) {
      console.error(
        `[spec-critique] --skip-spec-critique ignored: critique is required`
        + ` (riskLevel=${packetArtifact.data.riskLevel}, needsOpusEscalation=${report.needsOpusEscalation})`,
      );
    }
    return { run: required, required };
  }
  const preferred = config.qualitySettings.alwaysRunSpecCritique;
  return { run: required || preferred, required };
}

export function mapChapterFunctionToReaderJob(
  chapterFunction: ChapterFunction,
  marketPromise: ChapterPacket["marketPromise"],
): string | null {
  if (!marketPromise || marketPromise.chapterRetentionStrategy.length === 0) return null;
  const map: Record<ChapterFunction, ChapterRetentionFunction> = {
    opening: "opening",
    escalation: "early-escalation",
    midpoint: "midpoint",
    reveal: "midpoint",
    reversal: "late-escalation",
    climax: "climax",
    aftermath: "aftermath",
    resolution: "aftermath",
  };
  const target = map[chapterFunction];
  const entry = marketPromise.chapterRetentionStrategy.find((e) => e.chapterFunction === target);
  return entry?.readerJob ?? null;
}

export function buildSpecGenerationRequest(params: {
  storyCore: CompiledStoryBlueprint;
  genreContract: GenreContract;
  packet: ChapterPacket;
}): {
  instructions: string;
  prompt: string;
  schemaName: string;
  schema: typeof chapterSpecSchema;
} {
  const promptPacket = buildSpecPacketView(params.packet);
  const marketPromise = params.packet.marketPromise;
  const continuitySlice = params.packet.continuityActiveSlice;
  const readerJob = mapChapterFunctionToReaderJob(params.packet.chapterFunction.function, marketPromise);

  const promptParts: string[] = [
    `Story promise: ${compactJson(params.storyCore.storyPromise)}`,
    `Market positioning: ${compactJson(params.storyCore.marketPositioning)}`,
  ];

  if (marketPromise) {
    promptParts.push(
      `Market promise: ${compactJson({
        coreCommercialHook: marketPromise.coreCommercialHook,
        emotionalPromise: marketPromise.emotionalPromise,
        tropeStack: marketPromise.tropeStack,
        freshnessAngle: marketPromise.freshnessAngle,
        pacingContract: marketPromise.pacingContract,
      })}`,
    );
  }

  if (readerJob) {
    promptParts.push(
      `READER JOB FOR THIS CHAPTER FUNCTION (${params.packet.chapterFunction.function}): ${readerJob}`,
      "The spec must target this reader job explicitly. The chapter ending hook must serve it. Mandatory beats must be staged in service of it.",
    );
  }

  promptParts.push(
    `Genre contract: ${compactJson(params.genreContract)}`,
    `Section digests: ${compactJson(params.storyCore.sectionDigests)}`,
    `Style rules:\n${params.storyCore.styleRules.join("\n") || "None"}`,
    `Anti-patterns:\n${params.storyCore.antiPatterns.join("\n") || "None"}`,
    `Motif bank: ${params.storyCore.motifBank.join(" | ") || "None"}`,
  );

  if (continuitySlice) {
    promptParts.push(
      `Continuity active slice (declare your continuity intentions per scene; do not contradict): ${compactJson(continuitySlice)}`,
    );
  }

  promptParts.push(`Chapter packet: ${compactJson(promptPacket)}`);

  return {
    instructions: [
      "You are the planning model for a chapter-by-chapter novel engine.",
      "Create a machine-usable chapter spec for one chapter only.",
      "Honor reveal control, mandatory beats, active cast, target word band, ending hook, and continuity notes.",
      "`secondaryCameoBeats` are soft cameo obligations: weave them in passing through the named POVs if natural; their absence is not a blocker and they must not be elevated into mandatory beats or scene-driving plot.",
      "When `namedCharacterCap` is set, the chapter must keep distinct named blueprint characters at or below the cap. Use unnamed walk-ons (`the waiter`, `the senator's aide`, `a girl in service black`) for any human detail beyond the cap; they do not count.",
      "When a Market Promise is provided, target its commercial hook and emotional promise. When a reader job is provided for this chapter function, the spec must serve it explicitly.",
      "When a continuity active slice is provided, declare your continuity intentions per scene and do not contradict it.",
      "When a `locations` table is provided in the chapter packet, treat its `name` field as the canonical name for each recurring space. Use that exact name (or one of its `aliases`) when planning scene locations; do not invent variant names.",
      "Keep the plan genre-adaptive and specific enough for a full-chapter Opus draft.",
      "For each scene in scenePlan, include emotionalArc (the POV character's emotional trajectory through the scene), sensoryAnchor (the dominant sensory environment), and dialogueStrategy (how dialogue serves the scene).",
      "For each scene, set `humanGrain` only when the scene risks reading purely symbolic or elegant. Otherwise set it to null. Do not invent forced business; if existing scene material already carries ordinary friction, leave it null.",
      "When this chapter contains a clue whose physical state visibly changes between two scenes within the chapter, declare it in `physicalClueAnchors` with a simple fixed marker and an unmistakable before/after pair. Both states must be observable in the chapter's prose. Leave the array empty when no in-chapter physical change is planned; cross-chapter plants belong in `revealControl`, not here.",
      "In proseGuidance, include 2-4 concrete prose targets: dominant sensory channel for the chapter, a signature metaphor or image family, and the primary dialogue tactic for the POV character.",
      "Style rules from the author's blueprint take priority over any general guidance.",
    ].join("\n"),
    prompt: promptParts.join("\n\n"),
    schemaName: "chapter_spec",
    schema: chapterSpecSchema,
  };
}

export function buildSelfRedTeamRequest(params: {
  packet: ChapterPacket;
  spec: ChapterSpec;
}): {
  instructions: string;
  prompt: string;
  schemaName: string;
  schema: typeof selfRedTeamSchema;
} {
  return {
    instructions: [
      "You are the self-red-team model for a chapter spec.",
      "Look for weak causality, generic beats, reveal leaks, continuity drift, flat tension, and missed chapter obligations.",
      "Check temporal causality against the rolling memory and compressed history: does the spec's plan follow logically from where the story actually is?",
      "Verify that emotional arcs, sensory anchors, and dialogue strategies are specific rather than generic.",
      "Escalate to Opus only when the spec is high risk, structurally weak, or low confidence.",
    ].join("\n"),
    prompt: [
      `Chapter packet: ${compactJson(buildSpecPacketView(params.packet))}`,
      `Current spec: ${compactJson(params.spec)}`,
    ].join("\n\n"),
    schemaName: "self_red_team_report",
    schema: selfRedTeamSchema,
  };
}

export function buildSpecCritiqueRequest(params: {
  genreContract: GenreContract;
  packet: ChapterPacket;
  spec: ChapterSpec;
}): {
  system: string;
  prompt: string;
} {
  return {
    system: [
      "You are Opus reviewing a fiction chapter plan before drafting.",
      "Critique the spec for structural weakness, continuity threat, reveal leakage, generic beats, and draftability.",
      "Return strict JSON only with keys majorRisks, continuityThreats, proseThreats, suggestedFixes.",
    ].join("\n"),
    prompt: [
      "<genre_contract>",
      compactJson(params.genreContract),
      "</genre_contract>",
      "<chapter_packet>",
      compactJson(buildSpecPacketView(params.packet)),
      "</chapter_packet>",
      "<chapter_spec>",
      compactJson(params.spec),
      "</chapter_spec>",
    ].join("\n"),
  };
}

export function buildSpecRevisionRequest(params: {
  packet: ChapterPacket;
  spec: ChapterSpec;
  selfRedTeam: SelfRedTeamReport;
  opusCritique?: OpusSpecCritique;
}): {
  instructions: string;
  prompt: string;
  schemaName: string;
  schema: typeof chapterSpecSchema;
} {
  return {
    instructions: [
      "Revise the spec until it is draft-ready.",
      "Fix every critical issue, retain the chapter promise, and keep the plan sharp instead of bloated.",
      "Do not leak withheld information early.",
    ].join("\n"),
    prompt: [
      `Chapter packet: ${compactJson(buildSpecPacketView(params.packet))}`,
      `Current spec: ${compactJson(params.spec)}`,
      `Self-red-team report: ${compactJson(params.selfRedTeam)}`,
      params.opusCritique
        ? `Opus critique: ${compactJson(params.opusCritique)}`
        : "",
    ].filter(Boolean).join("\n\n"),
    schemaName: "approved_chapter_spec",
    schema: chapterSpecSchema,
  };
}

export async function runSpecLoop(params: {
  packetArtifact: ArtifactEnvelope<ChapterPacket>;
  blueprintArtifacts: BlueprintCompilationArtifacts;
  smoke: boolean;
  skipSpecCritique: boolean;
}): Promise<{
  specArtifact: ArtifactEnvelope<ChapterSpec>;
  selfRedTeamArtifact: ArtifactEnvelope<SelfRedTeamReport>;
  opusCritiqueArtifact?: ArtifactEnvelope<OpusSpecCritique>;
  approvedSpecArtifact: ArtifactEnvelope<ChapterSpec>;
}> {
  const { packetArtifact, blueprintArtifacts, smoke } = params;
  const storyCore = blueprintArtifacts.compiledBlueprint.data;
  const genreContract = blueprintArtifacts.genreContract.data;

  const chN = packetArtifact.data.chapterNumber;

  let specArtifact: ArtifactEnvelope<ChapterSpec>;
  if (smoke) {
    specArtifact = createArtifact<ChapterSpec>({
      artifactType: "chapter-spec",
      blueprintHash: packetArtifact.blueprintHash,
      blueprintVersion: packetArtifact.blueprintVersion,
      chapterNumber: packetArtifact.chapterNumber,
      data: createSmokeSpec(packetArtifact.data),
    });
  } else {
    console.error(`[ch${chN}] Spec: generating...`);
    const specRequest = buildSpecGenerationRequest({
      storyCore,
      genreContract,
      packet: packetArtifact.data,
    });
    const result = await generateStructuredOutput<ChapterSpec>({
      stage: config.stageProfiles.specGeneration,
      ...specRequest,
    });

    specArtifact = createArtifact<ChapterSpec>({
      artifactType: "chapter-spec",
      blueprintHash: packetArtifact.blueprintHash,
      blueprintVersion: packetArtifact.blueprintVersion,
      chapterNumber: packetArtifact.chapterNumber,
      data: result.value,
      usage: result.usage,
    });
  }
  await writeJson(chapterArtifactPath(packetArtifact.data.chapterNumber, "spec"), specArtifact);

  let selfRedTeamArtifact: ArtifactEnvelope<SelfRedTeamReport>;
  let opusCritiqueArtifact: ArtifactEnvelope<OpusSpecCritique> | undefined;

  if (smoke) {
    selfRedTeamArtifact = createArtifact<SelfRedTeamReport>({
      artifactType: "self-red-team-report",
      blueprintHash: packetArtifact.blueprintHash,
      blueprintVersion: packetArtifact.blueprintVersion,
      chapterNumber: packetArtifact.chapterNumber,
      data: createSmokeSelfRedTeam(specArtifact.data),
    });
    await writeJson(
      chapterArtifactPath(packetArtifact.data.chapterNumber, "self-red-team-report"),
      selfRedTeamArtifact,
    );

    const critiqueDecision = shouldRunOpusCritique(
      packetArtifact,
      selfRedTeamArtifact.data,
      params.skipSpecCritique,
    );
    if (critiqueDecision.run) {
      opusCritiqueArtifact = createArtifact<OpusSpecCritique>({
        artifactType: "opus-spec-critique",
        blueprintHash: packetArtifact.blueprintHash,
        blueprintVersion: packetArtifact.blueprintVersion,
        chapterNumber: packetArtifact.chapterNumber,
        data: {
          majorRisks: [],
          continuityThreats: [],
          proseThreats: [],
          suggestedFixes: [],
        },
      });
      await writeJson(
        chapterArtifactPath(packetArtifact.data.chapterNumber, "spec-critique"),
        opusCritiqueArtifact,
      );
    }
  } else {
    const redTeamRequest = {
      stage: config.stageProfiles.selfRedTeam,
      ...buildSelfRedTeamRequest({
        packet: packetArtifact.data,
        spec: specArtifact.data,
      }),
    };

    const critiqueRequest = {
      stage: config.stageProfiles.specCritique,
      ...buildSpecCritiqueRequest({
        genreContract,
        packet: packetArtifact.data,
        spec: specArtifact.data,
      }),
    };

    const alwaysCritique = config.qualitySettings.alwaysRunSpecCritique
      && !params.skipSpecCritique;

    if (alwaysCritique) {
      console.error(`[ch${chN}] Spec: red-team + Opus critique (parallel)...`);
      // Both promises are wrapped so neither rejection cancels the other's result.
      const redTeamPromise = generateStructuredOutput<SelfRedTeamReport>(redTeamRequest)
        .then((r) => ({ ok: true as const, value: r.value, usage: r.usage }))
        .catch((error: unknown) => ({ ok: false as const, error }));
      const critiquePromise = generateAnthropicText(critiqueRequest)
        .then((r) => ({ ok: true as const, value: r.value, usage: r.usage }))
        .catch((error: unknown) => ({ ok: false as const, error }));

      const [redTeamOutcome, critiqueOutcome] = await Promise.all([redTeamPromise, critiquePromise]);

      // Persist critique artifact first — even if red-team failed, the Anthropic
      // tokens were already spent and the artifact is useful for cost tracking.
      if (critiqueOutcome.ok) {
        opusCritiqueArtifact = createArtifact<OpusSpecCritique>({
          artifactType: "opus-spec-critique",
          blueprintHash: packetArtifact.blueprintHash,
          blueprintVersion: packetArtifact.blueprintVersion,
          chapterNumber: packetArtifact.chapterNumber,
          data: parseAnthropicJson<OpusSpecCritique>(critiqueOutcome.value),
          usage: critiqueOutcome.usage,
        });
        await writeJson(
          chapterArtifactPath(packetArtifact.data.chapterNumber, "spec-critique"),
          opusCritiqueArtifact,
        );
      }

      if (!redTeamOutcome.ok) throw redTeamOutcome.error;

      selfRedTeamArtifact = createArtifact<SelfRedTeamReport>({
        artifactType: "self-red-team-report",
        blueprintHash: packetArtifact.blueprintHash,
        blueprintVersion: packetArtifact.blueprintVersion,
        chapterNumber: packetArtifact.chapterNumber,
        data: redTeamOutcome.value,
        usage: redTeamOutcome.usage,
      });
      await writeJson(
        chapterArtifactPath(packetArtifact.data.chapterNumber, "self-red-team-report"),
        selfRedTeamArtifact,
      );

      if (!critiqueOutcome.ok) {
        const err = critiqueOutcome.error;
        const required = packetArtifact.data.riskLevel === "high"
          || redTeamOutcome.value.needsOpusEscalation;
        const isProviderFailure = err instanceof BlockedPipelineError
          && err.code === "BLOCKED_PROVIDER_FAILURE";
        if (required || !isProviderFailure) throw err;
        console.error(`[spec-critique] Opus unavailable, continuing without critique: ${(err as Error).message}`);
      }
    } else {
      console.error(`[ch${chN}] Spec: red-teaming...`);
      const redTeamResult = await generateStructuredOutput<SelfRedTeamReport>(redTeamRequest);
      selfRedTeamArtifact = createArtifact<SelfRedTeamReport>({
        artifactType: "self-red-team-report",
        blueprintHash: packetArtifact.blueprintHash,
        blueprintVersion: packetArtifact.blueprintVersion,
        chapterNumber: packetArtifact.chapterNumber,
        data: redTeamResult.value,
        usage: redTeamResult.usage,
      });
      await writeJson(
        chapterArtifactPath(packetArtifact.data.chapterNumber, "self-red-team-report"),
        selfRedTeamArtifact,
      );

      const critiqueDecision = shouldRunOpusCritique(
        packetArtifact,
        selfRedTeamArtifact.data,
        params.skipSpecCritique,
      );
      if (critiqueDecision.run) {
        console.error(`[ch${chN}] Spec: Opus critique...`);
        try {
          const critiqueResult = await generateAnthropicText(critiqueRequest);
          opusCritiqueArtifact = createArtifact<OpusSpecCritique>({
            artifactType: "opus-spec-critique",
            blueprintHash: packetArtifact.blueprintHash,
            blueprintVersion: packetArtifact.blueprintVersion,
            chapterNumber: packetArtifact.chapterNumber,
            data: parseAnthropicJson<OpusSpecCritique>(critiqueResult.value),
            usage: critiqueResult.usage,
          });
        } catch (error) {
          const isProviderFailure = error instanceof BlockedPipelineError
            && error.code === "BLOCKED_PROVIDER_FAILURE";
          if (critiqueDecision.required || !isProviderFailure) throw error;
          console.error(`[spec-critique] Opus unavailable, continuing without critique: ${(error as Error).message}`);
        }
        if (opusCritiqueArtifact) {
          await writeJson(
            chapterArtifactPath(packetArtifact.data.chapterNumber, "spec-critique"),
            opusCritiqueArtifact,
          );
        }
      }
    }
  }

  let approvedSpecArtifact: ArtifactEnvelope<ChapterSpec>;
  if (smoke) {
    approvedSpecArtifact = createArtifact<ChapterSpec>({
      artifactType: "approved-chapter-spec",
      blueprintHash: packetArtifact.blueprintHash,
      blueprintVersion: packetArtifact.blueprintVersion,
      chapterNumber: packetArtifact.chapterNumber,
      data: specArtifact.data,
    });
  } else {
    console.error(`[ch${chN}] Spec: approving...`);
    const revisionRequest = buildSpecRevisionRequest({
      packet: packetArtifact.data,
      spec: specArtifact.data,
      selfRedTeam: selfRedTeamArtifact.data,
      opusCritique: opusCritiqueArtifact?.data,
    });
    const result = await generateStructuredOutput<ChapterSpec>({
      stage: config.stageProfiles.specRevision,
      ...revisionRequest,
    });

    approvedSpecArtifact = createArtifact<ChapterSpec>({
      artifactType: "approved-chapter-spec",
      blueprintHash: packetArtifact.blueprintHash,
      blueprintVersion: packetArtifact.blueprintVersion,
      chapterNumber: packetArtifact.chapterNumber,
      data: alignMandatoryBeatCoverage(packetArtifact.data.mandatoryBeats, result.value),
      usage: result.usage,
    });
  }

  assertMandatoryBeatCoverage(packetArtifact.data, approvedSpecArtifact.data);
  await writeJson(
    chapterArtifactPath(packetArtifact.data.chapterNumber, "approved-spec"),
    approvedSpecArtifact,
  );

  return {
    specArtifact,
    selfRedTeamArtifact,
    opusCritiqueArtifact,
    approvedSpecArtifact,
  };
}
