import path from "node:path";

import { config } from "../config.js";
import type {
  ArtifactEnvelope,
  BlueprintCompilationArtifacts,
  ChapterPacket,
  CharacterCard,
  ContinuityActiveSlice,
  ContinuityManifest,
  HandoffMemory,
  RollingMemory,
  VoiceTarget,
} from "../types/index.js";
import { estimateTextTokens } from "../metrics/token-budget.js";
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
import { loadPersistedContinuityState, projectStateToManifest } from "./update-continuity-state.js";

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

async function loadVoiceTargetData(params: {
  blueprintHash: string;
  blueprintVersion: string;
}): Promise<VoiceTarget | null> {
  const artifact = await loadVoiceTargetIfPresent(params);
  return artifact?.data ?? null;
}

const CONTINUITY_SLICE_TOKEN_CAP = 4000;

function buildContinuityActiveSlice(params: {
  manifest: ContinuityManifest | null;
  chapterNumber: number;
  activeCastNames: string[];
  mandatoryBeats: string[];
  revealBudget: { show: string[]; hint: string[]; reveal: string[]; withhold: string[] };
  extraScopeNotes?: string[];
}): ContinuityActiveSlice | null {
  if (!params.manifest) return null;

  const activeCastKeys = new Set(params.activeCastNames.map((name) => normalizeLookupKey(name)));
  const beatHay = [
    ...params.mandatoryBeats,
    ...params.revealBudget.show,
    ...params.revealBudget.hint,
    ...params.revealBudget.reveal,
    ...params.revealBudget.withhold,
  ].join(" ").toLowerCase();

  const objectMatches = (haystack: string): boolean => {
    if (!haystack) return false;
    const lower = haystack.toLowerCase();
    if (beatHay.includes(lower) || lower.includes(beatHay.slice(0, 32))) return true;
    for (const name of activeCastKeys) {
      if (name && lower.includes(name)) return true;
    }
    return false;
  };

  const persistentObjects = params.manifest.persistentObjects.filter((obj) => {
    if (obj.lastSeenChapter > params.chapterNumber) return false;
    return objectMatches(obj.name) || objectMatches(obj.possessor) || objectMatches(obj.state);
  });

  const spatialRegistry = params.manifest.spatialRegistry.filter((space) => (
    objectMatches(space.name) || objectMatches(space.description)
  ));

  const timelineAnchors = params.manifest.timelineAnchors;

  const revealSchedule = params.manifest.revealSchedule.filter((reveal) => (
    reveal.chapter >= params.chapterNumber - 1 && reveal.chapter <= params.chapterNumber + 1
  ));

  const relationshipStates = params.manifest.relationshipStates.filter((rel) => {
    const lower = rel.pair.toLowerCase();
    for (const name of activeCastKeys) {
      if (name && lower.includes(name)) return true;
    }
    return false;
  });

  const motifStates = params.manifest.motifStates;

  const scopeNotes: string[] = [...(params.extraScopeNotes ?? [])];
  const dropped = {
    persistentObjects: params.manifest.persistentObjects.length - persistentObjects.length,
    spatialRegistry: params.manifest.spatialRegistry.length - spatialRegistry.length,
    revealSchedule: params.manifest.revealSchedule.length - revealSchedule.length,
    relationshipStates: params.manifest.relationshipStates.length - relationshipStates.length,
  };
  for (const [k, v] of Object.entries(dropped)) {
    if (v > 0) scopeNotes.push(`Filtered ${v} ${k} entries out of active scope.`);
  }

  let slice: ContinuityActiveSlice = {
    persistentObjects,
    spatialRegistry,
    timelineAnchors,
    revealSchedule,
    relationshipStates,
    motifStates,
    scopeNotes,
  };

  // Hard-capped trimming. Each pass halves the largest array (with a floor)
  // until either the slice fits under CONTINUITY_SLICE_TOKEN_CAP or every
  // array has reached its floor and we record an over-cap warning.
  const maxPasses = 8;
  let trimmed = false;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const tokens = estimateTextTokens(JSON.stringify(slice));
    if (tokens <= CONTINUITY_SLICE_TOKEN_CAP) {
      if (trimmed) {
        slice.scopeNotes = [
          ...slice.scopeNotes,
          `Trimmed slice to ~${tokens} tokens (cap ${CONTINUITY_SLICE_TOKEN_CAP}).`,
        ];
      }
      return slice;
    }
    const nextSlice = trimSliceOnce(slice);
    if (!nextSlice) break;
    slice = nextSlice;
    trimmed = true;
  }

  const finalTokens = estimateTextTokens(JSON.stringify(slice));
  slice.scopeNotes = [
    ...slice.scopeNotes,
    `Trimmed slice to ~${finalTokens} tokens (cap ${CONTINUITY_SLICE_TOKEN_CAP}; floors hit, may exceed cap).`,
  ];
  return slice;
}

