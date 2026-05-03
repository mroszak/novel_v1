import path from "node:path";

import { config } from "../config.js";
import type {
  ArtifactEnvelope,
  BlueprintCompilationArtifacts,
  ChapterPacket,
  CharacterCard,
  HandoffMemory,
  QualityProfile,
  ReaderSimulation,
  RollingMemory,
  VoiceTarget,
} from "../types/index.js";
import {
  fileExists,
  normalizeLookupKey,
  readJson,
  readText,
  tailExcerpt,
  writeJson,
} from "../utils/index.js";
import { createArtifact, chapterArtifactPath } from "./stage-utils.js";
import { loadVoiceTargetIfPresent } from "../blueprint/extract-voice-fingerprint.js";

function resolveCharacter(activeName: string, characters: CharacterCard[]): CharacterCard {
  const target = normalizeLookupKey(activeName);
  const character = characters.find((entry) => normalizeLookupKey(entry.name) === target);
  if (!character) {
    throw new Error(`Active Cast references unknown character: ${activeName}`);
  }

  return character;
}

const DIALOGUE_PATTERN = /\b(?:speak|dialogue|say|language|ask|interrupt|deflect|avoid|tell|answer|voice|talk|word|phrase|sentence)\b/i;

function filterDialogueHabits(voiceNotes: string[]): string[] {
  const habits = voiceNotes.filter((note) => DIALOGUE_PATTERN.test(note));
  return habits.length > 0 ? habits : voiceNotes.slice(0, 1);
}

function buildInitialHandoff(compiledBlueprint: BlueprintCompilationArtifacts["compiledBlueprint"]["data"]): HandoffMemory {
  return {
    openingSituation: "Open inside the destabilizing premise without warm-up exposition.",
    physicalState: ["The opening chapter begins in active motion."],
    emotionalState: [compiledBlueprint.storyPromise.readerPromise || "Pressure is already alive on the page."],
    causalState: [compiledBlueprint.storyPromise.storyPromise || compiledBlueprint.storyPromise.corePremise],
    mandatoryCallbacks: [],
    characterStates: [],
  };
}

function buildInitialMemory(compiledBlueprint: BlueprintCompilationArtifacts["compiledBlueprint"]["data"]): RollingMemory {
  return {
    storySpine: compiledBlueprint.storyPromise.storyPromise || compiledBlueprint.storyPromise.corePremise,
    unresolvedThreads: compiledBlueprint.chapterOutline
      .flatMap((chapter) => chapter.callbackObligations)
      .slice(0, config.defaults.olderHistoryEntries),
    activePressures: [
      compiledBlueprint.storyPromise.readerPromise,
      compiledBlueprint.storyPromise.endingPromise,
    ].filter(Boolean),
    knowledgeMatrix: compiledBlueprint.characters.map((character) => ({
      character: character.name,
      knows: [],
      suspects: [],
      hides: [],
      mustNotKnowYet: character.knowledgeBoundary ? [character.knowledgeBoundary] : [],
    })),
    activeCharacterVoiceCards: compiledBlueprint.characters.map((character) => ({
      character: character.name,
      activeTraits: character.voiceNotes.slice(0, 3),
      stressPattern: character.contradiction || character.fear || "Pressure increases through consequence.",
      dialogueHabits: filterDialogueHabits(character.voiceNotes),
      tabooNotes: character.knowledgeBoundary ? [character.knowledgeBoundary] : [],
      updatedFromChapter: 0,
    })),
    revealPayoffLedger: [],
    nextChapterOpeningHandoff: buildInitialHandoff(compiledBlueprint),
    compressedHistory: [],
    lastChapterSummary: "No prior chapter.",
    emotionalStates: [],
  };
}

async function loadPreviousMemoryArtifact(
  chapterNumber: number,
): Promise<ArtifactEnvelope<RollingMemory> | null> {
  if (chapterNumber <= 1) {
    return null;
  }

  const memoryPath = path.join(config.paths.memoryArtifacts, `after-chapter-${chapterNumber - 1}.json`);
  if (!(await fileExists(memoryPath))) {
    return null;
  }

  return readJson<ArtifactEnvelope<RollingMemory>>(memoryPath);
}

