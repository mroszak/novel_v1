import { compactListToTokenBudget, compactTextToTokenBudget } from "../metrics/token-budget.js";
import type { ChapterPacket, CharacterCard, RollingMemory } from "../types/index.js";
import { normalizeLookupKey } from "../utils/index.js";

const SPEC_STORY_SPINE_TOKENS = 240;
const SPEC_LAST_SUMMARY_TOKENS = 160;
const SPEC_COMPRESSED_HISTORY_TOKENS = 320;
const SPEC_UNRESOLVED_THREADS_TOKENS = 420;
const SPEC_ACTIVE_PRESSURES_TOKENS = 320;
const SPEC_REVEAL_LEDGER_TOKENS = 180;
const SPEC_KNOWLEDGE_WARNINGS_TOKENS = 220;
const SPEC_CHARACTER_ARCS_TOKENS = 420;

export interface PromptCharacterView {
  name: string;
  role: string;
  desire: string;
  fear: string;
  contradiction: string;
  privateTruth: string;
  knowledgeBoundary: string;
}

export interface SpecStoryStateView {
  storySpine: string;
  lastChapterSummary: string;
  compressedHistory: string[];
  unresolvedThreads: string[];
  activePressures: string[];
  revealLedger: string[];
  knowledgeWarnings: string[];
  activeCharacterArcs: string[];
}

export interface SpecPacketView {
  chapterNumber: number;
  title: string;
  qualityProfile: ChapterPacket["qualityProfile"];
  riskLevel: ChapterPacket["riskLevel"];
  purpose: string;
  chapterFunction: ChapterPacket["chapterFunction"];
  openingHandoff: string;
  activeCast: PromptCharacterView[];
  mandatoryBeats: string[];
  revealBudget: ChapterPacket["revealBudget"];
  callbackObligations: string[];
  targetWordBand: ChapterPacket["targetWordBand"];
  endingHookTarget: string;
  continuityNotes: string[];
  chapterNotes: string[];
  storyState: SpecStoryStateView;
}

export interface DeltaPacketView {
  chapterNumber: number;
  title: string;
  qualityProfile: ChapterPacket["qualityProfile"];
  riskLevel: ChapterPacket["riskLevel"];
  purpose: string;
  chapterFunction: ChapterPacket["chapterFunction"];
  openingHandoff: string;
  activeCast: PromptCharacterView[];
  mandatoryBeats: string[];
  revealBudget: ChapterPacket["revealBudget"];
  callbackObligations: string[];
  targetWordBand: ChapterPacket["targetWordBand"];
  endingHookTarget: string;
  continuityNotes: string[];
  chapterNotes: string[];
}

function compactRecentList(items: string[], maxTokens: number): string[] {
  return compactListToTokenBudget([...items].reverse(), maxTokens).reverse();
}

function buildPromptCharacterView(character: CharacterCard): PromptCharacterView {
  return {
    name: character.name,
    role: character.role,
    desire: character.desire,
    fear: character.fear,
    contradiction: character.contradiction,
    privateTruth: character.privateTruth,
    knowledgeBoundary: character.knowledgeBoundary,
  };
}

function buildActiveCharacterArcLines(packet: ChapterPacket, memory: RollingMemory | null): string[] {
  if (!memory) {
    return [];
  }

  const activeCastNames = new Set(packet.activeCast.map((character) => normalizeLookupKey(character.name)));
  return memory.emotionalStates
    .filter((state) => activeCastNames.has(normalizeLookupKey(state.character)))
    .map((state) => (
      `${state.character}: belief=${state.currentBelief}; `
      + `doubt=${state.currentDoubt}; `
      + `register=${state.emotionalRegister}; `
      + `arcDistance=${state.arcDistance}`
    ));
}

function buildSpecStoryStateView(packet: ChapterPacket): SpecStoryStateView {
  const memory = packet.rollingMemory;
  const compressedHistory = memory?.compressedHistory.length
    ? memory.compressedHistory
    : packet.compactContext.olderHistory;

  return {
    storySpine: compactTextToTokenBudget(
      memory?.storySpine ?? "No prior story spine.",
      SPEC_STORY_SPINE_TOKENS,
    ),
    lastChapterSummary: compactTextToTokenBudget(
      memory?.lastChapterSummary ?? "No prior chapter summary.",
      SPEC_LAST_SUMMARY_TOKENS,
    ),
    compressedHistory: compactRecentList(compressedHistory, SPEC_COMPRESSED_HISTORY_TOKENS),
    unresolvedThreads: compactRecentList(
      memory?.unresolvedThreads ?? [],
      SPEC_UNRESOLVED_THREADS_TOKENS,
    ),
    activePressures: compactRecentList(
      memory?.activePressures ?? [],
      SPEC_ACTIVE_PRESSURES_TOKENS,
    ),
    revealLedger: compactRecentList(
      packet.compactContext.revealLedger,
      SPEC_REVEAL_LEDGER_TOKENS,
    ),
    knowledgeWarnings: compactRecentList(
      packet.compactContext.knowledgeWarnings,
      SPEC_KNOWLEDGE_WARNINGS_TOKENS,
    ),
    activeCharacterArcs: compactRecentList(
      buildActiveCharacterArcLines(packet, memory),
      SPEC_CHARACTER_ARCS_TOKENS,
    ),
  };
}

export function buildSpecPacketView(packet: ChapterPacket): SpecPacketView {
  return {
    chapterNumber: packet.chapterNumber,
    title: packet.title,
    qualityProfile: packet.qualityProfile,
    riskLevel: packet.riskLevel,
    purpose: packet.purpose,
    chapterFunction: packet.chapterFunction,
    openingHandoff: packet.openingHandoff,
    activeCast: packet.activeCast.map(buildPromptCharacterView),
    mandatoryBeats: packet.mandatoryBeats,
    revealBudget: packet.revealBudget,
    callbackObligations: packet.callbackObligations,
    targetWordBand: packet.targetWordBand,
    endingHookTarget: packet.endingHookTarget,
    continuityNotes: packet.continuityNotes,
    chapterNotes: packet.chapterNotes,
    storyState: buildSpecStoryStateView(packet),
  };
}

export function buildDeltaPacketView(packet: ChapterPacket): DeltaPacketView {
  return {
    chapterNumber: packet.chapterNumber,
    title: packet.title,
    qualityProfile: packet.qualityProfile,
    riskLevel: packet.riskLevel,
    purpose: packet.purpose,
    chapterFunction: packet.chapterFunction,
    openingHandoff: packet.openingHandoff,
    activeCast: packet.activeCast.map(buildPromptCharacterView),
    mandatoryBeats: packet.mandatoryBeats,
    revealBudget: packet.revealBudget,
    callbackObligations: packet.callbackObligations,
    targetWordBand: packet.targetWordBand,
    endingHookTarget: packet.endingHookTarget,
    continuityNotes: packet.continuityNotes,
    chapterNotes: packet.chapterNotes,
  };
}
