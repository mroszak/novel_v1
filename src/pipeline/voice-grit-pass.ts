import { generateText as generateAnthropicText } from "../api/anthropic.js";
import { config } from "../config.js";
import type {
  ArtifactEnvelope,
  BlueprintCompilationArtifacts,
  ChapterDraft,
  ChapterPacket,
  ChapterSpec,
  DraftReview,
  GritPatch,
  GritPlan,
  GritTexture,
  SelectedChapter,
  StageUsage,
  ValidatorIssue,
  VoiceGritDiff,
  VoiceTarget,
} from "../types/index.js";
import {
  buildAllowedTermsFromPacket,
  checkDialogueTags,
  checkParagraphDistribution,
  detectFilterWords,
  detectKnowledgeLeaks,
  detectRepetition,
} from "../validators/prose-quality.js";
import { compactJson, countWords as countWordsUtil, writeJson } from "../utils/index.js";
import { judgeDraft } from "./judge-draft.js";
import { chapterArtifactPath, createArtifact } from "./stage-utils.js";

const REJUDGE_REGRESSION_TOLERANCE = 1;
const TOTAL_PATCH_CAP = 6;
const PER_SCENE_CAP = 2;
const ONCE_PER_CHAPTER_TEXTURES = new Set<GritTexture>([
  "interrupted-observation",
  "strategic-under-explanation",
]);
const VALID_TEXTURES = new Set<GritTexture>([
  "prosody-irregularity",
  "voice-tic",
  "interrupted-observation",
  "strategic-under-explanation",
  "specificity-swap",
  "asymmetric-paragraph-weight",
  "repeated-effect",
]);

interface VoiceCardLookup {
  activeTraits: Set<string>;
  dialogueHabits: Set<string>;
  taboos: Set<string>;
}

export type EffectTicCategory =
  | "bodyAnchors"
  | "rhetoricalStructures"
  | "modifierTics"
  | "sensoryTics"
  | "gestureTics"
  | "abstractionTics"
  | "balancedClauseTics";

export type EffectTicLookup = Record<EffectTicCategory, Set<string>>;

const EFFECT_TIC_CATEGORIES: EffectTicCategory[] = [
  "bodyAnchors",
  "rhetoricalStructures",
  "modifierTics",
  "sensoryTics",
  "gestureTics",
  "abstractionTics",
  "balancedClauseTics",
];

export function buildEffectTicLookup(voiceTarget: VoiceTarget | null): EffectTicLookup {
  const lookup: EffectTicLookup = {
    bodyAnchors: new Set<string>(),
    rhetoricalStructures: new Set<string>(),
    modifierTics: new Set<string>(),
    sensoryTics: new Set<string>(),
    gestureTics: new Set<string>(),
    abstractionTics: new Set<string>(),
    balancedClauseTics: new Set<string>(),
  };
  const tics = voiceTarget?.fingerprint.effectTics;
  if (!tics) return lookup;
  for (const category of EFFECT_TIC_CATEGORIES) {
    for (const entry of tics[category] ?? []) {
      lookup[category].add(entry);
    }
  }
  return lookup;
}

const TIC_SOURCE_EFFECT_RE = /^effectTics\.([A-Za-z]+):(.+)$/;

function parseEffectTicSource(
  ticSource: string,
): { category: EffectTicCategory; entry: string } | null {
  const match = TIC_SOURCE_EFFECT_RE.exec(ticSource);
  if (!match) return null;
  const category = match[1] as EffectTicCategory;
  if (!EFFECT_TIC_CATEGORIES.includes(category)) return null;
  return { category, entry: match[2]! };
}

// CRLF-safe: matches one or more blank-line separators (LF or CRLF).
const PARAGRAPH_SEP_RE = /(?:\r?\n){2,}/g;

function paragraphsOf(prose: string): string[] {
  return prose.split(PARAGRAPH_SEP_RE);
}

function isSceneBreakParagraph(paragraph: string): boolean {
  const trimmed = paragraph.trim();
  return /^[-*◆=]+$/.test(trimmed) || trimmed === "---";
}

// Walks prose recording each paragraph's actual byte offset, regardless of
// whether the separator was `\n\n`, `\r\n\r\n`, or longer. Avoids the
// fragile `paragraphEnd + 2` accounting.
interface ParagraphSpan {
  start: number;
  end: number;
  text: string;
}

