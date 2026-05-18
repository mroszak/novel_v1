import { generateText as generateAnthropicText } from "../api/anthropic.js";
import { config } from "../config.js";
import type {
  ArtifactEnvelope,
  BlueprintCompilationArtifacts,
  ChapterDraft,
  ChapterPacket,
  ChapterSpec,
  DraftReview,
  RevisionDiff,
  RevisionPlan,
  StageUsage,
  TrackedIssue,
} from "../types/index.js";
import { parseAnthropicJson } from "../utils/parse-anthropic-json.js";
import { applyRevisionPatches } from "./apply-revision-patches.js";
import { validateRevisionPlan } from "./revision-plan-schema.js";
import { BlockedPipelineError, chapterArtifactPath, countWords, createArtifact } from "./stage-utils.js";
import { buildDraftSystemPrompt, stripHeavyPacketFields } from "./generate-draft.js";
import { createSmokeDraft } from "./smoke-helpers.js";
import { compactJson, writeJson } from "../utils/index.js";
import { buildTrackedIssues } from "./track-issues.js";

type RevisionUsageStage = "revision" | "revisionPatch";
type AdditionalRevisionUsage = {
  usageStage: RevisionUsageStage;
  usage: StageUsage;
};

type ReviseDraftParams = {
  packetArtifact: ArtifactEnvelope<ChapterPacket>;
  approvedSpecArtifact: ArtifactEnvelope<ChapterSpec>;
  draftArtifact: ArtifactEnvelope<ChapterDraft>;
  draftReviewArtifact: ArtifactEnvelope<DraftReview>;
  blueprintArtifacts: BlueprintCompilationArtifacts;
  smoke: boolean;
  additionalSystemInstructions?: string[];
  additionalPromptSections?: string[];
};

function formatTrackedIssues(issues: TrackedIssue[]): string {
  if (issues.length === 0) return "(no tracked issues)";
  return issues
    .map((issue) => `[${issue.id}] ${issue.origin}: ${issue.title} — ${issue.fixHint ?? "no hint"}`)
    .join("\n");
}

function buildScoreSummary(review: DraftReview): string {
  const scores = Object.entries(review.scoreBreakdown)
    .filter(([key]) => key !== "repetitionPenalty") as Array<[keyof DraftReview["scoreBreakdown"], number]>;
  const failing = scores
    .filter(([, score]) => score < 80)
    .map(([key, score]) => `${String(key)}:${score}`)
    .join(", ");
  const strongest = [...scores]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, score]) => `${String(key)}:${score}`)
    .join(", ");

  return [
    `overall: ${review.overallScore}`,
    `failing dimensions: [${failing}]`,
    `strongest dimensions: [${strongest}]`,
  ].join("\n");
}

function buildPovVoiceCards(packet: ChapterPacket, draftProse: string): string | null {
  const proseLower = draftProse.toLowerCase();
  const lines = packet.activeCast
    .filter((character) => proseLower.includes(character.name.toLowerCase()))
    .map((character) => {
      const voiceCard = packet.rollingMemory?.activeCharacterVoiceCards.find(
        (card) => card.character.toLowerCase() === character.name.toLowerCase(),
      );
      const traits = voiceCard?.activeTraits ?? character.voiceNotes;
      return `${character.name} (${character.role}): notices=${character.noticingEngine ?? "unspecified"}; traits=[${traits.join("; ")}]; knowledgeBoundary=${character.knowledgeBoundary}`;
    });
  return lines.length > 0 ? lines.join("\n") : null;
}

