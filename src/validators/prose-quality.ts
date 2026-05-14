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
  "a man who",
];

// Inverted noun-phrase contrast frame: "not <NP1> but <NP2>". Catches the
// generated cadence "He was not a guide but a witness." Counted independently
// against SENTENCE_SHAPE_MIN_COUNT, same as each watchlist phrase.
const INVERTED_NP_CONTRAST_RE =
  /\bnot (a|an|the) \w+(\s+\w+){0,2} but (a|an|the) \w+\b/gi;

// Withholding / clarification tics. Any narration instance produces a warning;
// the seed list is partly predictive — the generator paraphrases this shape
// often even when the exact phrase shifts. Extend as new variants appear.
const WITHHOLDING_PHRASES: readonly string[] = [
  "which was to say",
  "did not name",
  "had not earned the right",
  "did not let himself",
];

// Withheld-action / restraint-beat verbs. Pattern: "did/does/do + not + <base verb>"
// or "had/has/have + not + <past participle>" in narration produces a
// one-sentence suspense beat. A few per chapter are good craft; a saturated
// chapter reads as a single trick. Warning-only chapter-level min-count
// gated. Paired curated seed lists — extend in lockstep (same verb in both
// lists, base form in _BASE, past-participle form in _PAST) as new variants
// appear; do not lower the min-count.
const WITHHELD_ACTION_VERBS_BASE: readonly string[] = [
  "look", "turn", "nod", "drink", "write", "name", "finish",
  "raise", "think", "correct", "move", "reach", "cross",
  "stop", "answer", "smile", "speak", "press", "pause",
  "notice", "see", "hear", "breathe", "blink", "wait",
  "let", "say", "ask", "open", "close",
];

const WITHHELD_ACTION_VERBS_PAST: readonly string[] = [
  "looked", "turned", "nodded", "drunk", "written", "named", "finished",
  "raised", "thought", "corrected", "moved", "reached", "crossed",
  "stopped", "answered", "smiled", "spoken", "pressed", "paused",
  "noticed", "seen", "heard", "breathed", "blinked", "waited",
  "let", "said", "asked", "opened", "closed",
];

const WITHHELD_ACTION_MIN_COUNT = 6;

// Narration-`because`-cluster heuristic. Subjects we treat as obvious
// human/social-role markers signaling psychologizing rather than physical
// causality. `it` is intentionally absent: too many physical antecedents in
// engineering-heavy chapters. Extend cautiously.
const EXPLANATORY_BECAUSE_SUBJECTS = new Set<string>([
  "he", "she", "they",
  "man", "men", "woman", "women",
  "boy", "boys", "girl", "girls",
  "admiral", "admirals",
  "reporter", "reporters",
  "journalist", "journalists",
  "senator", "senators",
  "officer", "officers",
  "soldier", "soldiers",
  "engineer", "engineers",
  "writer", "writers",
  "host", "hosts",
  "guest", "guests",
  "father", "mother",
  "people",
]);

// Concrete system nouns that exempt a `because` clause from the explanatory
// cluster heuristic. Engineering-heavy chapters have lots of legitimate
// physical causality; we err toward false negatives. Extend as future
// chapters surface false positives.
const EXPLANATORY_BECAUSE_SYSTEM_NOUNS = new Set<string>([
  "bulkhead", "bulkheads",
  "valve", "valves",
  "hatch", "hatches",
  "line", "lines",
  "water",
  "pressure",
  "gauge", "gauges",
  "pump", "pumps",
  "seal", "seals",
  "door", "doors",
  "cable", "cables",
  "current", "currents",
  "lamp", "lamps",
  "relay", "relays",
  "acrylic",
  "glass",
  "engine", "engines",
  "pipe", "pipes",
]);

const BECAUSE_DETERMINERS = new Set<string>([
  "the", "a", "an",
  "his", "her", "their", "its", "my", "your", "our",
]);

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

  // The 4-gram pass needs at least 8 words to compute a single window, but
  // the warning-only detectors below (lexical, sentence-shape, withholding,
  // explanatory-because) must still run so that "any-instance" rules like
  // WITHHOLDING_TIC fire on short prose. Each of those helpers has its own
  // length safety net.
  if (words.length >= 8) {
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
  }

  issues.push(...detectLexicalRepetition(prose, context));
  issues.push(...detectSentenceShapeRepetition(prose));
  issues.push(...detectWithholdingTic(prose));
  issues.push(...detectWithheldActionVariety(prose));
  issues.push(...detectExplanatoryBecauseCluster(prose));

  return issues;
}

/**
 * Conservative dialogue stripper for narration-only prose detectors. Removes
 * spans inside straight double quotes, curly double quotes, and (cautiously)
 * straight single quotes. False negatives are preferred over stripping
 * narration: possessives ("Erik's") and contractions ("didn't") must survive
 * untouched. Canonical helper for any future narration-only prose detector
 * — call this before counting tic phrases or shape patterns.
 */