function paragraphSpans(prose: string): ParagraphSpan[] {
  const spans: ParagraphSpan[] = [];
  PARAGRAPH_SEP_RE.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = PARAGRAPH_SEP_RE.exec(prose)) !== null) {
    spans.push({ start: cursor, end: match.index, text: prose.slice(cursor, match.index) });
    cursor = match.index + match[0].length;
  }
  spans.push({ start: cursor, end: prose.length, text: prose.slice(cursor) });
  return spans;
}

// A "scene" is a contiguous run of paragraphs separated by a scene-break
// paragraph (e.g. `---` or `* * *`). The whole chapter is scene 0 when no
// breaks exist. Returns the 0-based scene index that contains the given
// substring, or -1 if not found.
function sceneIndexForSpan(prose: string, originalText: string): number {
  if (!originalText) return -1;
  const idx = prose.indexOf(originalText);
  if (idx < 0) return -1;
  const spans = paragraphSpans(prose);
  let sceneIndex = 0;
  for (const span of spans) {
    if (idx >= span.start && idx < span.end) {
      return sceneIndex;
    }
    if (isSceneBreakParagraph(span.text)) {
      sceneIndex += 1;
    }
  }
  return sceneIndex;
}

function isReservedSpan(prose: string, originalText: string): boolean {
  if (!originalText) return true;
  const spans = paragraphSpans(prose);
  const idx = prose.indexOf(originalText);
  if (idx < 0) return true;

  let openingWords = 0;
  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i]!;
    const paragraph = span.text;
    if (paragraph.trim().length === 0) {
      continue;
    }
    const paragraphWords = countWordsUtil(paragraph);

    if (idx >= span.start && idx < span.end) {
      if (i === 0) return true;
      if (i === spans.length - 1) return true;
      const isShortTitleLine = paragraph.length < 80 && !/[.!?]$/.test(paragraph);
      if (isShortTitleLine) return true;
      if (openingWords + paragraphWords <= 200) return true;
      const trimmed = paragraph.replace(/\s+$/, "");
      const lastSentenceMatch = trimmed.match(/([^.!?]+[.!?])\s*$/);
      if (lastSentenceMatch) {
        const tailStart = span.start + (paragraph.length - lastSentenceMatch[0].length);
        if (idx + originalText.length > tailStart && idx < span.end) return true;
      }
      const nextParagraph = spans[i + 1]?.text.trim() ?? "";
      const isSceneBreakLeadout = /^[-*◆=]+$/.test(nextParagraph) || /^---$/.test(nextParagraph);
      if (isSceneBreakLeadout && lastSentenceMatch) {
        const tailStart = span.start + (paragraph.length - lastSentenceMatch[0].length);
        if (idx + originalText.length > tailStart) return true;
      }
      return false;
    }

    openingWords += paragraphWords;
  }
  return true;
}

function buildVoiceCardLookup(packet: ChapterPacket): VoiceCardLookup {
  const lookup: VoiceCardLookup = {
    activeTraits: new Set(),
    dialogueHabits: new Set(),
    taboos: new Set(),
  };
  for (const card of packet.rollingMemory?.activeCharacterVoiceCards ?? []) {
    for (const trait of card.activeTraits) lookup.activeTraits.add(trait);
    for (const habit of card.dialogueHabits) lookup.dialogueHabits.add(habit);
    for (const taboo of card.tabooNotes) lookup.taboos.add(taboo);
  }
  return lookup;
}

