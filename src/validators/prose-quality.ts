import type { KnowledgeMatrixEntry, ValidatorIssue } from "../types/index.js";
import { countWords, normalizeLookupKey } from "../utils/index.js";

const TRIVIAL = new Set([
  "the", "and", "was", "were", "had", "has", "have", "been", "with", "that",
  "this", "from", "into", "for", "but", "not", "her", "his", "she", "they",
  "them", "their", "its", "all", "are", "who", "what", "when", "where",
  "could", "would", "will", "just", "more", "then", "than", "some", "other",
  "back", "over", "like", "about", "only", "also", "very", "much", "even",
  "still", "already", "most", "own", "before", "after", "each", "every",
  "both", "through", "being", "those", "these", "here", "there", "down",
  "of", "to", "is", "it", "no", "up", "so", "did", "now", "out", "off",
  "one", "any", "how", "our", "too", "way", "got", "yet", "may", "can",
  "came", "went", "made", "told", "does", "such", "same", "many", "once",
]);

const FILTER_RE = /\b(?:felt|noticed|realized|saw|heard|seemed|thought|watched|looked|knew|wondered|observed|perceived|considered|decided|remembered|recognized)\b/gi;

const DIALOGUE_VERB_RE = /\b(?:said|asked|whispered|muttered|replied|answered|called|shouted|declared|exclaimed|murmured|stated)\b/gi;

const SAID_ADVERB_RE = /\b(?:said|asked)\s+\w+ly\b/gi;

// Section-break / scene-divider paragraphs that should never count as
// duplicate prose. Covers both compact (`***`, `---`, `===`, `~~~`, `# # #`)
// and spaced (`* * *`, `# # #`, `~ ~ ~`, `◆ ◆ ◆`) forms, plus the literal
// markdown-style `---`. Anything composed entirely of these glyphs and
// whitespace is treated as a divider, not prose.
const SCENE_BREAK_RE = /^[\s\-*=~◆#_•·]+$/;

function isSceneBreakParagraph(trimmed: string): boolean {
  return trimmed.length === 0 || SCENE_BREAK_RE.test(trimmed);
}

export function detectRepetition(prose: string): ValidatorIssue[] {
  const issues: ValidatorIssue[] = [];
  const paragraphs = prose.split(/\n\n+/).filter(Boolean);

  // Surface exact duplicate paragraphs as a structural error — a common
  // LLM failure mode that the n-gram pass alone would miss after dedup.
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const p of paragraphs) {
    const trimmed = p.trim();
    // Skip scene-break markers, structural glyphs, and very short paragraphs.
    // Threshold raised from 3 to 6 because legitimate short dialogue exchanges
    // ("Yes, Miss V.", "Two minutes.", "Allegro on a leash.") are 2-5 words
    // and recur naturally; flagging them as DUPLICATE_PARAGRAPH errors
    // produced false positives that historically triggered wholesale fix-loop
    // rewrites of clean prose.
    if (isSceneBreakParagraph(trimmed)) continue;
    if (countWords(trimmed) < 6) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key) && !reported.has(key)) {
      reported.add(key);
      issues.push({
        severity: "error",
        code: "DUPLICATE_PARAGRAPH",
        message: "Exact duplicate paragraph detected.",
        evidence: [trimmed.slice(0, 120)],
      });
    }
    seen.add(key);
  }

  // Collapse duplicates before phrase-level n-gram analysis so that
  // filler copies don't swamp the output with redundant phrase warnings.
  const unique = [...new Set(paragraphs)].join("\n\n");

  const words = unique
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (words.length < 8) return issues;

  const counts = new Map<string, number>();
  for (let i = 0; i <= words.length - 4; i++) {
    const gram = words.slice(i, i + 4);
    if (gram.filter((w) => !TRIVIAL.has(w)).length < 2) continue;
    const key = gram.join(" ");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // 4-word phrase echoes are statistically common in literary prose at ~4000 words.
  // Two occurrences are typically incidental; three is suspicious; four+ is a craft failure.
  for (const [phrase, count] of counts) {
    if (count >= 4) {
      issues.push({
        severity: "error",
        code: "REPETITION",
        message: `Phrase "${phrase}" repeated ${count} times.`,
        evidence: [phrase],
      });
    } else if (count === 3) {
      issues.push({
        severity: "warning",
        code: "REPETITION",
        message: `Phrase "${phrase}" repeated 3 times.`,
        evidence: [phrase],
      });
    }
  }

  return issues;
}

export function detectFilterWords(prose: string): ValidatorIssue[] {
  const total = countWords(prose);
  if (total < 200) return [];

  const matches = prose.match(FILTER_RE) ?? [];
  const perTwoHundred = (matches.length / total) * 200;
  if (perTwoHundred <= 1) return [];

  return [
    {
      severity: "warning",
      code: "FILTER_WORD_DENSITY",
      message: `Filter word density ${perTwoHundred.toFixed(1)} per 200 words exceeds threshold.`,
      evidence: [...new Set(matches.map((m) => m.toLowerCase()))].slice(0, 5),
    },
  ];
}

