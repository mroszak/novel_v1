import path from "node:path";

import { config } from "../config.js";
import { fileExists, readText, writeJson, readJson } from "../utils/index.js";
import { createArtifact, voiceTargetArtifactPath, styleSamplePath } from "../pipeline/stage-utils.js";
import type {
  ArtifactEnvelope,
  CompiledStoryBlueprint,
  VoiceFingerprint,
  VoiceTarget,
} from "../types/index.js";

const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[A-Z"'\u201C\u2018])/;
const TOKEN_RE = /[A-Za-z][A-Za-z'\-]+/g;
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "into", "from", "have",
  "your", "their", "about", "what", "when", "where", "through", "they",
  "them", "those", "these", "there", "here", "then", "than", "such",
  "back", "over", "like", "only", "also", "very", "much", "even", "still",
  "most", "before", "after", "each", "every", "both", "being", "down",
  "some", "other", "again", "could", "would", "shall", "ought", "into",
  "around", "across", "between", "without", "within", "while", "first",
  "second", "third", "another", "however", "instead", "because", "already",
  "almost", "always", "never", "still", "least", "since", "until", "above",
]);
const DIALOGUE_TAG_RE = /\b(said|asked|whispered|muttered|replied|answered|called|shouted|murmured|stated|declared|exclaimed|insisted|noted|added|countered|pressed|warned|offered|cut|barked|hissed|sighed)\b/gi;
const SAID_RE = /\b(said|asked)\b/gi;
const INTERIOR_RE = /\b(thought|felt|wondered|knew|remembered|considered|wished|hoped|feared|noticed|imagined|recognized|realized|understood|expected|believed|doubted)\b/gi;

const SENTENCE_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: "1-6", min: 1, max: 6 },
  { label: "7-12", min: 7, max: 12 },
  { label: "13-20", min: 13, max: 20 },
  { label: "21-32", min: 21, max: 32 },
  { label: "33+", min: 33, max: Infinity },
];

function countWordsLocal(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2)
    : sorted[mid] ?? 0;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

function stdDev(values: number[], mean: number): number {
  if (values.length === 0) return 0;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function tokenize(text: string): string[] {
  return (text.match(TOKEN_RE) ?? []).map((t) => t.toLowerCase());
}

function buildSignatureLexicon(text: string, blueprintLexicon: Set<string>, max = 12): string[] {
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) {
    if (token.length < 4) continue;
    if (STOP_WORDS.has(token)) continue;
    if (blueprintLexicon.has(token)) {
      // boost author-blueprint markers
      counts.set(token, (counts.get(token) ?? 0) + 2);
      continue;
    }
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([word]) => word);
}

function buildBlueprintLexicon(blueprint: CompiledStoryBlueprint): Set<string> {
  const seeds = [
    blueprint.storyPromise.corePremise,
    blueprint.storyPromise.storyPromise,
    blueprint.storyPromise.readerPromise,
    blueprint.marketPositioning.audience,
    ...blueprint.motifBank,
    ...blueprint.styleRules,
  ].join(" ");
  const set = new Set<string>();
  for (const token of tokenize(seeds)) {
    if (token.length >= 4 && !STOP_WORDS.has(token)) {
      set.add(token);
    }
  }
  return set;
}

function extractMetaphorFamilies(text: string, blueprintMotifs: string[]): string[] {
  const lower = text.toLowerCase();
  const families: string[] = [];
  for (const motif of blueprintMotifs) {
    const head = motif.toLowerCase().split(/[,;:.\-\s]+/).filter(Boolean).slice(0, 2).join(" ");
    if (head.length >= 4 && lower.includes(head)) {
      families.push(motif);
    }
  }
  // pattern-mine simple "like X" / "as if X" similes
  const simileRe = /(?:like|as if)\s+([a-z][a-z\s]{4,30}?)(?=[.,;:\n])/gi;
  const counts = new Map<string, number>();
  let match: RegExpExecArray | null;
  while ((match = simileRe.exec(text)) !== null) {
    const phrase = (match[1] ?? "").trim().toLowerCase();
    if (phrase.length < 5) continue;
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  }
  for (const [phrase, count] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
    if (count >= 2) families.push(`like ${phrase}`);
  }
  return [...new Set(families)].slice(0, 8);
}