function countOccurrences(prose: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = prose.indexOf(needle, from);
    if (idx < 0) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

interface ApplyResult {
  prose: string;
  applied: GritPatch[];
  skipped: Array<GritPatch & { skipReason: string }>;
}

export function applyVoiceGritPatches(params: {
  prose: string;
  patches: GritPatch[];
  voiceCards: VoiceCardLookup;
  effectTics: EffectTicLookup;
}): ApplyResult {
  const { voiceCards, effectTics } = params;
  let working = params.prose;
  const applied: GritPatch[] = [];
  const skipped: Array<GritPatch & { skipReason: string }> = [];

  let onceUsed = new Set<GritTexture>();
  let total = 0;
  // Scene boundaries are paragraph-level (e.g. `---`) and patches don't
  // introduce new boundaries, so scene indices stay stable across applies.
  const perSceneCount = new Map<number, number>();

  for (const patch of params.patches) {
    if (!VALID_TEXTURES.has(patch.texture)) {
      skipped.push({ ...patch, skipReason: `Unknown texture: ${patch.texture}` });
      continue;
    }
    if (total >= TOTAL_PATCH_CAP) {
      skipped.push({ ...patch, skipReason: `Total patch cap (${TOTAL_PATCH_CAP}) reached.` });
      continue;
    }
    if (ONCE_PER_CHAPTER_TEXTURES.has(patch.texture) && onceUsed.has(patch.texture)) {
      skipped.push({ ...patch, skipReason: `Texture ${patch.texture} limited to one per chapter.` });
      continue;
    }
    if (!patch.originalText || !patch.replacementText) {
      skipped.push({ ...patch, skipReason: "Patch must include both originalText and replacementText." });
      continue;
    }
    if (countOccurrences(working, patch.originalText) !== 1) {
      skipped.push({ ...patch, skipReason: "originalText must appear verbatim exactly once in current prose." });
      continue;
    }
    if (isReservedSpan(working, patch.originalText)) {
      skipped.push({ ...patch, skipReason: "Patch overlaps a reserved zone (opening/ending/title/paragraph-end/scene-break leadout)." });
      continue;
    }
    const sceneIndex = sceneIndexForSpan(working, patch.originalText);
    if (sceneIndex < 0) {
      skipped.push({ ...patch, skipReason: "Could not locate originalText in any scene." });
      continue;
    }
    if ((perSceneCount.get(sceneIndex) ?? 0) >= PER_SCENE_CAP) {
      skipped.push({ ...patch, skipReason: `Per-scene cap (${PER_SCENE_CAP}) reached for scene ${sceneIndex}.` });
      continue;
    }
    if (patch.texture === "voice-tic") {
      if (!patch.ticSource || patch.ticSource.trim().length === 0) {
        skipped.push({ ...patch, skipReason: "voice-tic requires ticSource citing a real voice-card entry." });
        continue;
      }
      if (parseEffectTicSource(patch.ticSource)) {
        skipped.push({ ...patch, skipReason: "voice-tic ticSource cites an effectTics entry; must cite an activeTrait or dialogueHabit instead." });
        continue;
      }
      if (voiceCards.taboos.has(patch.ticSource)) {
        skipped.push({ ...patch, skipReason: "ticSource is from tabooNotes; voice-tic must source from activeTraits or dialogueHabits." });
        continue;
      }
      if (!voiceCards.activeTraits.has(patch.ticSource) && !voiceCards.dialogueHabits.has(patch.ticSource)) {
        skipped.push({ ...patch, skipReason: "ticSource does not match any activeTrait or dialogueHabit on the active voice cards." });
        continue;
      }
    } else if (patch.texture === "repeated-effect") {
      if (!patch.ticSource || patch.ticSource.trim().length === 0) {
        skipped.push({ ...patch, skipReason: "repeated-effect requires ticSource citing an effectTics entry." });
        continue;
      }
      const parsed = parseEffectTicSource(patch.ticSource);
      if (!parsed) {
        skipped.push({ ...patch, skipReason: "repeated-effect ticSource must follow the canonical form 'effectTics.<category>:<entry>'." });
        continue;
      }
      if (voiceCards.taboos.has(parsed.entry)) {
        skipped.push({ ...patch, skipReason: "ticSource entry is on a tabooNote; excluded for both textures." });
        continue;
      }
      if (!effectTics[parsed.category].has(parsed.entry)) {
        skipped.push({ ...patch, skipReason: `repeated-effect ticSource entry is not present in effectTics.${parsed.category}.` });
        continue;
      }
    }

    working = working.replace(patch.originalText, patch.replacementText);
    applied.push(patch);
    if (ONCE_PER_CHAPTER_TEXTURES.has(patch.texture)) onceUsed.add(patch.texture);
    perSceneCount.set(sceneIndex, (perSceneCount.get(sceneIndex) ?? 0) + 1);
    total += 1;
  }

  return { prose: working, applied, skipped };
}

const gritPlanSchema = {
  type: "object",
  properties: {
    patches: {
      type: "array",
      maxItems: TOTAL_PATCH_CAP,
      items: {
        type: "object",
        properties: {
          texture: { type: "string", enum: Array.from(VALID_TEXTURES) },
          originalText: { type: "string", minLength: 1 },
          replacementText: { type: "string", minLength: 1 },
          earnedJustification: { type: "string", minLength: 1 },
          ticSource: { type: "string" },
        },
        required: ["texture", "originalText", "replacementText", "earnedJustification"],
        additionalProperties: false,
      },
    },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["patches", "notes"],
  additionalProperties: false,
} as const;

function tryParseGritPlanText(raw: string): GritPlan | null {
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end < 0) return null;
    const json = raw.slice(start, end + 1);
    const parsed = JSON.parse(json) as GritPlan;
    if (!Array.isArray(parsed.patches)) return null;
    return { patches: parsed.patches, notes: Array.isArray(parsed.notes) ? parsed.notes : [] };
  } catch {
    return null;
  }
}

