import { config } from "../config.js";
import type {
  CharacterEmotionalState,
  ChapterDelta,
  HandoffMemory,
  KnowledgeMatrixEntry,
  MemoryUpdateProposal,
  RollingMemory,
  VoiceCard,
} from "../types/index.js";
import { dedupeStrings, normalizeLookupKey } from "../utils/index.js";
import { buildHandoff } from "./build-handoff.js";
import { trackReveals } from "./track-reveals.js";

const MEMORY_STOP_WORDS = new Set([
  "about",
  "across",
  "already",
  "around",
  "being",
  "before",
  "between",
  "beyond",
  "both",
  "from",
  "have",
  "into",
  "later",
  "must",
  "over",
  "still",
  "than",
  "that",
  "their",
  "there",
  "these",
  "this",
  "through",
  "under",
  "until",
  "while",
]);

interface SemanticStatement {
  text: string;
  normalized: string;
  tokens: string[];
  tokenSet: Set<string>;
}

function normalizeSemanticToken(token: string): string {
  const singularized = token.endsWith("ies") && token.length > 4
    ? `${token.slice(0, -3)}y`
    : token.endsWith("s") && !token.endsWith("ss") && token.length > 4
      ? token.slice(0, -1)
      : token;

  return singularized
    .replace(/ing$/u, "")
    .replace(/ed$/u, "")
    .replace(/ly$/u, "")
    .replace(/ment$/u, "");
}

function toSemanticStatement(value: string): SemanticStatement | null {
  const text = value.trim();
  if (!text) {
    return null;
  }

  const normalized = normalizeLookupKey(text);
  const tokens = dedupeStrings(
    normalized
      .split(" ")
      .map(normalizeSemanticToken)
      .filter((token) => token.length >= 4 && !MEMORY_STOP_WORDS.has(token)),
  );

  return {
    text,
    normalized,
    tokens,
    tokenSet: new Set(tokens),
  };
}

function overlapCount(left: Set<string>, right: Set<string>): number {
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) {
      overlap += 1;
    }
  }
  return overlap;
}

function isMeaningfulSuperset(left: SemanticStatement, right: SemanticStatement): boolean {
  return left.tokenSet.size >= right.tokenSet.size + 2
    && right.tokens.every((token) => left.tokenSet.has(token));
}

function statementsMatch(left: SemanticStatement, right: SemanticStatement): boolean {
  if (
    left.normalized === right.normalized
    || left.normalized.includes(right.normalized)
    || right.normalized.includes(left.normalized)
  ) {
    return true;
  }

  if (left.tokenSet.size === 0 || right.tokenSet.size === 0) {
    return false;
  }

  const overlap = overlapCount(left.tokenSet, right.tokenSet);
  const smaller = Math.min(left.tokenSet.size, right.tokenSet.size);
  if (smaller === 0) {
    return false;
  }

  if (overlap === smaller && smaller >= 2) {
    return true;
  }

  if (smaller <= 4) {
    return overlap >= 2 && overlap / smaller >= 0.5;
  }

  return overlap >= 3 && overlap / smaller >= 0.6;
}

function statementScore(statement: SemanticStatement): number {
  const structuredTokenBonus = /(?:[a-z]-\d|\d|rev|prom)/iu.test(statement.text) ? 2 : 0;
  return (statement.tokenSet.size * 10) + structuredTokenBonus - (statement.normalized.length / 40);
}

function shouldReplaceStatement(existing: SemanticStatement, candidate: SemanticStatement): boolean {
  if (isMeaningfulSuperset(candidate, existing)) {
    return true;
  }

  if (isMeaningfulSuperset(existing, candidate)) {
    return false;
  }

  const candidateContains = candidate.normalized.includes(existing.normalized);
  const existingContains = existing.normalized.includes(candidate.normalized);
  if (candidateContains && !existingContains) {
    return true;
  }
  if (existingContains && !candidateContains) {
    return false;
  }

  const candidateScore = statementScore(candidate);
  const existingScore = statementScore(existing);
  if (candidateScore === existingScore) {
    return candidate.normalized.length > existing.normalized.length;
  }

  return candidateScore > existingScore;
}

