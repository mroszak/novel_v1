import { generateText as generateAnthropicText } from "../api/anthropic.js";
import { config } from "../config.js";
import type {
  ArtifactEnvelope,
  BlueprintCompilationArtifacts,
  ChapterDraft,
  ChapterPacket,
  ChapterSpec,
  DraftReview,
  PolishDiff,
  PolishPatch,
  PolishPlan,
  PolishedSelected,
  SelectedChapter,
  StageUsage,
  ValidatorIssue,
  VoiceTarget,
} from "../types/index.js";
import {
  checkDialogueTags,
  checkParagraphDistribution,
  detectFilterWords,
  detectKnowledgeLeaks,
  detectRepetition,
} from "../validators/prose-quality.js";
import { countWords as countWordsUtil, writeJson } from "../utils/index.js";
import { judgeDraft } from "./judge-draft.js";
import { chapterArtifactPath, createArtifact } from "./stage-utils.js";

export const DEFAULT_POLISH_CONFIDENCE_THRESHOLD = 0.7;
const DEFAULT_REJUDGE_REGRESSION_TOLERANCE = 2;

const polishPlanSchema = {
  type: "object",
  properties: {
    patches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          zone: {
            type: "string",
            enum: ["paragraph-end", "scene-break-leadout"],
          },
          paragraphIndex: { type: "integer", minimum: 0 },
          originalText: { type: "string", minLength: 1 },
          proposedText: { type: "string", minLength: 1 },
          rationale: { type: "string", minLength: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: [
          "zone",
          "paragraphIndex",
          "originalText",
          "proposedText",
          "rationale",
          "confidence",
        ],
        additionalProperties: false,
      },
    },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["patches", "notes"],
  additionalProperties: false,
} as const;

interface ZoneInfo {
  paragraphIndex: number;
  zone: "paragraph-end" | "scene-break-leadout";
  lastSentence: string;
}