export function buildVoiceFingerprint(params: {
  text: string;
  blueprint: CompiledStoryBlueprint;
}): VoiceFingerprint {
  const { text, blueprint } = params;
  const sentences = text
    .split(/\n\n+/)
    .flatMap((p) => p.split(SENTENCE_SPLIT_RE))
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && countWordsLocal(s) > 0);

  const sentenceLengths = sentences.map(countWordsLocal);
  const mean = sentenceLengths.length > 0
    ? sentenceLengths.reduce((sum, n) => sum + n, 0) / sentenceLengths.length
    : 0;

  const histogram = SENTENCE_BUCKETS.map((bucket) => ({
    bucket: bucket.label,
    count: sentenceLengths.filter((n) => n >= bucket.min && n <= bucket.max).length,
  }));

  const paragraphs = text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const paragraphWords = paragraphs.map(countWordsLocal);
  const meanParagraphWords = paragraphWords.length > 0
    ? paragraphWords.reduce((sum, n) => sum + n, 0) / paragraphWords.length
    : 0;
  const shortRatio = paragraphWords.length > 0
    ? paragraphWords.filter((n) => n <= 20).length / paragraphWords.length
    : 0;
  const longRatio = paragraphWords.length > 0
    ? paragraphWords.filter((n) => n >= 120).length / paragraphWords.length
    : 0;

  const totalWords = countWordsLocal(text);
  const dialogueTags = text.match(DIALOGUE_TAG_RE) ?? [];
  const saidTags = text.match(SAID_RE) ?? [];
  const interiorMarkers = text.match(INTERIOR_RE) ?? [];

  const blueprintLexicon = buildBlueprintLexicon(blueprint);

  return {
    sentenceLength: {
      mean: Number(mean.toFixed(2)),
      stdDev: Number(stdDev(sentenceLengths, mean).toFixed(2)),
      median: median(sentenceLengths),
      p90: percentile(sentenceLengths, 90),
      histogram,
    },
    paragraphRhythm: {
      meanWords: Number(meanParagraphWords.toFixed(2)),
      medianWords: median(paragraphWords),
      shortParagraphRatio: Number(shortRatio.toFixed(3)),
      longParagraphRatio: Number(longRatio.toFixed(3)),
    },
    signatureLexicon: buildSignatureLexicon(text, blueprintLexicon),
    recurringMetaphorFamilies: extractMetaphorFamilies(text, blueprint.motifBank),
    dialogueTagConventions: {
      tagsPer1000Words: totalWords > 0
        ? Number(((dialogueTags.length / totalWords) * 1000).toFixed(2))
        : 0,
      saidShare: dialogueTags.length > 0
        ? Number((saidTags.length / dialogueTags.length).toFixed(2))
        : 0,
      variedTagShare: dialogueTags.length > 0
        ? Number(((dialogueTags.length - saidTags.length) / dialogueTags.length).toFixed(2))
        : 0,
      sampleTags: [...new Set(dialogueTags.map((t) => t.toLowerCase()))].slice(0, 8),
    },
    povInteriorityDensity: {
      interiorMarkersPer1000Words: totalWords > 0
        ? Number(((interiorMarkers.length / totalWords) * 1000).toFixed(2))
        : 0,
      sampleMarkers: [...new Set(interiorMarkers.map((m) => m.toLowerCase()))].slice(0, 8),
    },
  };
}

