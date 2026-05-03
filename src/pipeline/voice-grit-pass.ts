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
]);

interface VoiceCardLookup {
  activeTraits: Set<string>;
  dialogueHabits: Set<string>;
  taboos: Set<string>;
}

function paragraphsOf(prose: string): string[] {
  return prose.split(/\n\n+/);
}

function isReservedSpan(prose: string, originalText: string): boolean {
  if (!originalText) return true;
  const paragraphs = paragraphsOf(prose);
  const idx = prose.indexOf(originalText);
  if (idx < 0) return true;

  let runningStart = 0;
  let openingWords = 0;
  for (let i = 0; i < paragraphs.length; i += 1) {
    const paragraph = paragraphs[i] ?? "";
    if (paragraph.trim().length === 0) {
      runningStart += paragraph.length + 2;
      continue;
    }
    const paragraphWords = countWordsUtil(paragraph);
    const paragraphStart = runningStart;
    const paragraphEnd = paragraphStart + paragraph.length;

    if (idx >= paragraphStart && idx < paragraphEnd) {
      if (i === 0) return true;
      if (i === paragraphs.length - 1) return true;
      const isShortTitleLine = paragraph.length < 80 && !/[.!?]$/.test(paragraph);
      if (isShortTitleLine) return true;
      if (openingWords + paragraphWords <= 200) return true;
      const trimmed = paragraph.replace(/\s+$/, "");
      const lastSentenceMatch = trimmed.match(/([^.!?]+[.!?])\s*$/);
      if (lastSentenceMatch) {
        const tailStart = paragraphStart + (paragraph.length - lastSentenceMatch[0].length);
        const tailEnd = paragraphStart + paragraph.length;
        if (idx + originalText.length > tailStart && idx < tailEnd) return true;
      }
      const nextParagraph = paragraphs[i + 1]?.trim() ?? "";
      const isSceneBreakLeadout = /^[-*◆=]+$/.test(nextParagraph) || /^---$/.test(nextParagraph);
      if (isSceneBreakLeadout && lastSentenceMatch) {
        const tailStart = paragraphStart + (paragraph.length - lastSentenceMatch[0].length);
        if (idx + originalText.length > tailStart) return true;
      }
      return false;
    }

    runningStart = paragraphEnd + 2;
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
}): ApplyResult {
  const { voiceCards } = params;
  let working = params.prose;
  const applied: GritPatch[] = [];
  const skipped: Array<GritPatch & { skipReason: string }> = [];

  let onceUsed = new Set<GritTexture>();
  let total = 0;

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
    if (patch.texture === "voice-tic") {
      if (!patch.ticSource || patch.ticSource.trim().length === 0) {
        skipped.push({ ...patch, skipReason: "voice-tic requires ticSource citing a real voice-card entry." });
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
    }

    working = working.replace(patch.originalText, patch.replacementText);
    applied.push(patch);
    if (ONCE_PER_CHAPTER_TEXTURES.has(patch.texture)) onceUsed.add(patch.texture);
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
  return [
    ...detectRepetition(prose),
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

async function persistDiff(chapterNumber: number, diff: VoiceGritDiff): Promise<ArtifactEnvelope<VoiceGritDiff>> {
  const artifact = createArtifact<VoiceGritDiff>({
    artifactType: "voice-grit-applied",
    blueprintHash: "",
    blueprintVersion: "",
    chapterNumber,
    data: diff,
  });
  await writeJson(chapterArtifactPath(chapterNumber, "voice-grit-applied"), artifact);
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
    await persistDiff(chapterNumber!, diff);
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
          "Total patches: 0-6. Empty is a valid answer.",
          "Each originalText must appear verbatim exactly once in the chapter prose.",
          "Reserved zones BLOCKED: chapter opening (~200 words), chapter ending (last paragraph), chapter title, paragraph-end sentences, scene-break leadout sentences.",
          "voice-tic patches REQUIRE a ticSource citing a real activeTrait or dialogueHabit (NOT a tabooNote).",
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
          "<voice_cards>",
          compactJson(voiceCards.map((card) => ({
            character: card.character,
            activeTraits: card.activeTraits,
            dialogueHabits: card.dialogueHabits,
            tabooNotes: card.tabooNotes,
          }))),
          "</voice_cards>",
          "<taboo_constraints>",
          compactJson(voiceCards.flatMap((card) => card.tabooNotes)),
          "</taboo_constraints>",
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
      await persistDiff(chapterNumber!, diff);
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
    await persistDiff(chapterNumber!, diff);
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
  });

  if (apply.applied.length === 0) {
    const diff: VoiceGritDiff = {
      ...baseDiff,
      status: "skipped",
      reason: "All patches rejected by validator.",
      appliedPatches: [],
      skippedPatches: apply.skipped,
    };
    await persistDiff(chapterNumber!, diff);
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
    await persistDiff(chapterNumber!, diff);
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
    await persistDiff(chapterNumber!, diff);
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
  await persistDiff(chapterNumber!, diff);

  return {
    selectedArtifact: updatedSelected,
    selectedReviewArtifact: updatedReview,
    diff,
    planArtifact,
    rejudgeArtifact,
    usages,
  };
}