export function buildRevisionPatchRequest(params: {
  packet: ChapterPacket;
  spec: ChapterSpec;
  draft: ChapterDraft;
  review: DraftReview;
  trackedIssues: TrackedIssue[];
}): { system: string; prompt: string } {
  const povCards = buildPovVoiceCards(params.packet, params.draft.prose);
  return {
    system: [
      "You are Opus planning surgical revision patches for a novel draft.",
      "Return strict JSON only with keys patches, scopedExtension, issueOutcomes, notes, requiresStructuralRewrite, structuralRewriteReason.",
      "Use this shape: {\"patches\":[{\"errorRef\":\"tracked id\",\"originalText\":\"exact current prose\",\"replacementText\":\"replacement prose\",\"justification\":\"one sentence\"}],\"scopedExtension\":null,\"issueOutcomes\":[{\"id\":\"tracked id\",\"status\":\"patched|skipped|unaddressed\",\"reason\":\"short reason\"}],\"notes\":[],\"requiresStructuralRewrite\":false,\"structuralRewriteReason\":null}.",
      "Every patch must reference a known tracked issue id. originalText must match the draft exactly and should include enough local context to match once.",
      "Address mandatory issues with patches unless the prose is already correct; advisory issues may be skipped with a reason.",
      "If one patch covers multiple issue ids, set each covered issueOutcomes entry to patched and cite the applied patch's exact errorRef in square brackets, e.g. [judge-issue-error#1].",
      "If the chapter needs scene-level rebuilding rather than local edits, emit no patches and set requiresStructuralRewrite true with a concrete reason.",
      "Do not rewrite the chapter through one giant patch. Do not emit diff markup.",
    ].join("\n"),
    prompt: [
      "<tracked_issues>",
      formatTrackedIssues(params.trackedIssues),
      "</tracked_issues>",
      "<score_summary>",
      buildScoreSummary(params.review),
      "</score_summary>",
      "<draft_prose>",
      params.draft.prose,
      "</draft_prose>",
      ...(povCards ? ["<pov_voice_cards>", povCards, "</pov_voice_cards>"] : []),
      "<approved_spec_purpose>",
      params.spec.purpose,
      "</approved_spec_purpose>",
    ].join("\n"),
  };
}