export function stripDialogueForNarration(prose: string): string {
  let result = prose;
  result = result.replace(/"[^"\n]*"/g, "");
  result = result.replace(/\u201C[^\u201D\n]*\u201D/g, "");
  // Straight single quotes: only strip when the open quote follows a sentence
  // boundary (start, whitespace, opening bracket) and the close quote is
  // followed by a sentence boundary, AND the contents have at least one
  // internal whitespace. This avoids matching possessives like Erik's or
  // contractions like didn't.
  result = result.replace(
    /(^|[\s(\[])'([^'\n]*\s[^'\n]*)'(?=[\s.,;!?)\]:]|$)/g,
    "$1",
  );
  return result;
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
 * when overused. Also runs a regex-backed check for the inverted noun-phrase
 * contrast frame ("not a man but a manatee") and emits `INVERTED_NP_CONTRAST`
 * when its occurrences cross `SENTENCE_SHAPE_MIN_COUNT`. Warning-only; extend
 * `SENTENCE_SHAPE_PHRASES` as new tics appear in published chapters.
 */
export function detectSentenceShapeRepetition(prose: string): ValidatorIssue[] {
  const issues: ValidatorIssue[] = [];
  const narration = stripDialogueForNarration(prose);

  for (const phrase of SENTENCE_SHAPE_PHRASES) {
    const matches = narration.match(buildPhraseRegex(phrase)) ?? [];
    if (matches.length < SENTENCE_SHAPE_MIN_COUNT) continue;
    issues.push({
      severity: "warning",
      code: "SENTENCE_SHAPE_REPETITION",
      message: `Sentence-shape phrase "${phrase}" appears ${matches.length} times.`,
      evidence: [phrase, String(matches.length)],
    });
  }

  // Inverted noun-phrase contrast: counted independently against the same
  // SENTENCE_SHAPE_MIN_COUNT threshold, but emits a distinct code with
  // paragraph references rather than [phrase, count] evidence.
  const paragraphs = prose.split(/\n\n+/);
  const invertedHits: Array<{ phrase: string; paragraph: number }> = [];
  paragraphs.forEach((rawPara, idx) => {
    const stripped = stripDialogueForNarration(rawPara);
    const matches = stripped.match(INVERTED_NP_CONTRAST_RE) ?? [];
    for (const match of matches) {
      invertedHits.push({ phrase: match.toLowerCase(), paragraph: idx + 1 });
    }
  });
  if (invertedHits.length >= SENTENCE_SHAPE_MIN_COUNT) {
    for (const hit of invertedHits) {
      issues.push({
        severity: "warning",
        code: "INVERTED_NP_CONTRAST",
        message:
          "Repeated comparison frames make the prose feel generated. Ration them and vary rhetorical shape.",
        evidence: [hit.phrase, `paragraph ${hit.paragraph}`],
      });
    }
  }

  return issues;
}

/**
 * Withholding / clarification-tic detector. Flags any narration instance of a
 * curated phrase list that signals the generator's habit of explaining its
 * own metaphors. Warning-only; any single instance produces a hit. Extend
 * `WITHHOLDING_PHRASES` as new variants appear.
 */
export function detectWithholdingTic(prose: string): ValidatorIssue[] {
  const issues: ValidatorIssue[] = [];
  const paragraphs = prose.split(/\n\n+/);
  paragraphs.forEach((rawPara, idx) => {
    const stripped = stripDialogueForNarration(rawPara);
    for (const phrase of WITHHOLDING_PHRASES) {
      const re = buildPhraseRegex(phrase);
      const matches = stripped.match(re) ?? [];
      for (const match of matches) {
        issues.push({
          severity: "warning",
          code: "WITHHOLDING_TIC",
          message:
            "Withholding should be structural, not narrated. Clarifying a metaphor with an elegant explanatory phrase is a generator tic.",
          evidence: [match.toLowerCase(), `paragraph ${idx + 1}`],
        });
      }
    }
  });
  return issues;
}

/**
 * Withheld-action-variety detector. Flags repeated narration instances of
 * the suspense-by-restraint beat — `did/does/do + not + <base verb>` or
 * `had/has/have + not + <past participle>` — for a curated paired seed
 * list of perception/action verbs. A few instances per chapter are good
 * craft; a saturated chapter reads as a single trick. Warning-only;
 * chapter-level min-count gated (combined across both aux families);
 * one warning per hit once threshold clears. Extend
 * `WITHHELD_ACTION_VERBS_BASE` and `WITHHELD_ACTION_VERBS_PAST` in
 * lockstep as new variants appear.
 */
export function detectWithheldActionVariety(prose: string): ValidatorIssue[] {
  const issues: ValidatorIssue[] = [];
  const paragraphs = prose.split(/\n\n+/);
  const baseAlt = WITHHELD_ACTION_VERBS_BASE.join("|");
  const pastAlt = WITHHELD_ACTION_VERBS_PAST.join("|");
  const baseRE = new RegExp(`\\b(?:did|does|do)\\s+not\\s+(?:${baseAlt})\\b`, "gi");
  const pastRE = new RegExp(`\\b(?:had|has|have)\\s+not\\s+(?:${pastAlt})\\b`, "gi");
  const hits: Array<{ phrase: string; paragraph: number }> = [];
  paragraphs.forEach((rawPara, idx) => {
    const stripped = stripDialogueForNarration(rawPara);
    for (const match of stripped.match(baseRE) ?? []) {
      hits.push({ phrase: match.toLowerCase(), paragraph: idx + 1 });
    }
    for (const match of stripped.match(pastRE) ?? []) {
      hits.push({ phrase: match.toLowerCase(), paragraph: idx + 1 });
    }
  });
  if (hits.length >= WITHHELD_ACTION_MIN_COUNT) {
    for (const hit of hits) {
      issues.push({
        severity: "warning",
        code: "WITHHELD_ACTION_VARIETY",
        message:
          "Repeated 'did/had not + verb' restraint beats. Vary how restraint appears: active choice, misreading, interruption, or practical behavior in place of the weaker repetitions.",
        evidence: [hit.phrase, `paragraph ${hit.paragraph}`],
      });
    }
  }
  return issues;
}

function tokenizeBecauseClause(clauseTail: string): string[] {
  return clauseTail
    .toLowerCase()
    .replace(/[^a-z'\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function looksExplanatoryBecause(
  clauseTail: string,
): { phrase: string } | null {
  const tokens = tokenizeBecauseClause(clauseTail);
  if (tokens.length === 0) return null;

  let i = 0;
  while (i < tokens.length && BECAUSE_DETERMINERS.has(tokens[i]!)) {
    i++;
  }
  if (i >= tokens.length) return null;
  const subject = tokens[i]!;
  if (!EXPLANATORY_BECAUSE_SUBJECTS.has(subject)) return null;
  if (tokens.some((t) => EXPLANATORY_BECAUSE_SYSTEM_NOUNS.has(t))) return null;

  const previewTokens = tokens.slice(0, Math.min(5, tokens.length));
  return { phrase: `because ${previewTokens.join(" ")}` };
}

/**
 * Explanatory-`because`-cluster detector. Per-paragraph clusters (no
 * chapter-level cap). Flags when 2+ narration `because` clauses in the same
 * paragraph look explanatory: pronoun or human/social-role subject, no
 * concrete system noun. Warning-only.
 */
export function detectExplanatoryBecauseCluster(prose: string): ValidatorIssue[] {
  const issues: ValidatorIssue[] = [];
  const paragraphs = prose.split(/\n\n+/);
  paragraphs.forEach((rawPara, idx) => {
    const stripped = stripDialogueForNarration(rawPara);
    // Match each "because" position independently. A single greedy regex
    // would swallow "because A and because B" as one match and lose the
    // second clause; we anchor on the word and slice the tail manually so
    // multi-`because` paragraphs stay visible to the cluster heuristic.
    const becauseRE = /\bbecause\b/gi;
    const explanatory: Array<{ phrase: string }> = [];
    let match: RegExpExecArray | null;
    while ((match = becauseRE.exec(stripped)) !== null) {
      const start = match.index + match[0].length;
      // Cap the tail at the next sentence boundary OR ~10 words, whichever is
      // shorter. Without the word cap, two `because` clauses joined by a
      // comma would share a system-noun exemption and silently cancel each
      // other out.
      const sentenceTail = stripped
        .slice(start, start + 200)
        .match(/^[^.!?;\n\u2014\u2013]*/);
      let rawTail = sentenceTail ? sentenceTail[0] : "";
      // Clip at the next `because` so each clause is evaluated independently.
      // Without this, a comma-joined sequence like "because admirals took
      // columns, because the bulkhead would not hold" would let `bulkhead`
      // exempt the earlier explanatory clause and silently swallow the hit.
      const nextBecause = rawTail.search(/\bbecause\b/i);
      if (nextBecause >= 0) rawTail = rawTail.slice(0, nextBecause);
      const tail = rawTail.split(/\s+/).slice(0, 11).join(" ");
      const result = looksExplanatoryBecause(tail);
      if (result) explanatory.push(result);
    }
    if (explanatory.length >= 2) {
      for (const hit of explanatory) {
        issues.push({
          severity: "warning",
          code: "EXPLANATORY_BECAUSE_CLUSTER",
          message:
            "Do not over-explain character motivation through narrator `because` clauses. Show the action and let context imply the reason.",
          evidence: [hit.phrase, `paragraph ${idx + 1}`],
        });
      }
    }
  });
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