const SCENE_BREAK_PATTERN = /^[\s]*(?:[-—_*◆◇#]{3,}|---)[\s]*$/;

function isSceneBreakParagraph(paragraph: string): boolean {
  return SCENE_BREAK_PATTERN.test(paragraph.trim());
}

function isOpeningProtectedZone(paragraphIndex: number, paragraphs: string[]): boolean {
  // Protect chapter opening: first paragraph is always protected.
  if (paragraphIndex === 0) return true;
  // Also protect the second paragraph if the first is a title-like single line.
  if (paragraphIndex === 1) {
    const first = paragraphs[0]?.trim() ?? "";
    if (first.length < 80 && !/[.!?]$/.test(first)) return true;
  }
  // Protect early-chapter zone if it falls within the first ~200 words
  let cumulative = 0;
  for (let i = 0; i < paragraphIndex; i += 1) {
    cumulative += countWordsUtil(paragraphs[i] ?? "");
    if (cumulative >= 200) return false;
  }
  return cumulative < 200;
}

function isEndingProtectedZone(paragraphIndex: number, paragraphs: string[]): boolean {
  return paragraphIndex === paragraphs.length - 1;
}

function lastSentenceOf(paragraph: string): string {
  const trimmed = paragraph.trim();
  if (trimmed.length === 0) return "";
  const sentences = trimmed.split(/(?<=[.!?])\s+(?=[A-Z"'\u201C\u2018])/).filter(Boolean);
  return sentences[sentences.length - 1]?.trim() ?? trimmed;
}

export function collectPolishZones(prose: string): ZoneInfo[] {
  const paragraphs = prose.split(/\n\n+/);
  const zones: ZoneInfo[] = [];
  for (let i = 0; i < paragraphs.length; i += 1) {
    const paragraph = paragraphs[i] ?? "";
    if (paragraph.trim().length === 0) continue;
    if (isSceneBreakParagraph(paragraph)) continue;
    if (isOpeningProtectedZone(i, paragraphs)) continue;
    if (isEndingProtectedZone(i, paragraphs)) continue;

    const nextParagraph = paragraphs[i + 1] ?? "";
    const isSceneBreakLeadOut = nextParagraph.trim().length > 0
      && isSceneBreakParagraph(nextParagraph);

    const wordsInParagraph = countWordsUtil(paragraph);
    if (wordsInParagraph < 12) continue;

    zones.push({
      paragraphIndex: i,
      zone: isSceneBreakLeadOut ? "scene-break-leadout" : "paragraph-end",
      lastSentence: lastSentenceOf(paragraph),
    });
  }
  return zones;
}

function paragraphIsAllowedZone(
  paragraphIndex: number,
  paragraphs: string[],
  zone: "paragraph-end" | "scene-break-leadout",
): boolean {
  if (paragraphIndex < 0 || paragraphIndex >= paragraphs.length) return false;
  const paragraph = paragraphs[paragraphIndex] ?? "";
  if (paragraph.trim().length === 0) return false;
  if (isSceneBreakParagraph(paragraph)) return false;
  if (isOpeningProtectedZone(paragraphIndex, paragraphs)) return false;
  if (isEndingProtectedZone(paragraphIndex, paragraphs)) return false;

  if (zone === "scene-break-leadout") {
    const next = paragraphs[paragraphIndex + 1] ?? "";
    return next.trim().length > 0 && isSceneBreakParagraph(next);
  }
  return true;
}

interface ApplyResult {
  prose: string;
  applied: PolishPatch[];
  skipped: Array<PolishPatch & { skipReason: string }>;
}

export function applyPolishPatches(params: {
  prose: string;
  patches: PolishPatch[];
  confidenceThreshold?: number;
}): ApplyResult {
  const threshold = params.confidenceThreshold ?? DEFAULT_POLISH_CONFIDENCE_THRESHOLD;
  const paragraphs = params.prose.split(/\n\n+/);
  const applied: PolishPatch[] = [];
  const skipped: Array<PolishPatch & { skipReason: string }> = [];

  // Apply patches in reverse paragraph order to keep indices stable
  const sortedPatches = [...params.patches].sort((a, b) => b.paragraphIndex - a.paragraphIndex);

  for (const patch of sortedPatches) {
    if (patch.confidence < threshold) {
      skipped.push({ ...patch, skipReason: `confidence ${patch.confidence} below threshold ${threshold}` });
      continue;
    }
    if (!paragraphIsAllowedZone(patch.paragraphIndex, paragraphs, patch.zone)) {
      skipped.push({ ...patch, skipReason: "zone is protected or unavailable" });
      continue;
    }
    const paragraph = paragraphs[patch.paragraphIndex] ?? "";
    const originalSnippet = patch.originalText.trim();
    if (originalSnippet.length === 0) {
      skipped.push({ ...patch, skipReason: "originalText was empty" });
      continue;
    }
    const proposed = patch.proposedText.trim();
    if (proposed.length === 0) {
      skipped.push({ ...patch, skipReason: "proposedText was empty" });
      continue;
    }
    // Polish v1 owns paragraph-end and scene-break-leadout zones only.
    // Both zones target the LAST sentence of the paragraph, so the patch's
    // originalText must end the paragraph (after trimming trailing whitespace).
    // This rejects mid-paragraph rewrites that would silently sneak through.
    const trimmedRight = paragraph.replace(/\s+$/, "");
    const trailingWS = paragraph.slice(trimmedRight.length);
    if (!trimmedRight.endsWith(originalSnippet)) {
      skipped.push({ ...patch, skipReason: "originalText does not match the paragraph's ending sentence" });
      continue;
    }
    paragraphs[patch.paragraphIndex] = trimmedRight.slice(0, trimmedRight.length - originalSnippet.length)
      + proposed
      + trailingWS;
    applied.push(patch);
  }

  return {
    prose: paragraphs.join("\n\n"),
    applied: applied.reverse(),
    skipped,
  };
}

function summarizeZones(zones: ZoneInfo[]): string {
  return zones
    .map((zone) => {
      const label = zone.zone === "scene-break-leadout" ? "lead-out" : "paragraph-end";
      const excerpt = zone.lastSentence.slice(0, 160);
      return `#${zone.paragraphIndex} (${label}) :: ${excerpt}`;
    })
    .join("\n");
}

interface RunPolishPlanResult {
  plan: PolishPlan;
  usage?: StageUsage;
}

async function runPolishPlan(params: {
  packet: ChapterPacket;
  selected: SelectedChapter;
  voiceTarget: VoiceTarget | null;
  zones: ZoneInfo[];
  blueprintArtifacts: BlueprintCompilationArtifacts;
  smoke: boolean;
}): Promise<RunPolishPlanResult> {
  if (params.zones.length === 0 || params.smoke) {
    return { plan: { patches: [], notes: ["Polish plan skipped: no eligible zones or smoke mode."] } };
  }

  const storyCore = params.blueprintArtifacts.compiledBlueprint.data;
  const voiceLines = params.voiceTarget?.guidanceLines ?? [];

  const system = [
    "You are Opus running a surgical post-selection polish on already-strong novel prose.",
    "Touch only the requested zones (mid-chapter paragraph-end sentences and scene-break lead-out sentences).",
    "Never rewrite chapter openings, endings, titles, scene-break markers, or full paragraphs.",
    "Each patch must keep the same factual content and POV; only sharpen rhythm, image quality, and exit weight.",
    "Output strict JSON matching the requested schema. If a zone is already strong, leave it alone.",
    "Confidence must reflect editorial certainty: ≥0.7 means safe to ship; <0.7 means leave the original.",
  ].join("\n");

  const prompt = [
    "<voice_target>",
    voiceLines.length > 0 ? voiceLines.join("\n") : "No voice fingerprint yet — match the existing chapter rhythm.",
    "</voice_target>",
    "<style_rules>",
    storyCore.styleRules.join("\n") || "None",
    "</style_rules>",
    "<anti_patterns>",
    storyCore.antiPatterns.join("\n") || "None",
    "</anti_patterns>",
    "<motifs>",
    storyCore.motifBank.join("\n") || "None",
    "</motifs>",
    "<eligible_zones>",
    summarizeZones(params.zones),
    "</eligible_zones>",
    "<current_prose>",
    params.selected.prose,
    "</current_prose>",
    "Return JSON of the form: { \"patches\": [{ \"zone\", \"paragraphIndex\", \"originalText\", \"proposedText\", \"rationale\", \"confidence\" }, ...], \"notes\": [...] }",
  ].join("\n\n");

  const result = await generateAnthropicText({
    stage: config.stageProfiles.polishPlan,
    system,
    prompt,
  });

  let parsed: PolishPlan;
  try {
    parsed = parsePolishPlanText(result.value);
  } catch {
    return {
      plan: { patches: [], notes: ["Polish plan returned unparseable JSON; skipping apply."] },
      usage: result.usage,
    };
  }

  return { plan: parsed, usage: result.usage };
}

function parsePolishPlanText(raw: string): PolishPlan {
  const trimmed = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("polish-plan: no JSON object detected");
    json = JSON.parse(match[0]);
  }

  if (!json || typeof json !== "object") {
    throw new Error("polish-plan: response was not a JSON object");
  }
  const obj = json as Record<string, unknown>;
  const rawPatches = Array.isArray(obj.patches) ? obj.patches : [];
  const patches: PolishPatch[] = [];
  for (const candidate of rawPatches) {
    if (!candidate || typeof candidate !== "object") continue;
    const p = candidate as Record<string, unknown>;
    const zone = typeof p.zone === "string" && (p.zone === "paragraph-end" || p.zone === "scene-break-leadout")
      ? p.zone
      : null;
    const paragraphIndex = typeof p.paragraphIndex === "number" && Number.isFinite(p.paragraphIndex)
      ? Math.max(0, Math.floor(p.paragraphIndex))
      : null;
    const originalText = typeof p.originalText === "string" ? p.originalText : null;
    const proposedText = typeof p.proposedText === "string" ? p.proposedText : null;
    const rationale = typeof p.rationale === "string" ? p.rationale : null;
    const confidence = typeof p.confidence === "number" ? Math.max(0, Math.min(1, p.confidence)) : null;
    if (
      zone !== null
      && paragraphIndex !== null
      && originalText !== null
      && proposedText !== null
      && rationale !== null
      && confidence !== null
    ) {
      patches.push({
        zone,
        paragraphIndex,
        originalText: originalText.trim(),
        proposedText: proposedText.trim(),
        rationale: rationale.trim(),
        confidence,
      });
    }
  }
  const notes = Array.isArray(obj.notes)
    ? obj.notes.filter((n): n is string => typeof n === "string")
    : [];
  return { patches, notes };
}

async function buildPolishedSelectedArtifact(params: {
  selectedArtifact: ArtifactEnvelope<SelectedChapter>;
  polished: PolishedSelected;
  artifactType: string;
}): Promise<ArtifactEnvelope<PolishedSelected>> {
  return createArtifact<PolishedSelected>({
    artifactType: params.artifactType,
    blueprintHash: params.selectedArtifact.blueprintHash,
    blueprintVersion: params.selectedArtifact.blueprintVersion,
    chapterNumber: params.selectedArtifact.chapterNumber,
    qualityProfile: params.selectedArtifact.qualityProfile,
    data: params.polished,
  });
}

interface RunPolishPassParams {
  packetArtifact: ArtifactEnvelope<ChapterPacket>;
  approvedSpecArtifact: ArtifactEnvelope<ChapterSpec>;
  selectedArtifact: ArtifactEnvelope<SelectedChapter>;
  selectedReviewArtifact: ArtifactEnvelope<DraftReview>;
  voiceTarget: VoiceTarget | null;
  blueprintArtifacts: BlueprintCompilationArtifacts;
  smoke: boolean;
}

function runPolishProseValidators(params: {
  packet: ChapterPacket;
  prose: string;
}): ValidatorIssue[] {
  const issues: ValidatorIssue[] = [];
  const wordCount = countWordsUtil(params.prose);
  if (wordCount < params.packet.targetWordBand.min || wordCount > params.packet.targetWordBand.max) {
    issues.push({
      severity: "error",
      code: "WORD_BAND",
      message: `Polished word count ${wordCount} falls outside target band ${params.packet.targetWordBand.min}-${params.packet.targetWordBand.max}.`,
      evidence: [String(wordCount)],
    });
  }

  const knowledgeMatrix = params.packet.rollingMemory?.knowledgeMatrix ?? [];
  issues.push(
    ...detectRepetition(params.prose),
    ...detectFilterWords(params.prose),
    ...checkParagraphDistribution(params.prose),
    ...checkDialogueTags(params.prose),
    ...detectKnowledgeLeaks(params.prose, knowledgeMatrix),
  );
  return issues;
}

export interface PolishPassResult {
  selectedArtifact: ArtifactEnvelope<SelectedChapter>;
  selectedReviewArtifact: ArtifactEnvelope<DraftReview>;
  diff: PolishDiff;
  planArtifact: ArtifactEnvelope<PolishPlan> | null;
  polishedArtifact: ArtifactEnvelope<PolishedSelected> | null;
  rejudgeArtifact: ArtifactEnvelope<DraftReview> | null;
  usages: Array<{ stage: string; usage: StageUsage }>;
}

export async function runPolishPass(params: RunPolishPassParams): Promise<PolishPassResult> {
  const usages: Array<{ stage: string; usage: StageUsage }> = [];
  const preProse = params.selectedArtifact.data.prose;
  const preReviewScore = params.selectedReviewArtifact.data.overallScore;

  const baseDiff: PolishDiff = {
    status: "skipped",
    reason: "Polish pass skipped.",
    appliedPatches: [],
    skippedPatches: [],
    preReviewScore,
    postReviewScore: null,
    preProse,
    polishedProse: preProse,
    finalProse: preProse,
  };

  const noChange: PolishPassResult = {
    selectedArtifact: params.selectedArtifact,
    selectedReviewArtifact: params.selectedReviewArtifact,
    diff: baseDiff,
    planArtifact: null,
    polishedArtifact: null,
    rejudgeArtifact: null,
    usages,
  };

  const zones = collectPolishZones(preProse);
  if (zones.length === 0) {
    const diff = { ...baseDiff, status: "no-patches" as const, reason: "No eligible mid-chapter zones." };
    await writeJson(chapterArtifactPath(params.packetArtifact.data.chapterNumber, "polish-diff"), wrapDiff(params, diff));
    return { ...noChange, diff };
  }

  let planArtifact: ArtifactEnvelope<PolishPlan> | null = null;
  let polishedArtifact: ArtifactEnvelope<PolishedSelected> | null = null;
  let rejudgeArtifact: ArtifactEnvelope<DraftReview> | null = null;

  try {
    const planResult = await runPolishPlan({
      packet: params.packetArtifact.data,
      selected: params.selectedArtifact.data,
      voiceTarget: params.voiceTarget,
      zones,
      blueprintArtifacts: params.blueprintArtifacts,
      smoke: params.smoke,
    });
    planArtifact = createArtifact<PolishPlan>({
      artifactType: "polish-plan",
      blueprintHash: params.packetArtifact.blueprintHash,
      blueprintVersion: params.packetArtifact.blueprintVersion,
      chapterNumber: params.packetArtifact.chapterNumber,
      qualityProfile: params.packetArtifact.qualityProfile,
      data: planResult.plan,
      usage: planResult.usage,
    });
    if (planResult.usage) {
      usages.push({ stage: config.stageProfiles.polishPlan.stageName, usage: planResult.usage });
    }
    await writeJson(
      chapterArtifactPath(params.packetArtifact.data.chapterNumber, "polish-plan"),
      planArtifact,
    );

    if (planResult.plan.patches.length === 0) {
      const diff: PolishDiff = {
        ...baseDiff,
        status: "no-patches",
        reason: "Polish plan returned zero patches.",
      };
      await writeJson(chapterArtifactPath(params.packetArtifact.data.chapterNumber, "polish-diff"), wrapDiff(params, diff));
      return { ...noChange, diff, planArtifact };
    }

    const apply = applyPolishPatches({ prose: preProse, patches: planResult.plan.patches });
    if (apply.applied.length === 0) {
      const diff: PolishDiff = {
        ...baseDiff,
        status: "no-patches",
        reason: "All patches were filtered (low confidence, missing original text, or protected zones).",
        skippedPatches: apply.skipped,
      };
      await writeJson(chapterArtifactPath(params.packetArtifact.data.chapterNumber, "polish-diff"), wrapDiff(params, diff));
      return { ...noChange, diff, planArtifact };
    }

    const polished: PolishedSelected = {
      prose: apply.prose,
      wordCount: countWordsUtil(apply.prose),
      appliedPatches: apply.applied,
      skippedPatches: apply.skipped,
    };
    polishedArtifact = await buildPolishedSelectedArtifact({
      selectedArtifact: params.selectedArtifact,
      polished,
      artifactType: "polished-selected",
    });
    await writeJson(
      chapterArtifactPath(params.packetArtifact.data.chapterNumber, "polished-selected"),
      polishedArtifact,
    );

    const validatorIssues = runPolishProseValidators({
      packet: params.packetArtifact.data,
      prose: apply.prose,
    });
    const validatorErrors = validatorIssues.filter((issue) => issue.severity === "error");
    if (validatorErrors.length > 0) {
      const diff: PolishDiff = {
        ...baseDiff,
        status: "validators-failed",
        reason: `Polish validators failed: ${validatorErrors.map((i) => i.code).join(", ")}`,
        appliedPatches: apply.applied,
        skippedPatches: apply.skipped,
        polishedProse: apply.prose,
      };
      await writeJson(chapterArtifactPath(params.packetArtifact.data.chapterNumber, "polish-diff"), wrapDiff(params, diff));
      return { ...noChange, diff, planArtifact, polishedArtifact };
    }

    rejudgeArtifact = await judgeDraft({
      candidateId: params.selectedArtifact.data.winner,
      packetArtifact: params.packetArtifact,
      approvedSpecArtifact: params.approvedSpecArtifact,
      draftArtifact: createArtifact<ChapterDraft>({
        artifactType: "polish-rejudge-draft",
        blueprintHash: params.selectedArtifact.blueprintHash,
        blueprintVersion: params.selectedArtifact.blueprintVersion,
        chapterNumber: params.selectedArtifact.chapterNumber,
        qualityProfile: params.selectedArtifact.qualityProfile,
        data: { prose: apply.prose, wordCount: polished.wordCount },
      }),
      blueprintArtifacts: params.blueprintArtifacts,
      smoke: params.smoke,
      // Use the cheaper polish-rejudge profile so runtime budget/reasoning
      // matches what `estimate-cost.ts` advertises.
      stageOverride: config.stageProfiles.polishRejudge,
      // Tag the on-disk envelope so it identifies as a polish rejudge,
      // not a draft/revised review.
      artifactType: "polish-rejudge",
      // Don't overwrite chapter-N-draft-review.json or
      // chapter-N-revised-review.json. The polish rejudge gets its own
      // artifact path so the original candidate audit trail is preserved.
      persistArtifact: false,
    });
    await writeJson(
      chapterArtifactPath(params.packetArtifact.data.chapterNumber, "polish-rejudge"),
      rejudgeArtifact,
    );
    if (rejudgeArtifact.usage) {
      usages.push({ stage: config.stageProfiles.polishRejudge.stageName, usage: rejudgeArtifact.usage });
    }

    const postReviewScore = rejudgeArtifact.data.overallScore;
    const regressed = postReviewScore < preReviewScore - DEFAULT_REJUDGE_REGRESSION_TOLERANCE
      || rejudgeArtifact.data.blockingIssues.length > 0
      || rejudgeArtifact.data.issues.some((issue) => issue.severity === "error");

    if (regressed) {
      const diff: PolishDiff = {
        ...baseDiff,
        status: "rejudge-regressed",
        reason: `Polish re-judge regressed: pre=${preReviewScore} post=${postReviewScore} blocking=${rejudgeArtifact.data.blockingIssues.length}`,
        appliedPatches: apply.applied,
        skippedPatches: apply.skipped,
        postReviewScore,
        polishedProse: apply.prose,
      };
      await writeJson(chapterArtifactPath(params.packetArtifact.data.chapterNumber, "polish-diff"), wrapDiff(params, diff));
      return { ...noChange, diff, planArtifact, polishedArtifact, rejudgeArtifact };
    }

    // Success: replace selected/review with polished prose.
    const updatedSelected: ArtifactEnvelope<SelectedChapter> = {
      ...params.selectedArtifact,
      createdAt: new Date().toISOString(),
      data: {
        ...params.selectedArtifact.data,
        prose: apply.prose,
        wordCount: polished.wordCount,
        review: rejudgeArtifact.data,
      },
    };
    const updatedReview: ArtifactEnvelope<DraftReview> = {
      ...rejudgeArtifact,
    };
    await writeJson(chapterArtifactPath(params.packetArtifact.data.chapterNumber, "selected"), updatedSelected);
    await writeJson(chapterArtifactPath(params.packetArtifact.data.chapterNumber, "review"), updatedReview);

    const diff: PolishDiff = {
      ...baseDiff,
      status: "applied",
      reason: `Applied ${apply.applied.length} polish patch(es).`,
      appliedPatches: apply.applied,
      skippedPatches: apply.skipped,
      postReviewScore,
      polishedProse: apply.prose,
      finalProse: apply.prose,
    };
    await writeJson(chapterArtifactPath(params.packetArtifact.data.chapterNumber, "polish-diff"), wrapDiff(params, diff));
    return {
      selectedArtifact: updatedSelected,
      selectedReviewArtifact: updatedReview,
      diff,
      planArtifact,
      polishedArtifact,
      rejudgeArtifact,
      usages,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[polish-pass] Failed, keeping selected as-is: ${message}`);
    const diff: PolishDiff = {
      ...baseDiff,
      status: "skipped",
      reason: `Polish pass failed: ${message}`,
    };
    await writeJson(chapterArtifactPath(params.packetArtifact.data.chapterNumber, "polish-diff"), wrapDiff(params, diff));
    return { ...noChange, diff, planArtifact, polishedArtifact, rejudgeArtifact };
  }
}

function wrapDiff(
  params: { packetArtifact: ArtifactEnvelope<ChapterPacket> },
  diff: PolishDiff,
): ArtifactEnvelope<PolishDiff> {
  return createArtifact<PolishDiff>({
    artifactType: "polish-diff",
    blueprintHash: params.packetArtifact.blueprintHash,
    blueprintVersion: params.packetArtifact.blueprintVersion,
    chapterNumber: params.packetArtifact.chapterNumber,
    qualityProfile: params.packetArtifact.qualityProfile,
    data: diff,
  });
}