async function loadPreviousChapterFull(chapterNumber: number): Promise<string | null> {
  if (chapterNumber <= 1) {
    return null;
  }

  const previousChapterPath = path.join(config.paths.chapters, `chapter-${chapterNumber - 1}.md`);
  if (!(await fileExists(previousChapterPath))) {
    return null;
  }

  return readText(previousChapterPath);
}

async function loadPreviousReaderSimulationData(params: {
  chapterNumber: number;
  blueprintHash: string;
  blueprintVersion: string;
  qualityProfile: QualityProfile;
}): Promise<ReaderSimulation | null> {
  if (params.chapterNumber <= 1) {
    return null;
  }
  const previousReaderSimPath = chapterArtifactPath(params.chapterNumber - 1, "reader-sim");
  if (!(await fileExists(previousReaderSimPath))) {
    return null;
  }
  let artifact: ArtifactEnvelope<ReaderSimulation>;
  try {
    artifact = await readJson<ArtifactEnvelope<ReaderSimulation>>(previousReaderSimPath);
  } catch {
    return null;
  }

  // Soft-fail metadata validation. The previous chapter's reader-sim is an
  // advisory input; a mismatch (different blueprint, version, profile, or
  // chapter number) silently drops it instead of corrupting the next packet.
  if (artifact.schemaVersion !== config.artifactSchemaVersion) return null;
  if (artifact.artifactType !== "reader-simulation") return null;
  if (artifact.blueprintHash !== params.blueprintHash) return null;
  if (artifact.blueprintVersion !== params.blueprintVersion) return null;
  if (artifact.qualityProfile !== params.qualityProfile) return null;
  if (artifact.chapterNumber !== params.chapterNumber - 1) return null;
  return artifact.data;
}

async function loadVoiceTargetData(params: {
  blueprintHash: string;
  blueprintVersion: string;
}): Promise<VoiceTarget | null> {
  const artifact = await loadVoiceTargetIfPresent(params);
  return artifact?.data ?? null;
}

