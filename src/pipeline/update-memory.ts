import { generateStructuredOutput } from "../api/openai.js";
import { config } from "../config.js";
import type {
  ArtifactEnvelope,
  ChapterDelta,
  ChapterPacket,
  MemoryUpdateProposal,
  RollingMemory,
} from "../types/index.js";
import { buildRollingMemory } from "./build-rolling-memory.js";
import { createSmokeMemory } from "./smoke-helpers.js";
import { createArtifact, memoryArtifactPath } from "./stage-utils.js";
import { compactJson, writeJson } from "../utils/index.js";

export function stripMemoryPacketFields(packet: ChapterPacket): Omit<
  ChapterPacket,
  "rollingMemory" | "handoffMemory" | "compactContext" | "previousChapterExcerpt"
  | "voiceGuidance" | "pacingGuidance" | "voiceTarget" | "previousReaderSimulation"
> {
  const {
    rollingMemory: _rm, handoffMemory: _hm, compactContext: _cc,
    previousChapterExcerpt: _pe, voiceGuidance: _vg, pacingGuidance: _pg,
    voiceTarget: _vt, previousReaderSimulation: _prs,
    ...core
  } = packet;
  return core;
}

const memoryUpdateSchema = {
  type: "object",
  properties: {
    storySpine: { type: "string", minLength: 1 },
    unresolvedThreads: { type: "array", items: { type: "string" } },
    activePressures: { type: "array", items: { type: "string" } },
    knowledgeMatrix: {
      type: "array",
      items: {
        type: "object",
        properties: {
          character: { type: "string", minLength: 1 },
          knows: { type: "array", items: { type: "string" } },
          suspects: { type: "array", items: { type: "string" } },
          hides: { type: "array", items: { type: "string" } },
          mustNotKnowYet: { type: "array", items: { type: "string" } },
        },
        required: ["character", "knows", "suspects", "hides", "mustNotKnowYet"],
        additionalProperties: false,
      },
    },
    activeCharacterVoiceCards: {
      type: "array",
      items: {
        type: "object",
        properties: {
          character: { type: "string", minLength: 1 },
          activeTraits: { type: "array", items: { type: "string" } },
          stressPattern: { type: "string", minLength: 1 },
          dialogueHabits: { type: "array", items: { type: "string" } },
          tabooNotes: { type: "array", items: { type: "string" } },
          updatedFromChapter: { type: "integer", minimum: 1 },
        },
        required: [
          "character",
          "activeTraits",
          "stressPattern",
          "dialogueHabits",
          "tabooNotes",
          "updatedFromChapter",
        ],
        additionalProperties: false,
      },
    },
    nextChapterOpeningHandoff: {
      type: "object",
      properties: {
        openingSituation: { type: "string", minLength: 1 },
        physicalState: { type: "array", items: { type: "string" } },
        emotionalState: { type: "array", items: { type: "string" } },
        causalState: { type: "array", items: { type: "string" } },
        mandatoryCallbacks: { type: "array", items: { type: "string" } },
        characterStates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              character: { type: "string", minLength: 1 },
              physicalState: { type: "string", minLength: 1 },
              emotionalState: { type: "string", minLength: 1 },
            },
            required: ["character", "physicalState", "emotionalState"],
            additionalProperties: false,
          },
        },
      },
      required: [
        "openingSituation",
        "physicalState",
        "emotionalState",
        "causalState",
        "mandatoryCallbacks",
        "characterStates",
      ],
      additionalProperties: false,
    },
    compressedHistory: { type: "array", items: { type: "string" } },
    lastChapterSummary: { type: "string", minLength: 1 },
    emotionalStates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          character: { type: "string", minLength: 1 },
          currentBelief: { type: "string", minLength: 1 },
          currentDoubt: { type: "string", minLength: 1 },
          emotionalRegister: { type: "string", minLength: 1 },
          arcDistance: { type: "string", minLength: 1 },
        },
        required: [
          "character",
          "currentBelief",
          "currentDoubt",
          "emotionalRegister",
          "arcDistance",
        ],
        additionalProperties: false,
      },
    },
  },
  required: [
    "storySpine",
    "unresolvedThreads",
    "activePressures",
    "knowledgeMatrix",
    "activeCharacterVoiceCards",
    "nextChapterOpeningHandoff",
    "compressedHistory",
    "lastChapterSummary",
    "emotionalStates",
  ],
  additionalProperties: false,
} as const;

export async function updateMemory(params: {
  packetArtifact: ArtifactEnvelope<ChapterPacket>;
  deltaArtifact: ArtifactEnvelope<ChapterDelta>;
  previousMemory: RollingMemory | null;
  smoke: boolean;
}): Promise<ArtifactEnvelope<RollingMemory>> {
  const { packetArtifact, deltaArtifact, previousMemory, smoke } = params;

  let proposal: MemoryUpdateProposal;
  let usage: ArtifactEnvelope<RollingMemory>["usage"];

  if (smoke) {
    proposal = createSmokeMemory(packetArtifact.data, deltaArtifact.data, previousMemory);
    usage = undefined;
  } else {
    const result = await generateStructuredOutput<MemoryUpdateProposal>({
      stage: config.stageProfiles.memoryUpdate,
      instructions: [
        "You maintain the authoritative rolling memory for a chapter-by-chapter novel engine.",
        "Update the machine memory from the previous memory and the new chapter delta.",
        "Keep memory compact, continuity-safe, and optimized for the next chapter packet.",
        "Use one canonical entry per fact; do not preserve paraphrased duplicates or roll-up summaries when atomic facts already cover them.",
        "For storySpine, write a 2-3 sentence summary capturing the full arc progression so far — not just the latest chapter, but the cumulative story trajectory.",
        "For emotionalStates, capture each active character's current belief, doubt, emotional register, and arc distance from their starting position at chapter end.",
        "For characterStates in nextChapterOpeningHandoff, provide per-character physical and emotional state entering the next chapter.",
      ].join("\n"),
      prompt: [
        `Chapter packet: ${compactJson(stripMemoryPacketFields(packetArtifact.data))}`,
        `Previous memory: ${compactJson(previousMemory)}`,
        `Chapter delta: ${compactJson(deltaArtifact.data)}`,
      ].join("\n\n"),
      schemaName: "memory_update_proposal",
      schema: memoryUpdateSchema,
    });
    proposal = result.value;
    usage = result.usage;
  }

  const memory = buildRollingMemory({
    previousMemory,
    delta: deltaArtifact.data,
    proposal,
    chapterNumber: packetArtifact.data.chapterNumber,
  });

  const artifact = createArtifact<RollingMemory>({
    artifactType: "rolling-memory",
    blueprintHash: packetArtifact.blueprintHash,
    blueprintVersion: packetArtifact.blueprintVersion,
    chapterNumber: packetArtifact.chapterNumber,
    qualityProfile: packetArtifact.qualityProfile,
    data: memory,
    usage,
  });

  await writeJson(memoryArtifactPath(packetArtifact.data.chapterNumber), artifact);
  return artifact;
}
