import type {
  BlueprintCompilationArtifacts,
  ChapterDelta,
  ChapterPacket,
  RollingMemory,
  SelectedChapter,
  ValidatorIssue,
  ValidatorReport,
} from "../types/index.js";
import { normalizeLookupKey } from "../utils/index.js";
import { runContinuityManifestValidators } from "./continuity-manifest.js";
import {
  buildAllowedTermsFromPacket,
  checkDialogueTags,
  checkParagraphDistribution,
  detectFilterWords,
  detectKnowledgeLeaks,
  detectRepetition,
} from "./prose-quality.js";

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "into",
  "from",
  "will",
  "must",
  "have",
  "your",
  "their",
  "about",
  "what",
  "where",
  "when",
  "through",
]);

function addIssue(
  issues: ValidatorIssue[],
  severity: ValidatorIssue["severity"],
  code: string,
  message: string,
  evidence: string[] = [],
): void {
  issues.push({ severity, code, message, evidence });
}

function extractKeywords(text: string): string[] {
  return normalizeLookupKey(text)
    .split(" ")
    .filter((token) => token.length >= 5 && !STOP_WORDS.has(token))
    .slice(0, 5);
}

function overlappingTokens(left: string, right: string): number {
  const leftTokens = new Set(extractKeywords(left));
  const rightTokens = new Set(extractKeywords(right));
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap;
}

export function runDeterministicValidators(params: {
  packet: ChapterPacket;
  selected: SelectedChapter;
  delta: ChapterDelta;
  memory: RollingMemory;
  previousMemory: RollingMemory | null;
  blueprintArtifacts: BlueprintCompilationArtifacts;
}): ValidatorReport {
  const { packet, selected, delta, memory, previousMemory, blueprintArtifacts } = params;
  const issues: ValidatorIssue[] = [];
  const prose = selected.prose;
  const proseLower = prose.toLowerCase();
  const wordCount = selected.wordCount;

  if (wordCount < packet.targetWordBand.min || wordCount > packet.targetWordBand.max) {
    addIssue(
      issues,
      "error",
      "WORD_BAND",
      `Chapter word count ${wordCount} falls outside target band ${packet.targetWordBand.min}-${packet.targetWordBand.max}.`,
      [String(wordCount)],
    );
  }

  const placeholderPatterns = [
    /\breplace with\b/gi,
    /\bTODO\b/g,
    /\[insert\b/gi,
    /\bas an ai\b/gi,
    /\[placeholder/i,
    /\[TK\]/g,
  ];
  for (const pattern of placeholderPatterns) {
    if (pattern.test(prose)) {
      addIssue(
        issues,
        "error",
        "PLACEHOLDER_TEXT",
        "Published prose contains placeholder or meta text.",
      );
      break;
    }
  }

  for (const beat of packet.mandatoryBeats) {
    const keywords = extractKeywords(beat);
    if (keywords.length === 0) {
      continue;
    }
    const present = keywords.some((keyword) => proseLower.includes(keyword));
    if (!present) {
      addIssue(
        issues,
        "error",
        "MANDATORY_BEAT_MISSING",
        `Mandatory beat may be absent from prose: ${beat}`,
        keywords,
      );
    }
  }

  for (const unresolvedThread of previousMemory?.unresolvedThreads ?? []) {
    const carriedForward = memory.unresolvedThreads.some(
      (thread) => overlappingTokens(thread, unresolvedThread) > 0,
    );
    const resolvedNow = delta.plotThreadProgression.some(
      (thread) => thread.resolved && overlappingTokens(thread.thread, unresolvedThread) > 0,
    );
    if (!carriedForward && !resolvedNow) {
      addIssue(
        issues,
        "error",
        "UNRESOLVED_THREAD_DROPPED",
        `Unresolved thread disappeared without progression or resolution: ${unresolvedThread}`,
      );
    }
  }

  const characters = blueprintArtifacts.compiledBlueprint.data.characters;
  for (const change of delta.knowledgeChanges) {
    const character = characters.find((entry) => normalizeLookupKey(entry.name) === normalizeLookupKey(change.holder));
    if (!character?.knowledgeBoundary) {
      continue;
    }
    if (overlappingTokens(change.gainedKnowledge, character.knowledgeBoundary) >= 2) {
      addIssue(
        issues,
        "error",
        "KNOWLEDGE_BOUNDARY",
        `${change.holder} may have crossed a stated knowledge boundary.`,
        [character.knowledgeBoundary, change.gainedKnowledge],
      );
    }
  }

  const knownCharacters = new Set(
    blueprintArtifacts.compiledBlueprint.data.characters.map((character) => normalizeLookupKey(character.name)),
  );
  for (const entity of delta.entityMentions) {
    const normalized = normalizeLookupKey(entity.name);
    if (!knownCharacters.has(normalized) && !entity.introducedThisChapter) {
      addIssue(
        issues,
        "error",
        "ENTITY_CONSISTENCY",
        `Entity ${entity.name} appears without blueprint support or an introduction marker.`,
      );
    }
  }

  const knowledgeMatrix = memory.knowledgeMatrix;
  const allowedTerms = buildAllowedTermsFromPacket(packet);
  issues.push(
    ...detectRepetition(prose, { allowedTerms }),
    ...detectFilterWords(prose),
    ...checkParagraphDistribution(prose),
    ...checkDialogueTags(prose),
    ...detectKnowledgeLeaks(prose, knowledgeMatrix),
    ...runContinuityManifestValidators({
      manifest: blueprintArtifacts.continuityManifest.data,
      packet,
      prose,
    }),
  );

  return {
    passed: !issues.some((issue) => issue.severity === "error"),
    errorCount: issues.filter((issue) => issue.severity === "error").length,
    warningCount: issues.filter((issue) => issue.severity === "warning").length,
    issues,
  };
}
