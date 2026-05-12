import type { CharacterCard, KnowledgeMatrixEntry, ValidatorIssue } from "../types/index.js";
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

// Function-words and pronoun-like tokens that should NOT count as distinctive
// content for single-word lexical-repetition detection. Intentionally narrower
// than TRIVIAL — distinctive verbs (came, told, stood, turned, moved, looked)
// and adjectives (small, beautiful) stay countable because their repetition is
// exactly the tic this detector exists to surface. "way" is excluded because
// the sentence-shape detector handles "the way" as a phrase.
const LEXICAL_STOPWORDS = new Set([
  "the", "an",
  "he", "she", "it", "they", "we", "you",
  "his", "her", "its", "their", "our", "your", "my",
  "him", "them", "us", "me",
  "himself", "herself", "itself", "themselves", "ourselves", "yourself", "myself",
  "this", "that", "these", "those",
  "who", "what", "when", "where", "why", "how", "which", "whose",
  "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "doing", "done",
  "have", "has", "had", "having",
  "will", "would", "could", "should", "may", "might", "must", "can", "shall",
  "of", "to", "in", "for", "on", "at", "by", "with", "from",
  "into", "onto", "upon", "out", "off", "down", "over", "under",
  "through", "across", "against", "before", "after", "between",
  "among", "around", "near", "behind", "beyond", "beside",
  "above", "below", "about", "within", "without", "during", "until",
  "and", "or", "but", "nor", "if", "as", "while",
  "because", "although", "though", "unless", "than", "yet",
  "not", "no", "yes",
  "very", "too", "also", "just", "even", "only", "more", "most", "much", "many",
  "some", "any", "all", "each", "every", "both", "either", "neither", "such",
  "still", "again", "then", "now", "here", "there", "back",
  "way",
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "first", "second", "third", "fourth", "fifth",
  "thing", "things", "something", "someone", "anyone", "everyone",
  "anything", "everything", "nothing", "another",
]);

// Literary sentence-shape tic phrases. Recurring constructions that read as
// authorial fingerprints when overused. Curated watchlist (v1) rather than
// statistical inference; extend as new tics appear in published chapters.
const SENTENCE_SHAPE_PHRASES: readonly string[] = [
  "the way",
  "as though",
  "as if",
  "not quite",
  "half second",
  "half a second",
  "for a moment",
];

// v1 calibration. count ≥ 8 with rate ≥ 2.0 / 1000 surfaces distinctive-word
// tics (e.g. "acrylic" 10x at ~4200 words → 2.37/1000) without firing on
// proper-noun-density inside the chapter's own setting.
const LEXICAL_MIN_COUNT = 8;
const LEXICAL_MIN_RATE_PER_1000 = 2.0;
const SENTENCE_SHAPE_MIN_COUNT = 5;

export interface RepetitionContext {
  /**
   * Tokens that should be exempt from single-word lexical-repetition counting.
   * Keep narrow: character first/last names, proper nouns, and mandatory-beat
   * keywords that are genuinely required. Do NOT add general high-frequency
   * setting words ("room", "glass") — they need to remain visible to the
   * detector even when they appear in beats.
   */
  allowedTerms?: readonly string[];
}

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

export function detectRepetition(
  prose: string,
  context: RepetitionContext = {},
): ValidatorIssue[] {
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

  issues.push(...detectLexicalRepetition(prose, context));
  issues.push(...detectSentenceShapeRepetition(prose));

  return issues;
}

