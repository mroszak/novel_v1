import { generateText as generateAnthropicText } from "../api/anthropic.js";
import { generateStructuredOutput } from "../api/openai.js";
import { config } from "../config.js";
import type {
  ArtifactEnvelope,
  BlueprintCompilationArtifacts,
  ChapterPacket,
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

const chapterSpecSchema = {
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

function beatCovered(packetBeat: string, spec: ChapterSpec): boolean {
  const target = normalizeLookupKey(packetBeat);
  return spec.mandatoryBeatCoverage.some((item) => {
    const beatText = normalizeLookupKey(item.beat);
    const planText = normalizeLookupKey(item.deliveryPlan);
    return beatText.includes(target) || target.includes(beatText) || planText.includes(target);
  });
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
  const preferred = config.qualityProfiles[packetArtifact.data.qualityProfile].alwaysRunSpecCritique;
  return { run: required || preferred, required };
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
  return {
    instructions: [
      "You are the planning model for a chapter-by-chapter novel engine.",
      "Create a machine-usable chapter spec for one chapter only.",
      "Honor reveal control, mandatory beats, active cast, target word band, ending hook, and continuity notes.",
      "Keep the plan genre-adaptive and specific enough for a full-chapter Opus draft.",
      "For each scene in scenePlan, include emotionalArc (the POV character's emotional trajectory through the scene), sensoryAnchor (the dominant sensory environment), and dialogueStrategy (how dialogue serves the scene).",
      "In proseGuidance, include 2-4 concrete prose targets: dominant sensory channel for the chapter, a signature metaphor or image family, and the primary dialogue tactic for the POV character.",
      "Style rules from the author's blueprint take priority over any general guidance.",
    ].join("\n"),
    prompt: [
      `Story promise: ${compactJson(params.storyCore.storyPromise)}`,
      `Market positioning: ${compactJson(params.storyCore.marketPositioning)}`,
      `Genre contract: ${compactJson(params.genreContract)}`,
      `Section digests: ${compactJson(params.storyCore.sectionDigests)}`,
      `Style rules:\n${params.storyCore.styleRules.join("\n") || "None"}`,
      `Anti-patterns:\n${params.storyCore.antiPatterns.join("\n") || "None"}`,
      `Motif bank: ${params.storyCore.motifBank.join(" | ") || "None"}`,
      `Chapter packet: ${compactJson(promptPacket)}`,
    ].join("\n\n"),
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
      qualityProfile: packetArtifact.qualityProfile,
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
      qualityProfile: packetArtifact.qualityProfile,
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
      qualityProfile: packetArtifact.qualityProfile,
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
        qualityProfile: packetArtifact.qualityProfile,
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

    const alwaysCritique = config.qualityProfiles[packetArtifact.data.qualityProfile].alwaysRunSpecCritique
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
          qualityProfile: packetArtifact.qualityProfile,
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
        qualityProfile: packetArtifact.qualityProfile,
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
        qualityProfile: packetArtifact.qualityProfile,
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
            qualityProfile: packetArtifact.qualityProfile,
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
      qualityProfile: packetArtifact.qualityProfile,
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
      qualityProfile: packetArtifact.qualityProfile,
      data: result.value,
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