function splitComparableClauses(value: string): string[] {
  return value
    .split(/\s*;\s*/u)
    .flatMap((part) => part.split(/\s*,\s*(?:and|but|yet)\s+/iu))
    .flatMap((part) => part.split(/\s+and\s+(?=requires\b)/iu))
    .map((part) => part.trim().replace(/^(?:and|but|yet)\s+/iu, ""))
    .filter(Boolean);
}

function statementCoveredByExisting(
  statement: SemanticStatement,
  existingStatements: SemanticStatement[],
): boolean {
  const clauses = splitComparableClauses(statement.text);
  if (clauses.length <= 1) {
    return false;
  }

  return clauses.every((clause) => {
    const clauseStatement = toSemanticStatement(clause);
    return clauseStatement
      ? existingStatements.some((existing) => statementsMatch(existing, clauseStatement))
      : true;
  });
}

function mergeSemanticStringLists(...lists: string[][]): string[] {
  const statements: SemanticStatement[] = [];

  for (const value of lists.flat()) {
    const statement = toSemanticStatement(value);
    if (!statement) {
      continue;
    }

    if (statementCoveredByExisting(statement, statements)) {
      continue;
    }

    const matchIndex = statements.findIndex((existing) => statementsMatch(existing, statement));
    if (matchIndex === -1) {
      statements.push(statement);
      continue;
    }

    const existing = statements[matchIndex];
    if (existing && shouldReplaceStatement(existing, statement)) {
      statements[matchIndex] = statement;
    }
  }

  return statements.map((statement) => statement.text);
}

function threadMatches(left: string, right: string): boolean {
  const leftStatement = toSemanticStatement(left);
  const rightStatement = toSemanticStatement(right);
  if (!leftStatement || !rightStatement) {
    return false;
  }

  return statementsMatch(leftStatement, rightStatement);
}

function normalizeKnowledgeEntry(entry: KnowledgeMatrixEntry): KnowledgeMatrixEntry {
  return {
    character: entry.character,
    knows: mergeSemanticStringLists(entry.knows),
    suspects: mergeSemanticStringLists(entry.suspects),
    hides: mergeSemanticStringLists(entry.hides),
    mustNotKnowYet: mergeSemanticStringLists(entry.mustNotKnowYet),
  };
}

function normalizeVoiceCard(card: VoiceCard): VoiceCard {
  return {
    character: card.character,
    activeTraits: mergeSemanticStringLists(card.activeTraits),
    stressPattern: card.stressPattern.trim(),
    dialogueHabits: mergeSemanticStringLists(card.dialogueHabits),
    tabooNotes: mergeSemanticStringLists(card.tabooNotes),
    updatedFromChapter: card.updatedFromChapter,
  };
}

function normalizeHandoff(handoff: HandoffMemory): HandoffMemory {
  return {
    openingSituation: handoff.openingSituation.trim(),
    physicalState: mergeSemanticStringLists(handoff.physicalState),
    emotionalState: mergeSemanticStringLists(handoff.emotionalState),
    causalState: mergeSemanticStringLists(handoff.causalState),
    mandatoryCallbacks: mergeSemanticStringLists(handoff.mandatoryCallbacks),
    characterStates: handoff.characterStates,
  };
}

export function normalizeRollingMemory(memory: RollingMemory): RollingMemory {
  return {
    ...memory,
    storySpine: memory.storySpine.trim(),
    unresolvedThreads: mergeSemanticStringLists(memory.unresolvedThreads),
    activePressures: mergeSemanticStringLists(memory.activePressures),
    knowledgeMatrix: memory.knowledgeMatrix
      .map(normalizeKnowledgeEntry)
      .sort((left, right) => left.character.localeCompare(right.character)),
    activeCharacterVoiceCards: memory.activeCharacterVoiceCards
      .map(normalizeVoiceCard)
      .sort((left, right) => left.character.localeCompare(right.character)),
    nextChapterOpeningHandoff: normalizeHandoff(memory.nextChapterOpeningHandoff),
    compressedHistory: dedupeStrings(
      memory.compressedHistory.map((entry) => entry.trim()).filter(Boolean),
    ).slice(-config.defaults.olderHistoryEntries),
    lastChapterSummary: memory.lastChapterSummary.trim(),
    emotionalStates: memory.emotionalStates
      .sort((left, right) => left.character.localeCompare(right.character)),
  };
}