export function checkParagraphDistribution(prose: string): ValidatorIssue[] {
  const issues: ValidatorIssue[] = [];
  const paragraphs = prose.split(/\n\n+/).filter((p) => p.trim().length > 0);
  if (paragraphs.length < 3) return issues;

  const longCount = paragraphs.filter((p) => countWords(p) > 200).length;
  if (longCount / paragraphs.length > 0.3) {
    issues.push({
      severity: "warning",
      code: "PARAGRAPH_DISTRIBUTION",
      message: `${longCount} of ${paragraphs.length} paragraphs exceed 200 words.`,
      evidence: [],
    });
  }

  let consecutive = 0;
  for (const p of paragraphs) {
    const sentences = p.split(/[.!?]+/).filter((s) => s.trim().length > 3);
    consecutive = sentences.length <= 1 ? consecutive + 1 : 0;
    if (consecutive >= 5) {
      issues.push({
        severity: "warning",
        code: "PARAGRAPH_DISTRIBUTION",
        message: `${consecutive}+ consecutive single-sentence paragraphs.`,
        evidence: [],
      });
      break;
    }
  }

  return issues;
}

export function checkDialogueTags(prose: string): ValidatorIssue[] {
  const totalTags = (prose.match(DIALOGUE_VERB_RE) ?? []).length;
  if (totalTags < 4) return [];

  const saidAdverb = (prose.match(SAID_ADVERB_RE) ?? []).length;
  if (saidAdverb / totalTags <= 0.5) return [];

  return [
    {
      severity: "warning",
      code: "DIALOGUE_TAG_VARIETY",
      message: `${saidAdverb} of ${totalTags} dialogue tags use "said/asked + adverb" (${Math.round((saidAdverb / totalTags) * 100)}%).`,
      evidence: [],
    },
  ];
}

const LEAK_TRIVIAL = new Set([
  "about", "after", "before", "being", "could", "chapter", "every",
  "first", "never", "other", "scene", "should", "still", "story",
  "their", "there", "these", "those", "under", "until", "where",
  "which", "while", "would", "knows", "learn",
]);

function isWordMatch(word: string, target: string): boolean {
  if (word === target) return true;
  if (word.length <= target.length || !word.startsWith(target)) return false;
  return !/[a-z]/i.test(word.charAt(target.length));
}

function stripPunctuation(word: string): string {
  return word.replace(/^[^a-z]+/, "").replace(/[^a-z]+$/, "");
}

export function detectKnowledgeLeaks(
  prose: string,
  knowledgeMatrix: KnowledgeMatrixEntry[],
): ValidatorIssue[] {
  const issues: ValidatorIssue[] = [];
  const words = prose.toLowerCase().split(/\s+/).map(stripPunctuation);

  for (const entry of knowledgeMatrix) {
    if (entry.mustNotKnowYet.length === 0) continue;

    // Drop trivial articles/pronouns ("The", "A", "Of", ...) from the
    // character anchor. Without this filter, a character literally named
    // "The Busboy" matches every "the" in the prose and the 100-word window
    // becomes a sliding scan over the whole chapter, so any 2 of the 5
    // forbidden keywords co-occurring anywhere triggers a false positive.
    const charParts = normalizeLookupKey(entry.character)
      .split(" ")
      .filter((p) => p.length >= 3 && !TRIVIAL.has(p));
    if (charParts.length === 0) continue;

    const charPositions: number[] = [];
    for (let i = 0; i < words.length; i++) {
      if (charParts.some((p) => isWordMatch(words[i]!, p))) charPositions.push(i);
    }
    if (charPositions.length === 0) continue;

    for (const forbidden of entry.mustNotKnowYet) {
      const keywords = normalizeLookupKey(forbidden)
        .split(" ")
        .filter((k) => k.length >= 5 && !LEAK_TRIVIAL.has(k))
        .slice(0, 5);
      if (keywords.length === 0) continue;

      let found = false;
      for (const pos of charPositions) {
        const start = Math.max(0, pos - 100);
        const end = Math.min(words.length, pos + 100);
        const windowWords = words.slice(start, end);

        if (keywords.filter((k) => windowWords.some((w) => isWordMatch(w, k))).length >= 2) {
          issues.push({
            severity: "error",
            code: "KNOWLEDGE_LEAK_PROSE",
            message: `${entry.character} appears near forbidden knowledge "${forbidden}" in prose.`,
            evidence: [entry.character, forbidden],
          });
          found = true;
          break;
        }
      }
      if (found) break;
    }
  }

  return issues;
}