function runProseValidators(packet: ChapterPacket, prose: string): ValidatorIssue[] {
  const knowledgeMatrix = packet.rollingMemory?.knowledgeMatrix ?? [];
  const allowedTerms = buildAllowedTermsFromPacket(packet);
  return [
    ...detectRepetition(prose, { allowedTerms }),
    ...detectFilterWords(prose),
    ...checkParagraphDistribution(prose),
    ...checkDialogueTags(prose),
    ...detectKnowledgeLeaks(prose, knowledgeMatrix),
  ];
}

export interface VoiceGritResult {
  selectedArtifact: ArtifactEnvelope<SelectedChapter>;
  selectedReviewArtifact: ArtifactEnvelope<DraftReview>;
  diff: VoiceGritDiff;
  planArtifact: ArtifactEnvelope<GritPlan> | null;
  rejudgeArtifact: ArtifactEnvelope<DraftReview> | null;
  usages: Array<{ stage: string; usage: StageUsage }>;
}

async function persistDiff(params: {
  chapterNumber: number;
  blueprintHash: string;
  blueprintVersion: string;
  diff: VoiceGritDiff;
}): Promise<ArtifactEnvelope<VoiceGritDiff>> {
  const artifact = createArtifact<VoiceGritDiff>({
    artifactType: "voice-grit-applied",
    blueprintHash: params.blueprintHash,
    blueprintVersion: params.blueprintVersion,
    chapterNumber: params.chapterNumber,
    data: params.diff,
  });
  await writeJson(chapterArtifactPath(params.chapterNumber, "voice-grit-applied"), artifact);
  return artifact;
}