function mergeKnowledgeMatrix(
  previousMemory: RollingMemory | null,
  proposal: MemoryUpdateProposal,
  delta: ChapterDelta,
): KnowledgeMatrixEntry[] {
  const entries = new Map<string, KnowledgeMatrixEntry>();

  const upsert = (entry: KnowledgeMatrixEntry): void => {
    const key = normalizeLookupKey(entry.character);
    const existing = entries.get(key);
    if (!existing) {
      entries.set(key, normalizeKnowledgeEntry({
        character: entry.character,
        knows: [...entry.knows],
        suspects: [...entry.suspects],
        hides: [...entry.hides],
        mustNotKnowYet: [...entry.mustNotKnowYet],
      }));
      return;
    }

    entries.set(key, normalizeKnowledgeEntry({
      character: existing.character,
      knows: mergeSemanticStringLists(existing.knows, entry.knows),
      suspects: mergeSemanticStringLists(existing.suspects, entry.suspects),
      hides: mergeSemanticStringLists(existing.hides, entry.hides),
      mustNotKnowYet: mergeSemanticStringLists(existing.mustNotKnowYet, entry.mustNotKnowYet),
    }));
  };

  for (const entry of previousMemory?.knowledgeMatrix ?? []) {
    upsert(entry);
  }

  for (const entry of proposal.knowledgeMatrix) {
    upsert(entry);
  }

  for (const change of delta.knowledgeChanges) {
    upsert({
      character: change.holder,
      knows: [change.gainedKnowledge],
      suspects: change.suspects,
      hides: change.hides,
      mustNotKnowYet: [],
    });
  }

  // Converge: remove mustNotKnowYet entries that are fully subsumed by knows.
  // This is intentionally stricter than statementsMatch — every content token
  // in the forbidden entry must appear in a single knows entry.  Sharing a
  // few tokens (e.g. "architect" + "consent") is not enough; the known fact
  // must cover the forbidden fact completely.
  for (const [key, entry] of entries) {
    if (entry.mustNotKnowYet.length === 0 || entry.knows.length === 0) continue;
    const knowsStatements = entry.knows
      .map((s) => toSemanticStatement(s))
      .filter((s): s is SemanticStatement => s !== null);
    const filtered = entry.mustNotKnowYet.filter((forbidden) => {
      const stmt = toSemanticStatement(forbidden);
      if (!stmt || stmt.tokenSet.size === 0) return false;
      return !knowsStatements.some((known) =>
        stmt.tokens.every((t) => known.tokenSet.has(t)),
      );
    });
    if (filtered.length !== entry.mustNotKnowYet.length) {
      entries.set(key, { ...entry, mustNotKnowYet: filtered });
    }
  }

  return Array.from(entries.values()).sort((left, right) => left.character.localeCompare(right.character));
}

