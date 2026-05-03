import { generateStructuredOutput } from "../api/openai.js";
import { config } from "../config.js";
import type {
  ArtifactEnvelope,
  BlueprintCompilationArtifacts,
  ChapterDelta,
  ChapterPacket,
  GenreContract,
  RollingMemory,
  SelectedChapter,
} from "../types/index.js";
import { buildDeltaPacketView } from "./prompt-packet-views.js";
import { createSmokeDelta } from "./smoke-helpers.js";
import { chapterArtifactPath, createArtifact } from "./stage-utils.js";
import { compactJson, writeJson } from "../utils/index.js";

const chapterDeltaSchema = {
  type: "object",
  properties: {
    entityMentions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1 },
          role: { type: "string", minLength: 1 },
          introducedThisChapter: { type: "boolean" },
          stateChanges: { type: "array", items: { type: "string" } },
        },
        required: ["name", "role", "introducedThisChapter", "stateChanges"],
        additionalProperties: false,
      },
    },
    sceneLedgerDelta: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sceneNumber: { type: "integer", minimum: 1 },
          location: { type: "string", minLength: 1 },
          summary: { type: "string", minLength: 1 },
          causalTurn: { type: "string", minLength: 1 },
        },
        required: ["sceneNumber", "location", "summary", "causalTurn"],
        additionalProperties: false,
      },
    },
    knowledgeChanges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          holder: { type: "string", minLength: 1 },
          gainedKnowledge: { type: "string", minLength: 1 },
          suspects: { type: "array", items: { type: "string" } },
          hides: { type: "array", items: { type: "string" } },
          source: { type: "string", minLength: 1 },
        },
        required: ["holder", "gainedKnowledge", "suspects", "hides", "source"],
        additionalProperties: false,
      },
    },
    irreversibleChanges: {
      type: "array",
      items: { type: "string" },
    },
    plotThreadProgression: {
      type: "array",
      items: {
        type: "object",
        properties: {
          thread: { type: "string", minLength: 1 },
          previousStatus: { type: "string", minLength: 1 },
          newStatus: { type: "string", minLength: 1 },
          update: { type: "string", minLength: 1 },
          resolved: { type: "boolean" },
        },
        required: ["thread", "previousStatus", "newStatus", "update", "resolved"],
        additionalProperties: false,
      },
    },
    revealPayoffMovement: {
      type: "array",
      items: {
        type: "object",
        properties: {
          thread: { type: "string", minLength: 1 },
          movementType: {
            type: "string",
            enum: ["setup", "hint", "reveal", "payoff", "withhold"],
          },
          description: { type: "string", minLength: 1 },
          status: { type: "string", minLength: 1 },
          chapterNumber: { type: "integer", minimum: 1 },
        },
        required: ["thread", "movementType", "description", "status", "chapterNumber"],
        additionalProperties: false,
      },
    },
    activePressures: {
      type: "array",
      items: { type: "string" },
    },
    unresolvedThreads: {
      type: "array",
      items: { type: "string" },
    },
    nextChapterOpeningHandoff: { type: "string", minLength: 1 },
    activeVoiceSignals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          character: { type: "string", minLength: 1 },
          voiceNotes: { type: "array", items: { type: "string" } },
        },
        required: ["character", "voiceNotes"],
        additionalProperties: false,
      },
    },
    storySpineUpdate: { type: "string", minLength: 1 },
    characterEmotionalStates: {
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
    "entityMentions",
    "sceneLedgerDelta",
    "knowledgeChanges",
    "irreversibleChanges",
    "plotThreadProgression",
    "revealPayoffMovement",
    "activePressures",
    "unresolvedThreads",
    "nextChapterOpeningHandoff",
    "activeVoiceSignals",
    "storySpineUpdate",
    "characterEmotionalStates",
  ],
  additionalProperties: false,
} as const;

export function buildChapterDeltaRequest(params: {
  genreContract: GenreContract;
  packet: ChapterPacket;
  previousMemory: RollingMemory | null;
  selectedProse: string;
}): {
  instructions: string;
  prompt: string;
  schemaName: string;
  schema: typeof chapterDeltaSchema;
} {
  return {
    instructions: [
      "You extract the structured chapter delta for a continuity-safe novel runtime.",
      "Return only machine-readable chapter changes derived from the approved chapter.",
      "Track entities, knowledge changes, plot-thread movement, reveal/payoff movement, and the exact handoff pressure for the next chapter.",
      "When a character directly witnesses or plausibly overhears official spin, euphemistic guest-facing language, or message-control decisions before facts are confirmed, preserve that in their knowledge or suspicion state.",
      "For each active character, extract their emotional state at chapter end: current belief, current doubt, emotional register, and how far they have moved from their starting arc position.",
    ].join("\n"),
    prompt: [
      `Genre contract: ${compactJson(params.genreContract)}`,
      `Chapter packet: ${compactJson(buildDeltaPacketView(params.packet))}`,
      `Previous memory: ${compactJson(params.previousMemory)}`,
      `Selected chapter prose:\n${params.selectedProse}`,
    ].join("\n\n"),
    schemaName: "chapter_delta",
    schema: chapterDeltaSchema,
  };
}

export async function extractChapterDelta(params: {
  packetArtifact: ArtifactEnvelope<ChapterPacket>;
  selectedArtifact: ArtifactEnvelope<SelectedChapter>;
  blueprintArtifacts: BlueprintCompilationArtifacts;
  previousMemory: RollingMemory | null;
  smoke: boolean;
}): Promise<ArtifactEnvelope<ChapterDelta>> {
  const { packetArtifact, selectedArtifact, blueprintArtifacts, previousMemory, smoke } = params;

  let delta: ChapterDelta;
  let usage: ArtifactEnvelope<ChapterDelta>["usage"];

  if (smoke) {
    delta = createSmokeDelta(packetArtifact.data, selectedArtifact.data);
    usage = undefined;
  } else {
    const deltaRequest = buildChapterDeltaRequest({
      genreContract: blueprintArtifacts.genreContract.data,
      packet: packetArtifact.data,
      previousMemory,
      selectedProse: selectedArtifact.data.prose,
    });
    const result = await generateStructuredOutput<ChapterDelta>({
      stage: config.stageProfiles.chapterDelta,
      ...deltaRequest,
    });
    delta = result.value;
    usage = result.usage;
  }

  const artifact = createArtifact<ChapterDelta>({
    artifactType: "chapter-delta",
    blueprintHash: packetArtifact.blueprintHash,
    blueprintVersion: packetArtifact.blueprintVersion,
    chapterNumber: packetArtifact.chapterNumber,
    data: delta,
    usage,
  });

  await writeJson(chapterArtifactPath(packetArtifact.data.chapterNumber, "delta"), artifact);
  return artifact;
}