export async function runVoiceGritPass(params: {
  packetArtifact: ArtifactEnvelope<ChapterPacket>;
  approvedSpecArtifact: ArtifactEnvelope<ChapterSpec>;
  selectedArtifact: ArtifactEnvelope<SelectedChapter>;
  selectedReviewArtifact: ArtifactEnvelope<DraftReview>;
  voiceTarget: VoiceTarget | null;
  blueprintArtifacts: BlueprintCompilationArtifacts;
  smoke: boolean;
}): Promise<VoiceGritResult> {
  const usages: Array<{ stage: string; usage: StageUsage }> = [];
  const preProse = params.selectedArtifact.data.prose;
  const preReviewScore = params.selectedReviewArtifact.data.overallScore;
  const chapterNumber = params.packetArtifact.chapterNumber ?? params.packetArtifact.data.chapterNumber;
  const blueprintHash = params.packetArtifact.blueprintHash;
  const blueprintVersion = params.packetArtifact.blueprintVersion;
  const writeDiff = (diff: VoiceGritDiff) => persistDiff({
    chapterNumber: chapterNumber!,
    blueprintHash,
    blueprintVersion,
    diff,
  });

  const baseDiff: VoiceGritDiff = {
    status: "skipped",
    reason: "Voice-grit skipped.",
    appliedPatches: [],
    skippedPatches: [],
    preReviewScore,
    postReviewScore: null,
    preProse,
    finalProse: preProse,
  };

  if (!params.voiceTarget) {
    const diff: VoiceGritDiff = { ...baseDiff, reason: "No voice-target available; downstream uses selected unchanged." };
    await writeDiff(diff);
    return {
      selectedArtifact: params.selectedArtifact,
      selectedReviewArtifact: params.selectedReviewArtifact,
      diff,
      planArtifact: null,
      rejudgeArtifact: null,
      usages,
    };
  }

  let plan: GritPlan = { patches: [], notes: [] };
  if (!params.smoke) {
    try {
      const packet = params.packetArtifact.data;
      const voiceCards = packet.rollingMemory?.activeCharacterVoiceCards ?? [];
      const result = await generateAnthropicText({
        stage: config.stageProfiles.voiceGritPlan,
        system: [
          "You are the voice-grit planner for a chapter-by-chapter novel engine.",
          "Output a JSON object: { \"patches\": [...], \"notes\": [...] }. No prose, no commentary.",
          `Allowed textures: ${Array.from(VALID_TEXTURES).join(", ")}.`,
          `Total patches: 0-${TOTAL_PATCH_CAP}. Empty is a valid answer.`,
          `Per-scene cap: at most ${PER_SCENE_CAP} patches per scene (scenes are separated by scene-break paragraphs like '---' or '* * *'). Spread patches across multiple scenes; the validator will silently drop the 3rd-and-later patch in any single scene.`,
          "Each originalText must appear verbatim exactly once in the chapter prose.",
          "Reserved zones BLOCKED: chapter opening (~200 words), chapter ending (last paragraph), chapter title, paragraph-end sentences, scene-break leadout sentences.",
          "voice-tic patches REQUIRE a ticSource citing a real activeTrait or dialogueHabit (NOT a tabooNote).",
          "repeated-effect patches REQUIRE a ticSource in the canonical form 'effectTics.<category>:<entry>' (no quotes, no whitespace, exact match against the KNOWN EFFECT TICS lookup). Tabooed entries excluded.",
          "Detect repeated effects in addition to repeated words. For each repeated body anchor, gesture, rhetorical structure, modifier tic, sensory beat, abstraction tic, or balanced-clause turn, classify it as KEEP (intentional motif that escalates or changes meaning), VARY (useful effect but the phrasing or gesture repeats too closely), or CUT (duplicate effect that adds no new pressure, character, or information). Only emit a `repeated-effect` patch for VARY or CUT — KEEP is recorded in `earnedJustification` only. Do not flatten intentional motifs. The goal is to prevent the chapter from sounding uniformly polished or generated, not to remove all repetition.",
          "interrupted-observation: max one per chapter. strategic-under-explanation: max one per chapter.",
          "Do not change plot, world facts, or character knowledge. Do not introduce typos or grammatical errors.",
        ].join("\n"),
        prompt: [
          "<voice_target>",
          compactJson({
            source: params.voiceTarget.source,
            guidanceLines: params.voiceTarget.guidanceLines,
          }),
          "</voice_target>",
          "<known_effect_tics>",
          compactJson(params.voiceTarget.fingerprint.effectTics),
          "</known_effect_tics>",
          "<voice_cards>",
          compactJson(voiceCards.map((card) => ({
            character: card.character,
            activeTraits: card.activeTraits,
            dialogueHabits: card.dialogueHabits,
            tabooNotes: card.tabooNotes,
          }))),
          "</voice_cards>",
          "<chapter_prose>",
          preProse,
          "</chapter_prose>",
          "Generate the voice-grit plan now. Use the JSON shape above.",
          `Schema: ${JSON.stringify(gritPlanSchema)}`,
        ].join("\n\n"),
      });
      const parsed = tryParseGritPlanText(result.value);
      if (parsed) plan = parsed;
      if (result.usage) usages.push({ stage: config.stageProfiles.voiceGritPlan.stageName, usage: result.usage });
    } catch (error) {
      const diff: VoiceGritDiff = {
        ...baseDiff,
        status: "skipped",
        reason: `voice-grit-plan failed: ${(error as Error).message}`,
      };
      await writeDiff(diff);
      return {
        selectedArtifact: params.selectedArtifact,
        selectedReviewArtifact: params.selectedReviewArtifact,
        diff,
        planArtifact: null,
        rejudgeArtifact: null,
        usages,
      };
    }
  }

  const planArtifact = createArtifact<GritPlan>({
    artifactType: "voice-grit-plan",
    blueprintHash: params.packetArtifact.blueprintHash,
    blueprintVersion: params.packetArtifact.blueprintVersion,
    chapterNumber,
    data: plan,
  });
  await writeJson(chapterArtifactPath(chapterNumber!, "voice-grit-plan"), planArtifact);

  if (plan.patches.length === 0) {
    const diff: VoiceGritDiff = {
      ...baseDiff,
      status: "no-patches",
      reason: "Plan returned 0 patches; downstream uses selected unchanged.",
    };
    await writeDiff(diff);
    return {
      selectedArtifact: params.selectedArtifact,
      selectedReviewArtifact: params.selectedReviewArtifact,
      diff,
      planArtifact,
      rejudgeArtifact: null,
      usages,
    };
  }

  const apply = applyVoiceGritPatches({
    prose: preProse,
    patches: plan.patches,
    voiceCards: buildVoiceCardLookup(params.packetArtifact.data),
    effectTics: buildEffectTicLookup(params.voiceTarget),
  });

  if (apply.applied.length === 0) {
    const diff: VoiceGritDiff = {
      ...baseDiff,
      status: "skipped",
      reason: "All patches rejected by validator.",
      appliedPatches: [],
      skippedPatches: apply.skipped,
    };
    await writeDiff(diff);
    return {
      selectedArtifact: params.selectedArtifact,
      selectedReviewArtifact: params.selectedReviewArtifact,
      diff,
      planArtifact,
      rejudgeArtifact: null,
      usages,
    };
  }

  const validatorIssues = runProseValidators(params.packetArtifact.data, apply.prose);
  if (validatorIssues.some((issue) => issue.severity === "error")) {
    const diff: VoiceGritDiff = {
      ...baseDiff,
      status: "validators-failed",
      reason: `Patched prose failed validators: ${validatorIssues.filter((i) => i.severity === "error").map((i) => i.code).join(", ")}`,
      appliedPatches: apply.applied,
      skippedPatches: apply.skipped,
    };
    await writeDiff(diff);
    return {
      selectedArtifact: params.selectedArtifact,
      selectedReviewArtifact: params.selectedReviewArtifact,
      diff,
      planArtifact,
      rejudgeArtifact: null,
      usages,
    };
  }

  const wordCount = countWordsUtil(apply.prose);
  const draftForRejudge = createArtifact<ChapterDraft>({
    artifactType: "voice-grit-rejudge-draft",
    blueprintHash: params.selectedArtifact.blueprintHash,
    blueprintVersion: params.selectedArtifact.blueprintVersion,
    chapterNumber: params.selectedArtifact.chapterNumber,
    data: { prose: apply.prose, wordCount },
  });

  const rejudgeArtifact = await judgeDraft({
    candidateId: params.selectedArtifact.data.winner,
    packetArtifact: params.packetArtifact,
    approvedSpecArtifact: params.approvedSpecArtifact,
    draftArtifact: draftForRejudge,
    blueprintArtifacts: params.blueprintArtifacts,
    smoke: params.smoke,
    stageOverride: config.stageProfiles.voiceGritRejudge,
    artifactType: "voice-grit-rejudge",
    persistArtifact: false,
  });
  await writeJson(chapterArtifactPath(chapterNumber!, "voice-grit-rejudge"), rejudgeArtifact);
  if (rejudgeArtifact.usage) {
    usages.push({ stage: config.stageProfiles.voiceGritRejudge.stageName, usage: rejudgeArtifact.usage });
  }

  const postReviewScore = rejudgeArtifact.data.overallScore;
  const regressed = postReviewScore < preReviewScore - REJUDGE_REGRESSION_TOLERANCE
    || rejudgeArtifact.data.blockingIssues.length > 0
    || rejudgeArtifact.data.issues.some((issue) => issue.severity === "error");

  if (regressed) {
    const diff: VoiceGritDiff = {
      ...baseDiff,
      status: "rejudge-regressed",
      reason: `Voice-grit re-judge regressed: pre=${preReviewScore} post=${postReviewScore} blocking=${rejudgeArtifact.data.blockingIssues.length}`,
      appliedPatches: apply.applied,
      skippedPatches: apply.skipped,
      postReviewScore,
      finalProse: preProse,
    };
    await writeDiff(diff);
    return {
      selectedArtifact: params.selectedArtifact,
      selectedReviewArtifact: params.selectedReviewArtifact,
      diff,
      planArtifact,
      rejudgeArtifact,
      usages,
    };
  }

  const updatedSelected: ArtifactEnvelope<SelectedChapter> = {
    ...params.selectedArtifact,
    createdAt: new Date().toISOString(),
    data: {
      ...params.selectedArtifact.data,
      prose: apply.prose,
      wordCount,
      review: rejudgeArtifact.data,
    },
  };
  const updatedReview = { ...rejudgeArtifact };
  await writeJson(chapterArtifactPath(chapterNumber!, "selected"), updatedSelected);
  await writeJson(chapterArtifactPath(chapterNumber!, "review"), updatedReview);

  const diff: VoiceGritDiff = {
    ...baseDiff,
    status: "applied",
    reason: `Applied ${apply.applied.length} voice-grit patch(es).`,
    appliedPatches: apply.applied,
    skippedPatches: apply.skipped,
    postReviewScore,
    finalProse: apply.prose,
  };
  await writeDiff(diff);

  return {
    selectedArtifact: updatedSelected,
    selectedReviewArtifact: updatedReview,
    diff,
    planArtifact,
    rejudgeArtifact,
    usages,
  };
}