function parseRevisionPlanOrBlock(rawText: string, stage: string): RevisionPlan {
  try {
    return validateRevisionPlan(parseAnthropicJson<RevisionPlan>(rawText));
  } catch (error) {
    throw new BlockedPipelineError(
      "BLOCKED_PROVIDER_FAILURE",
      stage,
      `${stage} planner did not return a valid RevisionPlan.`,
      {
        rawPlannerText: rawText,
        parseError: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

function buildSmokePlan(trackedIssues: TrackedIssue[]): RevisionPlan {
  return {
    patches: [],
    scopedExtension: null,
    issueOutcomes: trackedIssues.map((issue) => ({
      id: issue.id,
      status: "skipped",
      reason: "smoke",
    })),
    notes: ["smoke"],
    requiresStructuralRewrite: false,
    structuralRewriteReason: null,
  };
}

export function shouldStructurallyRewrite(review: DraftReview): {
  rewrite: boolean;
  reason: string | null;
} {
  const cfg = config.qualitySettings.revisionRouting;
  const sb = review.scoreBreakdown;

  if (sb.voiceConsistency < cfg.voiceConsistencyFloorForPatch) {
    return {
      rewrite: true,
      reason: `voiceConsistency ${sb.voiceConsistency} below patch floor ${cfg.voiceConsistencyFloorForPatch}`,
    };
  }

  const failingDims = Object.entries(sb)
    .filter(([key, value]) => key !== "repetitionPenalty" && value < cfg.dimensionFailingFloor)
    .map(([key]) => key);
  if (failingDims.length >= cfg.maxFailingDimensionsForPatch) {
    return {
      rewrite: true,
      reason: `${failingDims.length} dimensions below ${cfg.dimensionFailingFloor}: ${failingDims.join(", ")}`,
    };
  }

  if (sb.openingPower < cfg.structuralHookFloor || sb.endingHookStrength < cfg.structuralHookFloor) {
    return { rewrite: true, reason: `structural hook below ${cfg.structuralHookFloor}` };
  }

  return { rewrite: false, reason: null };
}

export function resolveRevisionPatchEscalation(plan: RevisionPlan): {
  rewrite: boolean;
  reason: string | null;
} {
  if (plan.requiresStructuralRewrite) {
    const reason = plan.structuralRewriteReason?.trim();
    if (!reason) {
      throw new BlockedPipelineError(
        "BLOCKED_PROVIDER_FAILURE",
        "revision-patch",
        "Revision patch planner requested a structural rewrite without a reason.",
        { structuralRewriteReason: plan.structuralRewriteReason },
      );
    }
    return { rewrite: true, reason };
  }

  const maxPatches = config.qualitySettings.revisionRouting.maxPatchesPerPlan;
  if (plan.patches.length > maxPatches) {
    return { rewrite: true, reason: `Issue count exceeds patch budget ${maxPatches}` };
  }

  return { rewrite: false, reason: null };
}

async function writeRevisedDraftArtifact(params: {
  packetArtifact: ArtifactEnvelope<ChapterPacket>;
  draft: ChapterDraft;
  usage?: ArtifactEnvelope<ChapterDraft>["usage"];
}): Promise<ArtifactEnvelope<ChapterDraft>> {
  const artifact = createArtifact<ChapterDraft>({
    artifactType: "revised-draft",
    blueprintHash: params.packetArtifact.blueprintHash,
    blueprintVersion: params.packetArtifact.blueprintVersion,
    chapterNumber: params.packetArtifact.chapterNumber,
    data: params.draft,
    usage: params.usage,
  });

  await writeJson(chapterArtifactPath(params.packetArtifact.data.chapterNumber, "revised-draft"), artifact);
  return artifact;
}

async function runStructuralRewrite(params: ReviseDraftParams): Promise<{
  artifact: ArtifactEnvelope<ChapterDraft>;
  usageStage: RevisionUsageStage;
  additionalUsages?: AdditionalRevisionUsage[];
}> {
  const {
    packetArtifact,
    approvedSpecArtifact,
    draftArtifact,
    draftReviewArtifact,
    blueprintArtifacts,
    smoke,
    additionalSystemInstructions = [],
    additionalPromptSections = [],
  } = params;

  let draft: ChapterDraft;
  let usage: ArtifactEnvelope<ChapterDraft>["usage"];

  if (smoke) {
    draft = createSmokeDraft(packetArtifact.data, approvedSpecArtifact.data, true);
    usage = undefined;
  } else {
    const storyCore = blueprintArtifacts.compiledBlueprint.data;
    const baseSystemPrompt = buildDraftSystemPrompt({
      genreContract: blueprintArtifacts.genreContract.data,
      storyPromise: storyCore.storyPromise,
      marketPositioning: storyCore.marketPositioning,
      chapterFunction: packetArtifact.data.chapterFunction,
      styleRules: storyCore.styleRules,
      antiPatterns: storyCore.antiPatterns,
      comparables: storyCore.marketPositioning.comparables,
    });

    const systemPrompt = [
      baseSystemPrompt,
      "REVISION MODE: You are revising an existing draft based on judge feedback.",
      "Improve the chapter only where the judge identified genuine weaknesses.",
      "Preserve continuity, working prose, scene architecture, and voice.",
      "Do not regress passages the judge praised. Target surgical improvement, not rewrite.",
      ...additionalSystemInstructions,
      "Output only the revised chapter prose.",
    ].join("\n\n");

    const result = await generateAnthropicText({
      stage: config.stageProfiles.revision,
      system: systemPrompt,
      prompt: [
        "<genre_contract>",
        compactJson(blueprintArtifacts.genreContract.data),
        "</genre_contract>",
        "<chapter_packet>",
        compactJson(stripHeavyPacketFields(packetArtifact.data)),
        "</chapter_packet>",
        "<approved_spec>",
        compactJson(approvedSpecArtifact.data),
        "</approved_spec>",
        "<style_rules>",
        storyCore.styleRules.join("\n"),
        "</style_rules>",
        "<anti_patterns>",
        storyCore.antiPatterns.join("\n"),
        "</anti_patterns>",
        "<motifs>",
        storyCore.motifBank.join("\n"),
        "</motifs>",
        "<story_promise>",
        compactJson(storyCore.storyPromise),
        "</story_promise>",
        "<continuity_memory>",
        compactJson(packetArtifact.data.rollingMemory),
        "</continuity_memory>",
        "<handoff_memory>",
        compactJson(packetArtifact.data.handoffMemory),
        "</handoff_memory>",
        "<previous_chapter>",
        packetArtifact.data.compactContext.previousChapterFull ?? "No previous chapter.",
        "</previous_chapter>",
        "<draft_review>",
        compactJson(draftReviewArtifact.data),
        "</draft_review>",
        ...additionalPromptSections,
        "<current_draft>",
        draftArtifact.data.prose,
        "</current_draft>",
      ].join("\n"),
    });

    draft = {
      prose: result.value,
      wordCount: countWords(result.value),
    };
    usage = result.usage;
  }

  const artifact = await writeRevisedDraftArtifact({
    packetArtifact,
    draft,
    usage,
  });

  return { artifact, usageStage: "revision" };
}

export async function planRevisionPatches(params: ReviseDraftParams): Promise<{
  plan: RevisionPlan;
  usage?: ArtifactEnvelope<RevisionDiff>["usage"];
  trackedIssues: TrackedIssue[];
}> {
  const trackedIssues = buildTrackedIssues({ review: params.draftReviewArtifact.data });
  if (params.smoke) {
    return {
      plan: buildSmokePlan(trackedIssues),
      usage: undefined,
      trackedIssues,
    };
  }

  const request = buildRevisionPatchRequest({
    packet: params.packetArtifact.data,
    spec: params.approvedSpecArtifact.data,
    draft: params.draftArtifact.data,
    review: params.draftReviewArtifact.data,
    trackedIssues,
  });

  const result = await generateAnthropicText({
    stage: config.stageProfiles.revisionPatch,
    system: request.system,
    prompt: request.prompt,
  });

  return {
    plan: parseRevisionPlanOrBlock(result.value, "revision-patch"),
    usage: result.usage,
    trackedIssues,
  };
}

export async function reviseDraft(params: ReviseDraftParams): Promise<{
  artifact: ArtifactEnvelope<ChapterDraft>;
  usageStage: RevisionUsageStage;
  additionalUsages?: AdditionalRevisionUsage[];
}> {
  if (params.smoke) {
    return runStructuralRewrite(params);
  }

  const route = shouldStructurallyRewrite(params.draftReviewArtifact.data);
  if (route.rewrite) {
    return runStructuralRewrite({
      ...params,
      additionalSystemInstructions: [
        ...(params.additionalSystemInstructions ?? []),
        `STRUCTURAL REWRITE ROUTE: ${route.reason}`,
      ],
    });
  }

  const { plan, usage, trackedIssues } = await planRevisionPatches(params);
  const escalation = resolveRevisionPatchEscalation(plan);
  if (escalation.rewrite) {
    const structural = await runStructuralRewrite({
      ...params,
      additionalSystemInstructions: [
        ...(params.additionalSystemInstructions ?? []),
        `MODEL ESCALATED TO STRUCTURAL REWRITE: ${escalation.reason}`,
      ],
    });
    return {
      ...structural,
      additionalUsages: usage ? [{ usageStage: "revisionPatch", usage }] : undefined,
    };
  }

  const diff = applyRevisionPatches({
    prose: params.draftArtifact.data.prose,
    plan,
    trackedIssues,
    maxPatches: config.qualitySettings.revisionRouting.maxPatchesPerPlan,
  });
  const diffArtifact = createArtifact<RevisionDiff>({
    artifactType: "revision-diff",
    blueprintHash: params.packetArtifact.blueprintHash,
    blueprintVersion: params.packetArtifact.blueprintVersion,
    chapterNumber: params.packetArtifact.chapterNumber,
    data: diff,
    usage,
  });
  await writeJson(chapterArtifactPath(params.packetArtifact.data.chapterNumber, "revision-diff"), diffArtifact);

  const artifact = await writeRevisedDraftArtifact({
    packetArtifact: params.packetArtifact,
    draft: {
      prose: diff.finalProse,
      wordCount: countWords(diff.finalProse),
    },
    usage,
  });

  return { artifact, usageStage: "revisionPatch" };
}