function normalizeAllowedSet(allowedTerms: readonly string[] | undefined): Set<string> {
  const out = new Set<string>();
  if (!allowedTerms) return out;
  for (const term of allowedTerms) {
    if (!term) continue;
    const tokens = term.toLowerCase().split(/[^a-z']+/).filter(Boolean);
    for (const token of tokens) {
      if (token.length >= 3) out.add(token);
    }
  }
  return out;
}

/**
 * Single-word lexical-repetition detector. Surfaces distinctive content words
 * (nouns, verbs, adjectives) that recur often enough to read as authorial
 * fingerprints. Warning-only; revision and voice-grit consume the evidence.
 */
export function detectLexicalRepetition(
  prose: string,
  context: RepetitionContext = {},
): ValidatorIssue[] {
  const allowed = normalizeAllowedSet(context.allowedTerms);
  const words = prose
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < 200) return [];

  const counts = new Map<string, number>();
  for (const raw of words) {
    // Strip straight-apostrophe possessives so "erik's" matches the allowed
    // "erik" exemption (and a single repeated noun isn't double-counted as
    // its bare and possessive forms).
    const word = raw.replace(/'s?$/, "");
    if (word.length < 4) continue;
    if (LEXICAL_STOPWORDS.has(word)) continue;
    if (allowed.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  const issues: ValidatorIssue[] = [];
  const totalWords = words.length;
  for (const [word, count] of counts) {
    if (count < LEXICAL_MIN_COUNT) continue;
    const rate = (count / totalWords) * 1000;
    if (rate < LEXICAL_MIN_RATE_PER_1000) continue;
    issues.push({
      severity: "warning",
      code: "LEXICAL_REPETITION",
      message: `Word "${word}" appears ${count} times (${rate.toFixed(1)} per 1000 words).`,
      evidence: [word, String(count), rate.toFixed(1)],
    });
  }
  return issues;
}

function escapeRegex(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPhraseRegex(phrase: string): RegExp {
  const tokens = phrase.split(/\s+/).map(escapeRegex);
  return new RegExp(`\\b${tokens.join("\\s+")}\\b`, "gi");
}

/**
 * Sentence-shape repetition detector. Counts curated literary tic phrases
 * (e.g. "the way", "as though") that signal authorial-fingerprint rhythm
 * when overused. Warning-only; extend SENTENCE_SHAPE_PHRASES as new tics
 * appear in published chapters.
 */
export function detectSentenceShapeRepetition(prose: string): ValidatorIssue[] {
  const issues: ValidatorIssue[] = [];
  for (const phrase of SENTENCE_SHAPE_PHRASES) {
    const matches = prose.match(buildPhraseRegex(phrase)) ?? [];
    if (matches.length < SENTENCE_SHAPE_MIN_COUNT) continue;
    issues.push({
      severity: "warning",
      code: "SENTENCE_SHAPE_REPETITION",
      message: `Sentence-shape phrase "${phrase}" appears ${matches.length} times.`,
      evidence: [phrase, String(matches.length)],
    });
  }
  return issues;
}

/**
 * Build the `allowedTerms` set the way every caller should: character first
 * and last names from `activeCast`, plus proper nouns (capitalized tokens)
 * appearing in mandatory beats. Common nouns in beats are intentionally NOT
 * exempted — they're exactly the kind of repeated setting word the detector
 * exists to surface. Centralizing the rule keeps the three repetition
 * call-sites consistent.
 */
export function buildAllowedTermsFromPacket(packet: {
  activeCast?: ReadonlyArray<{ name: string }> | null;
  mandatoryBeats?: readonly string[] | null;
}): string[] {
  const out = new Set<string>();
  for (const member of packet.activeCast ?? []) {
    const tokens = member.name.toLowerCase().split(/[^a-z']+/).filter(Boolean);
    for (const token of tokens) {
      if (token.length >= 3) out.add(token);
    }
  }
  for (const beat of packet.mandatoryBeats ?? []) {
    // Split into sentences and strip the first word of each. Sentence-initial
    // capitalization is grammatical, not a proper-noun signal — without this
    // step a beat like "Acrylic cracks…" would exempt the very tic the
    // detector exists to surface.
    const sentences = beat.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (!trimmed) continue;
      const afterFirstWord = trimmed.replace(/^\S+\s*/, "");
      const properNouns = afterFirstWord.match(/\b[A-Z][a-zA-Z]{2,}\b/g) ?? [];
      for (const match of properNouns) {
        const lower = match.toLowerCase();
        if (LEXICAL_STOPWORDS.has(lower)) continue;
        out.add(lower);
      }
    }
  }
  return [...out];
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
  "about", "after", "arrives", "before", "being", "chapter", "could",
  "every", "first", "holding", "identifies", "intercom", "knows", "learn",
  "midpoint", "never", "other", "pivot", "protects", "scene", "sector",
  "should", "southwest", "still", "story", "their", "there", "these",
  "those", "under", "until", "where", "which", "while", "wider", "would",
]);

function buildSharedNameParts(knowledgeMatrix: KnowledgeMatrixEntry[]): Set<string> {
  const counts = new Map<string, number>();

  for (const entry of knowledgeMatrix) {
    const parts = new Set(
      normalizeLookupKey(entry.character)
        .split(" ")
        .filter((p) => p.length >= 3 && !TRIVIAL.has(p)),
    );
    for (const part of parts) {
      counts.set(part, (counts.get(part) ?? 0) + 1);
    }
  }

  return new Set(
    Array.from(counts.entries())
      .filter(([, count]) => count >= 2)
      .map(([part]) => part),
  );
}

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
  const sharedNameParts = buildSharedNameParts(knowledgeMatrix);

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
    const disambiguatedCharParts = charParts.filter((p) => !sharedNameParts.has(p));
    const anchorParts = disambiguatedCharParts.length > 0 ? disambiguatedCharParts : charParts;
    if (anchorParts.length === 0) continue;

    const charPositions: number[] = [];
    for (let i = 0; i < words.length; i++) {
      if (anchorParts.some((p) => isWordMatch(words[i]!, p))) charPositions.push(i);
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

/**
 * Per-chapter named-character cap. Counts distinct blueprint characters whose
 * aliases (first name + full name case-insensitive; opt-in surname-only
 * case-sensitive) appear in the prose, and warns when the count exceeds
 * `cap`. Warning-only; unnamed walk-ons (`the waiter`, `the senator's aide`)
 * never count because they aren't in the blueprint cast.
 */
export function detectNamedCharacterCapExceeded(
  prose: string,
  characters: ReadonlyArray<CharacterCard>,
  cap: number | undefined,
): ValidatorIssue[] {
  if (cap === undefined || cap < 0) return [];

  const present: string[] = [];
  for (const character of characters) {
    const name = character.name.trim();
    if (!name) continue;
    const tokens = name.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;

    const firstName = tokens[0]!;
    const lastName = tokens.length > 1 ? tokens[tokens.length - 1]! : null;

    const checks: RegExp[] = [];
    if (firstName.length >= 3) {
      checks.push(new RegExp(`\\b${escapeRegex(firstName)}\\b`, "i"));
    }
    if (tokens.length > 1) {
      const fullPattern = tokens.map(escapeRegex).join("\\s+");
      checks.push(new RegExp(`\\b${fullPattern}\\b`, "i"));
    }
    // Surname-only matching is opt-in and case-sensitive so common-noun
    // surnames (`Park`, `Crane`) don't trip on prose like `the crane lifted`.
    if (character.surnameAlias && lastName && lastName.length >= 3) {
      checks.push(new RegExp(`\\b${escapeRegex(lastName)}\\b`));
    }

    if (checks.length === 0) continue;
    if (checks.some((re) => re.test(prose))) {
      present.push(name);
    }
  }

  if (present.length <= cap) return [];

  return [
    {
      severity: "warning",
      code: "CHARACTER_CAP",
      message: `Named character cap of ${cap} exceeded: prose references ${present.length} blueprint characters (${present.join(", ")}).`,
      evidence: [String(cap), String(present.length), ...present],
    },
  ];
}