function trimSliceOnce(slice: ContinuityActiveSlice): ContinuityActiveSlice | null {
  // Tail-prefer trimming: keep recent entries. Floors prevent total wipeout.
  const floors = {
    persistentObjects: 4,
    spatialRegistry: 4,
    timelineAnchors: 4,
    revealSchedule: 4,
    relationshipStates: 3,
    motifStates: 4,
  } as const;
  const candidates: Array<keyof typeof floors> = [
    "persistentObjects",
    "spatialRegistry",
    "timelineAnchors",
    "revealSchedule",
    "relationshipStates",
    "motifStates",
  ];
  let bestKey: keyof typeof floors | null = null;
  let bestLen = -1;
  for (const key of candidates) {
    const len = (slice[key] as readonly unknown[]).length;
    if (len > floors[key] && len > bestLen) {
      bestKey = key;
      bestLen = len;
    }
  }
  if (!bestKey) return null;
  const trimmedLen = Math.max(floors[bestKey], Math.floor(bestLen / 2));
  return {
    ...slice,
    [bestKey]: (slice[bestKey] as readonly unknown[]).slice(-trimmedLen),
  } as ContinuityActiveSlice;
}

export async function compileChapterPacket(params: {
  chapterNumber: number;
  blueprintArtifacts: BlueprintCompilationArtifacts;
}): Promise<ArtifactEnvelope<ChapterPacket>> {
  const { chapterNumber, blueprintArtifacts } = params;
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

  // Voice target is an advisory input loaded only when its persisted
  // metadata matches the current blueprint identity. Mismatches silently
  // drop the voice target.
  const blueprintIdentity = {
    blueprintHash: blueprintArtifacts.compiledBlueprint.blueprintHash,
    blueprintVersion: blueprintArtifacts.compiledBlueprint.blueprintVersion,
  };
  const voiceTarget = await loadVoiceTargetData(blueprintIdentity);
  const marketPromise = blueprintArtifacts.marketPromise.data;

  // Prefer the most recent persisted ContinuityState (last-seen bumps,
  // motif progression, delivered reveals, delta-applied object/notes
  // updates) over the static manifest. Soft-fail metadata validation
  // silently falls back to the manifest on mismatch.
  let activeManifest: ContinuityManifest | null = blueprintArtifacts.continuityManifest.data;
  const activeManifestNotes: string[] = [];
  if (activeManifest && chapterNumber > 1) {
    const persistedState = await loadPersistedContinuityState({
      chapterNumber: chapterNumber - 1,
      blueprintHash: blueprintArtifacts.compiledBlueprint.blueprintHash,
      blueprintVersion: blueprintArtifacts.compiledBlueprint.blueprintVersion,
    });
    if (persistedState) {
      activeManifest = projectStateToManifest(persistedState.data);
      activeManifestNotes.push(
        `Active slice derived from continuity-state-after-${chapterNumber - 1}.json (delivered reveals, last-seen bumps, motif progression applied).`,
      );
    }
  }

  const continuityActiveSlice = buildContinuityActiveSlice({
    manifest: activeManifest,
    chapterNumber,
    activeCastNames: chapter.activeCast,
    mandatoryBeats: chapter.mandatoryBeats,
    revealBudget: {
      show: chapter.show,
      hint: chapter.hint,
      reveal: chapter.reveal,
      withhold: chapter.withhold,
    },
    extraScopeNotes: activeManifestNotes,
  });
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
    marketPromise,
    continuityActiveSlice,
    authorBrief: blueprintArtifacts.authorBrief.data,
  };

  const artifact = createArtifact<ChapterPacket>({
    artifactType: "chapter-packet",
    blueprintHash: blueprintArtifacts.compiledBlueprint.blueprintHash,
    blueprintVersion: blueprintArtifacts.compiledBlueprint.blueprintVersion,
    chapterNumber,
    data: packet,
  });

  await writeJson(chapterArtifactPath(chapterNumber, "packet"), artifact);
  return artifact;
}