function mergeVoiceCards(
  previousMemory: RollingMemory | null,
  proposal: MemoryUpdateProposal,
  delta: ChapterDelta,
  chapterNumber: number,
): VoiceCard[] {
  const cards = new Map<string, VoiceCard>();

  const upsert = (card: VoiceCard): void => {
    const key = normalizeLookupKey(card.character);
    const existing = cards.get(key);
    if (!existing) {
      cards.set(key, normalizeVoiceCard({
        character: card.character,
        activeTraits: [...card.activeTraits],
        stressPattern: card.stressPattern,
        dialogueHabits: [...card.dialogueHabits],
        tabooNotes: [...card.tabooNotes],
        updatedFromChapter: card.updatedFromChapter,
      }));
      return;
    }

    cards.set(key, normalizeVoiceCard({
      character: existing.character,
      activeTraits: mergeSemanticStringLists(existing.activeTraits, card.activeTraits),
      stressPattern: card.stressPattern || existing.stressPattern,
      dialogueHabits: mergeSemanticStringLists(existing.dialogueHabits, card.dialogueHabits),
      tabooNotes: mergeSemanticStringLists(existing.tabooNotes, card.tabooNotes),
      updatedFromChapter: Math.max(existing.updatedFromChapter, card.updatedFromChapter),
    }));
  };

  for (const card of previousMemory?.activeCharacterVoiceCards ?? []) {
    upsert(card);
  }

  for (const card of proposal.activeCharacterVoiceCards) {
    upsert(card);
  }

  for (const signal of delta.activeVoiceSignals) {
    const key = normalizeLookupKey(signal.character);
    const existing = cards.get(key);
    cards.set(key, normalizeVoiceCard({
      character: existing?.character ?? signal.character,
      activeTraits: mergeSemanticStringLists(existing?.activeTraits ?? [], signal.voiceNotes),
      stressPattern: existing?.stressPattern ?? "Carry forward the latest chapter pressure.",
      dialogueHabits: existing?.dialogueHabits ?? [],
      tabooNotes: existing?.tabooNotes ?? [],
      updatedFromChapter: chapterNumber,
    }));
  }

  return Array.from(cards.values()).sort((left, right) => left.character.localeCompare(right.character));
}

function mergeEmotionalStates(
  previousMemory: RollingMemory | null,
  proposal: MemoryUpdateProposal,
  delta: ChapterDelta,
): CharacterEmotionalState[] {
  const states = new Map<string, CharacterEmotionalState>();
  for (const s of previousMemory?.emotionalStates ?? []) {
    states.set(normalizeLookupKey(s.character), s);
  }
  for (const s of proposal.emotionalStates) {
    states.set(normalizeLookupKey(s.character), s);
  }
  for (const s of delta.characterEmotionalStates) {
    states.set(normalizeLookupKey(s.character), s);
  }
  return Array.from(states.values()).sort((left, right) => left.character.localeCompare(right.character));
}

export function buildRollingMemory(params: {
  previousMemory: RollingMemory | null;
  delta: ChapterDelta;
  proposal: MemoryUpdateProposal;
  chapterNumber: number;
}): RollingMemory {
  const { previousMemory, delta, proposal } = params;
  const resolvedThreads = delta.plotThreadProgression
    .filter((thread) => thread.resolved)
    .map((thread) => thread.thread);
  const unresolvedThreads = mergeSemanticStringLists(
    previousMemory?.unresolvedThreads ?? [],
    proposal.unresolvedThreads,
    delta.unresolvedThreads,
  ).filter((thread) => !resolvedThreads.some((resolved) => threadMatches(thread, resolved)));
  const compressedHistory = dedupeStrings([
    ...(previousMemory?.compressedHistory ?? []),
    ...(previousMemory?.lastChapterSummary ? [previousMemory.lastChapterSummary] : []),
    ...proposal.compressedHistory,
  ]).slice(-config.defaults.olderHistoryEntries);

  return normalizeRollingMemory({
    storySpine: proposal.storySpine || delta.storySpineUpdate || previousMemory?.storySpine || "",
    unresolvedThreads,
    activePressures: mergeSemanticStringLists(
      previousMemory?.activePressures ?? [],
      proposal.activePressures,
      delta.activePressures,
    ),
    knowledgeMatrix: mergeKnowledgeMatrix(previousMemory, proposal, delta),
    activeCharacterVoiceCards: mergeVoiceCards(previousMemory, proposal, delta, params.chapterNumber),
    revealPayoffLedger: trackReveals(previousMemory, delta),
    nextChapterOpeningHandoff: buildHandoff(proposal, delta),
    compressedHistory,
    lastChapterSummary: proposal.lastChapterSummary || previousMemory?.lastChapterSummary || delta.storySpineUpdate,
    emotionalStates: mergeEmotionalStates(previousMemory, proposal, delta),
  });
}