export function buildGuidanceLines(fingerprint: VoiceFingerprint): string[] {
  const lines: string[] = [];
  const sl = fingerprint.sentenceLength;
  if (sl.mean > 0) {
    lines.push(
      `Sentence-length target: mean ~${Math.round(sl.mean)} words (median ${sl.median}, 90th percentile ${sl.p90}). Vary deliberately.`,
    );
  }
  const pr = fingerprint.paragraphRhythm;
  if (pr.meanWords > 0) {
    lines.push(
      `Paragraph rhythm target: mean ~${Math.round(pr.meanWords)} words; ${(pr.shortParagraphRatio * 100).toFixed(0)}% short hits and ${(pr.longParagraphRatio * 100).toFixed(0)}% long passages.`,
    );
  }
  if (fingerprint.signatureLexicon.length > 0) {
    lines.push(`Signature lexicon (lean on without overusing): ${fingerprint.signatureLexicon.join(", ")}.`);
  }
  if (fingerprint.recurringMetaphorFamilies.length > 0) {
    lines.push(`Recurring metaphor families: ${fingerprint.recurringMetaphorFamilies.join("; ")}.`);
  }
  const tags = fingerprint.dialogueTagConventions;
  if (tags.tagsPer1000Words > 0) {
    lines.push(
      `Dialogue tag convention: ~${tags.tagsPer1000Words.toFixed(1)} tags per 1000 words; said-share ${(tags.saidShare * 100).toFixed(0)}%.`,
    );
  }
  const interiority = fingerprint.povInteriorityDensity;
  if (interiority.interiorMarkersPer1000Words > 0) {
    lines.push(
      `POV interiority density: ~${interiority.interiorMarkersPer1000Words.toFixed(1)} interior markers per 1000 words.`,
    );
  }
  return lines;
}

export async function loadVoiceTargetIfPresent(expected?: {
  blueprintHash?: string;
  blueprintVersion?: string;
}): Promise<ArtifactEnvelope<VoiceTarget> | null> {
  const target = voiceTargetArtifactPath();
  if (!(await fileExists(target))) {
    return null;
  }
  let artifact: ArtifactEnvelope<VoiceTarget>;
  try {
    artifact = await readJson<ArtifactEnvelope<VoiceTarget>>(target);
  } catch {
    return null;
  }

  // Soft-fail metadata validation. Phase 1 voice-target is advisory, so a
  // mismatch must NOT throw — it just means the persisted fingerprint is
  // stale relative to the current blueprint and should be ignored until the
  // next post-publish extraction overwrites it.
  if (artifact.schemaVersion !== config.artifactSchemaVersion) return null;
  if (artifact.artifactType !== "voice-target") return null;
  if (expected?.blueprintHash && artifact.blueprintHash !== expected.blueprintHash) return null;
  if (expected?.blueprintVersion && artifact.blueprintVersion !== expected.blueprintVersion) return null;
  return artifact;
}

async function readPublishedChapter(chapterNumber: number): Promise<string | null> {
  const chapterPath = path.join(config.paths.chapters, `chapter-${chapterNumber}.md`);
  if (!(await fileExists(chapterPath))) {
    return null;
  }
  return readText(chapterPath);
}

async function readStyleSampleIfPresent(): Promise<string | null> {
  const stylePath = styleSamplePath();
  if (!(await fileExists(stylePath))) {
    return null;
  }
  try {
    return await readText(stylePath);
  } catch {
    return null;
  }
}

export async function extractAndPersistVoiceTarget(params: {
  publishedThroughChapter: number;
  blueprint: CompiledStoryBlueprint;
  blueprintHash: string;
  blueprintVersion: string;
}): Promise<ArtifactEnvelope<VoiceTarget> | null> {
  const styleSample = await readStyleSampleIfPresent();
  let source: VoiceTarget["source"] = "derived";
  let derivedFromChapters: number[] = [];
  let text = "";

  if (styleSample && styleSample.trim().length > 0) {
    source = "style-sample";
    text = styleSample;
  } else {
    const recent: number[] = [];
    const latest = params.publishedThroughChapter;
    for (let n = Math.max(1, latest - 2); n <= latest; n += 1) {
      const prose = await readPublishedChapter(n);
      if (prose) {
        text += `\n\n${prose}`;
        recent.push(n);
      }
    }
    if (recent.length === 0) {
      return null;
    }
    derivedFromChapters = recent;
  }

  if (text.trim().length < 200) {
    return null;
  }

  const fingerprint = buildVoiceFingerprint({ text, blueprint: params.blueprint });
  const target: VoiceTarget = {
    source,
    derivedFromChapters,
    fingerprint,
    guidanceLines: buildGuidanceLines(fingerprint),
  };

  const artifact = createArtifact<VoiceTarget>({
    artifactType: "voice-target",
    blueprintHash: params.blueprintHash,
    blueprintVersion: params.blueprintVersion,
    data: target,
  });
  await writeJson(voiceTargetArtifactPath(), artifact);
  return artifact;
}