export async function compileChapterPacket(params: {
  chapterNumber: number;
  qualityProfile: QualityProfile;
  blueprintArtifacts: BlueprintCompilationArtifacts;
}): Promise<ArtifactEnvelope<ChapterPacket>> {
  const { chapterNumber, qualityProfile, blueprintArtifacts } = params;
  const compiledBlueprint = blueprintArtifacts.compiledBlueprint.data;
  const genreContract = blueprintArtifacts.genreContract.data;
  const chapterFunctions = blueprintArtifacts.chapterFunctions.data;

  const chapter = compiledBlueprint.chapterOutline.find((entry) => entry.chapterNumber === chapterNumber);
  if (!chapter) {
    throw new Error(`Chapter ${chapterNumber} is not defined in STORY_BLUEPRINT.md.`);
  }

  const chapterFunction = chapterFunctions.chapterProfiles.find(
    (entry) => entry.chapterNumber === chapterNumber,
  )?.profile;
  if (!chapterFunction) {
    throw new Error(`No chapter function profile found for chapter ${chapterNumber}.`);
  }

  const previousMemoryArtifact = await loadPreviousMemoryArtifact(chapterNumber);
  if (chapterNumber > 1 && !previousMemoryArtifact) {
    throw new Error(
      `Missing rolling memory for chapter ${chapterNumber - 1}. Generate the previous chapter successfully before continuing.`,
    );
  }

  const previousMemory = previousMemoryArtifact?.data ?? buildInitialMemory(compiledBlueprint);
  const previousChapterFull = await loadPreviousChapterFull(chapterNumber);

  // Phase 1 advisory inputs (voice target, previous reader-sim) are loaded
  // only on the `max` quality profile and only when their persisted metadata
  // matches the current blueprint identity. This keeps `standard` and `rerun`
  // profiles behaviorally identical to the pre-Phase-1 packet shape.
  const phase1Enabled = qualityProfile === "max";
  const blueprintIdentity = {
    blueprintHash: blueprintArtifacts.compiledBlueprint.blueprintHash,
    blueprintVersion: blueprintArtifacts.compiledBlueprint.blueprintVersion,
  };
  const voiceTarget = phase1Enabled
    ? await loadVoiceTargetData(blueprintIdentity)
    : null;
  const previousReaderSimulation = phase1Enabled
    ? await loadPreviousReaderSimulationData({
      chapterNumber,
      blueprintHash: blueprintIdentity.blueprintHash,
      blueprintVersion: blueprintIdentity.blueprintVersion,
      qualityProfile,
    })
    : null;
  const targetWordBand = {
    min: Math.max(1500, chapter.targetWordCount - config.defaults.chapterWordBandLeeway),
    target: chapter.targetWordCount,
    max: chapter.targetWordCount + config.defaults.chapterWordBandLeeway,
  };

  const handoffMemory = previousMemory.nextChapterOpeningHandoff;
  const compactContext = {
    previousChapterFull,
    olderHistory: [
      ...previousMemory.compressedHistory,
      previousMemory.lastChapterSummary,
    ].filter(Boolean).slice(-config.defaults.olderHistoryEntries),
    revealLedger: previousMemory.revealPayoffLedger
      .slice(-config.defaults.revealLedgerEntries)
      .map((entry) => `${entry.thread}: ${entry.status}`),
    knowledgeWarnings: previousMemory.knowledgeMatrix
      .flatMap((entry) => entry.mustNotKnowYet.map((warning) => `${entry.character}: ${warning}`))
      .slice(0, config.defaults.knowledgeWarningEntries),
  };

  const packet: ChapterPacket = {
    chapterNumber,
    title: chapter.title,
    qualityProfile,
    riskLevel: chapterFunction.riskLevel,
    purpose: chapter.chapterGoal,
    chapterFunction,
    openingHandoff: [
      handoffMemory.openingSituation,
      ...handoffMemory.physicalState,
      ...handoffMemory.emotionalState,
      ...handoffMemory.causalState,
    ].join(" "),
    previousChapterExcerpt: previousChapterFull
      ? tailExcerpt(previousChapterFull, config.defaults.previousChapterExcerptWords)
      : null,
    activeCast: chapter.activeCast.map((name) => resolveCharacter(name, compiledBlueprint.characters)),
    mandatoryBeats: chapter.mandatoryBeats,
    revealBudget: {
      show: chapter.show,
      hint: chapter.hint,
      reveal: chapter.reveal,
      withhold: chapter.withhold,
    },
    callbackObligations: chapter.callbackObligations,
    targetWordBand,
    endingHookTarget: chapter.endingHook,
    voiceGuidance: [
      ...compiledBlueprint.styleRules,
      ...chapter.activeCast.flatMap((name) => {
        const character = resolveCharacter(name, compiledBlueprint.characters);
        return character.voiceNotes.map((note) => `${character.name}: ${note}`);
      }),
    ],
    pacingGuidance: [
      chapterFunction.pacingDirective,
      `Pacing curve: ${genreContract.controls.pacingCurve}`,
      `Scene density: ${genreContract.controls.sceneDensity}`,
      `Reveal cadence: ${genreContract.controls.revealCadence}`,
      `Hook style: ${genreContract.controls.hookStyle}`,
      `Ending mode: ${genreContract.controls.endingMode}`,
    ],
    continuityNotes: [
      ...compiledBlueprint.canonLaw.slice(0, 6),
      ...handoffMemory.mandatoryCallbacks.slice(0, 6),
      ...previousMemory.unresolvedThreads.slice(0, 6),
      `Knowledge boundaries: ${compiledBlueprint.sectionDigests["Knowledge Boundaries and Reveal Timing"] ?? "Not specified"}`,
      `Act spine: ${compiledBlueprint.sectionDigests["Act Spine and Chapter-by-Chapter Obligations"] ?? "Not specified"}`,
    ],
    chapterNotes: chapter.notes,
    rollingMemory: previousMemory,
    handoffMemory,
    compactContext,
    voiceTarget,
    previousReaderSimulation,
  };

  const artifact = createArtifact<ChapterPacket>({
    artifactType: "chapter-packet",
    blueprintHash: blueprintArtifacts.compiledBlueprint.blueprintHash,
    blueprintVersion: blueprintArtifacts.compiledBlueprint.blueprintVersion,
    chapterNumber,
    qualityProfile,
    data: packet,
  });

  await writeJson(chapterArtifactPath(chapterNumber, "packet"), artifact);
  return artifact;
}
