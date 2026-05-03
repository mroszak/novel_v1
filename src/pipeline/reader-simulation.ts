import { generateStructuredOutput } from "../api/openai.js";
import { config } from "../config.js";
import type {
  ArtifactEnvelope,
  BlueprintCompilationArtifacts,
  ChapterPacket,
  ReaderFlaggedPassage,
  ReaderPersonaId,
  ReaderPersonaReview,
  ReaderSimulation,
  SelectedChapter,
} from "../types/index.js";
import { READER_PERSONA_IDS } from "../types/index.js";
import { compactJson, writeJson } from "../utils/index.js";
import { chapterArtifactPath, createArtifact } from "./stage-utils.js";

const readerSimulationSchema = {
  type: "object",
  properties: {
    personas: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          persona: {
            type: "string",
            enum: ["airport", "book-club", "genre-obsessive"],
          },
          skimRisk: { type: "number", minimum: 0, maximum: 100 },
          confusionRisk: { type: "number", minimum: 0, maximum: 100 },
          turnPull: { type: "number", minimum: 0, maximum: 100 },
          shareScore: { type: "number", minimum: 0, maximum: 100 },
          notes: { type: "string", minLength: 1 },
        },
        required: ["persona", "skimRisk", "confusionRisk", "turnPull", "shareScore", "notes"],
        additionalProperties: false,
      },
    },
    flaggedPassages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          excerpt: { type: "string", minLength: 1 },
          reason: { type: "string", minLength: 1 },
          persona: {
            type: "string",
            enum: ["airport", "book-club", "genre-obsessive"],
          },
        },
        required: ["excerpt", "reason", "persona"],
        additionalProperties: false,
      },
    },
    summary: { type: "string", minLength: 1 },
  },
  required: ["personas", "flaggedPassages", "summary"],
  additionalProperties: false,
} as const;

interface RawReaderSimulation {
  personas: Array<ReaderPersonaReview>;
  flaggedPassages: ReaderFlaggedPassage[];
  summary: string;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(2));
}

function buildSmokeReaderSimulation(selected: SelectedChapter): ReaderSimulation {
  const personas: ReaderPersonaReview[] = READER_PERSONA_IDS.map((id) => ({
    persona: id,
    skimRisk: 30,
    confusionRisk: 25,
    turnPull: id === "airport" ? 78 : id === "book-club" ? 74 : 80,
    shareScore: id === "book-club" ? 76 : 72,
    notes: `Smoke ${id} review: pacing and pressure feel intentional, ending earns the next page turn.`,
  }));
  const firstParagraph = selected.prose.split(/\n\n+/)[1]?.trim().slice(0, 220)
    ?? selected.prose.slice(0, 220);
  return {
    personas,
    flaggedPassages: [
      {
        excerpt: firstParagraph,
        reason: "Smoke flag: opening could front-load specificity to win skimmer attention.",
        persona: "airport",
      },
    ],
    averageTurnPull: average(personas.map((p) => p.turnPull)),
    averageShareScore: average(personas.map((p) => p.shareScore)),
    summary: "Smoke reader simulation: chapter holds momentum across all three personas with one airport-skim flag.",
  };
}

export async function runReaderSimulation(params: {
  packetArtifact: ArtifactEnvelope<ChapterPacket>;
  selectedArtifact: ArtifactEnvelope<SelectedChapter>;
  blueprintArtifacts: BlueprintCompilationArtifacts;
  smoke: boolean;
}): Promise<ArtifactEnvelope<ReaderSimulation>> {
  const { packetArtifact, selectedArtifact, blueprintArtifacts, smoke } = params;

  let simulation: ReaderSimulation;
  let usage: ArtifactEnvelope<ReaderSimulation>["usage"];

  if (smoke) {
    simulation = buildSmokeReaderSimulation(selectedArtifact.data);
  } else {
    const storyCore = blueprintArtifacts.compiledBlueprint.data;
    const result = await generateStructuredOutput<RawReaderSimulation>({
      stage: config.stageProfiles.readerSimulation,
      instructions: [
        "You are a three-persona reader-simulation panel for a chapter-by-chapter novel engine.",
        "Score each persona 0-100 on skimRisk (where the reader wanted to skip), confusionRisk (where they lost track), turnPull (would they turn the page right now?), shareScore (would they text a friend about this?).",
        "Personas:",
        "- airport: wants forward motion, clarity, efficient prose.",
        "- book-club: wants emotional resonance, character truth, conversation-worthy themes.",
        "- genre-obsessive: wants tradecraft accuracy, trope-aware execution, signature moves.",
        "Return 3 to 6 specific flaggedPassages (verbatim 1-3 sentence excerpts) only when there is real reader friction.",
        "Be honest. The literary judge has already cleared craft; your job is reader compulsion.",
      ].join("\n"),
      prompt: [
        `Story promise: ${compactJson(storyCore.storyPromise)}`,
        `Market positioning: ${compactJson(storyCore.marketPositioning)}`,
        `Genre contract: ${compactJson(blueprintArtifacts.genreContract.data)}`,
        `Chapter purpose: ${packetArtifact.data.purpose}`,
        `Ending hook target: ${packetArtifact.data.endingHookTarget}`,
        `Final chapter prose:\n${selectedArtifact.data.prose}`,
      ].join("\n\n"),
      schemaName: "reader_simulation",
      schema: readerSimulationSchema,
    });
    const personas = result.value.personas;
    simulation = {
      personas,
      flaggedPassages: result.value.flaggedPassages,
      averageTurnPull: average(personas.map((p) => p.turnPull)),
      averageShareScore: average(personas.map((p) => p.shareScore)),
      summary: result.value.summary,
    };
    usage = result.usage;
  }

  const artifact = createArtifact<ReaderSimulation>({
    artifactType: "reader-simulation",
    blueprintHash: packetArtifact.blueprintHash,
    blueprintVersion: packetArtifact.blueprintVersion,
    chapterNumber: packetArtifact.chapterNumber,
    qualityProfile: packetArtifact.qualityProfile,
    data: simulation,
    usage,
  });
  await writeJson(chapterArtifactPath(packetArtifact.data.chapterNumber, "reader-sim"), artifact);
  return artifact;
}
