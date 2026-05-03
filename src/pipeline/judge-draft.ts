import { generateStructuredOutput } from "../api/openai.js";
import { config, type OpenAiStageProfile } from "../config.js";
import type {
  ArtifactEnvelope,
  BlueprintCompilationArtifacts,
  ChapterDraft,
  ChapterPacket,
  ChapterSpec,
  DraftReview,
  ReviewScoreBreakdown,
} from "../types/index.js";
import { mapChapterFunctionToReaderJob } from "./generate-spec.js";
import { chapterArtifactPath, createArtifact } from "./stage-utils.js";
import { createSmokeReview } from "./smoke-helpers.js";
import { compactJson, roundTo, tailExcerpt, writeJson } from "../utils/index.js";

const reviewSchema = {
  type: "object",
  properties: {
    candidateId: { type: "string", enum: ["draft", "revision"] },
    overallScore: { type: "number", minimum: 0, maximum: 100 },
    passesThreshold: { type: "boolean" },
    scoreBreakdown: {
      type: "object",
      properties: {
        beatCoverage: { type: "number", minimum: 0, maximum: 100 },
        tension: { type: "number", minimum: 0, maximum: 100 },
        forwardMotion: { type: "number", minimum: 0, maximum: 100 },
        characterTruth: { type: "number", minimum: 0, maximum: 100 },
        voiceConsistency: { type: "number", minimum: 0, maximum: 100 },
        specificity: { type: "number", minimum: 0, maximum: 100 },
        thematicEmbodiment: { type: "number", minimum: 0, maximum: 100 },
        openingPower: { type: "number", minimum: 0, maximum: 100 },
        endingHookStrength: { type: "number", minimum: 0, maximum: 100 },
        revealControl: { type: "number", minimum: 0, maximum: 100 },
        freshness: { type: "number", minimum: 0, maximum: 100 },
        repetitionPenalty: { type: "number", minimum: 0, maximum: 100 },
        proseQuality: { type: "number", minimum: 0, maximum: 100 },
        dialogueAuthenticity: { type: "number", minimum: 0, maximum: 100 },
        sensoryImmersion: { type: "number", minimum: 0, maximum: 100 },
      },
      required: [
        "beatCoverage",
        "tension",
        "forwardMotion",
        "characterTruth",
        "voiceConsistency",
        "specificity",
        "thematicEmbodiment",
        "openingPower",
        "endingHookStrength",
        "revealControl",
        "freshness",
        "repetitionPenalty",
        "proseQuality",
        "dialogueAuthenticity",
        "sensoryImmersion",
      ],
      additionalProperties: false,
    },
    strengths: { type: "array", items: { type: "string" } },
    weaknesses: { type: "array", items: { type: "string" } },
    blockingIssues: { type: "array", items: { type: "string" } },
    revisionActions: { type: "array", items: { type: "string" } },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["info", "warning", "error"] },
          category: { type: "string", minLength: 1 },
          detail: { type: "string", minLength: 1 },
          evidence: { anyOf: [{ type: "string" }, { type: "null" }] },
          suggestedFix: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        required: ["severity", "category", "detail", "evidence", "suggestedFix"],
        additionalProperties: false,
      },
    },
    summary: { type: "string", minLength: 1 },
  },
  required: [
    "candidateId",
    "overallScore",
    "passesThreshold",
    "scoreBreakdown",
    "strengths",
    "weaknesses",
    "blockingIssues",
    "revisionActions",
    "issues",
    "summary",
  ],
  additionalProperties: false,
} as const;

export function calculateOverallScore(
  scoreBreakdown: ReviewScoreBreakdown,
  weights: Record<string, number>,
): number {
  let weightedTotal = 0;
  let totalWeight = 0;

  for (const [metric, rawScore] of Object.entries(scoreBreakdown)) {
    const effectiveScore = metric === "repetitionPenalty"
      ? 100 - rawScore
      : rawScore;
    const weight = weights[metric] ?? 1;
    weightedTotal += effectiveScore * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? roundTo(weightedTotal / totalWeight, 2) : 0;
}

function reviewUsesTenPointScale(review: DraftReview): boolean {
  const nonPenaltyScores = Object.entries(review.scoreBreakdown)
    .filter(([metric]) => metric !== "repetitionPenalty")
    .map(([, score]) => score);

  return nonPenaltyScores.length > 0
    && review.overallScore <= 10
    && nonPenaltyScores.every((score) => score <= 10);
}

export function normalizeReviewScale(review: DraftReview): DraftReview {
  if (!reviewUsesTenPointScale(review)) {
    return review;
  }

  const entries = Object.entries(review.scoreBreakdown) as Array<[keyof ReviewScoreBreakdown, number]>;
  const scoreBreakdown = Object.fromEntries(
    entries.map(([key, value]) => [key, roundTo(value * 10, 2)]),
  ) as unknown as ReviewScoreBreakdown;

  return {
    ...review,
    overallScore: roundTo(review.overallScore * 10, 2),
    scoreBreakdown,
  };
}

export function hasBlockingReviewSignals(
  review: Pick<DraftReview, "blockingIssues" | "issues">,
): boolean {
  return review.blockingIssues.length > 0 || review.issues.some((issue) => issue.severity === "error");
}

export function derivePassesThreshold(review: DraftReview, passThreshold: number): boolean {
  return review.overallScore >= passThreshold && !hasBlockingReviewSignals(review);
}

export async function judgeDraft(params: {
  candidateId: "draft" | "revision";
  packetArtifact: ArtifactEnvelope<ChapterPacket>;
  approvedSpecArtifact: ArtifactEnvelope<ChapterSpec>;
  draftArtifact: ArtifactEnvelope<ChapterDraft>;
  blueprintArtifacts: BlueprintCompilationArtifacts;
  smoke: boolean;
  /**
   * Optional stage profile override. Tournament rejudges may use cheaper
   * profiles while preserving the literary judge schema. Defaults to
   * `config.stageProfiles.literaryJudge` so existing draft/revision callers
   * keep their behavior.
   */
  stageOverride?: OpenAiStageProfile;
  /**
   * Optional override for the artifact envelope's `artifactType` field.
   * Tournament rejudges set this to `"tournament-rejudge"` so the on-disk
   * envelope identifies which rejudge wrote it. Defaults
   * to the `draft-review` / `revised-review` rule used by initial judges.
   */
  artifactType?: string;
  /**
   * When false, the returned artifact is NOT written to the canonical
   * `chapter-N-draft-review.json` / `chapter-N-revised-review.json` paths.
   * Used by post-selection rejudges (polish, tournament) that must not
   * corrupt the original candidate audit trail. Defaults to true so the
   * initial draft/revision judges keep persisting the per-candidate review.
   */
  persistArtifact?: boolean;
}): Promise<ArtifactEnvelope<DraftReview>> {
  const { candidateId, packetArtifact, approvedSpecArtifact, draftArtifact, blueprintArtifacts, smoke } = params;
  const passThreshold = config.qualitySettings.judgePassThreshold;
  const storyCore = blueprintArtifacts.compiledBlueprint.data;
  let review: DraftReview;
  let usage: ArtifactEnvelope<DraftReview>["usage"];

  if (smoke) {
    review = createSmokeReview(
      candidateId,
      draftArtifact.data,
      passThreshold,
      packetArtifact.data.chapterFunction.judgeWeights,
    );
    usage = undefined;
  } else {
    const previousChapterTail = packetArtifact.data.compactContext.previousChapterFull
      ? tailExcerpt(packetArtifact.data.compactContext.previousChapterFull, 800)
      : null;

    const runtimeCards = packetArtifact.data.rollingMemory?.activeCharacterVoiceCards ?? [];
    const voiceCardSummary = packetArtifact.data.activeCast
      .map((c) => {
        const runtimeCard = runtimeCards.find(
          (card) => card.character.toLowerCase() === c.name.toLowerCase(),
        );
        if (runtimeCard) {
          return `${c.name} (${c.role}): traits=[${runtimeCard.activeTraits.join("; ")}] habits=[${runtimeCard.dialogueHabits.join("; ")}] stress="${runtimeCard.stressPattern}" taboo=[${runtimeCard.tabooNotes.join("; ")}]`;
        }
        return `${c.name} (${c.role}): ${c.voiceNotes.join("; ")}`;
      })
      .join("\n");

    const marketPromise = packetArtifact.data.marketPromise;
    const continuitySlice = packetArtifact.data.continuityActiveSlice;
    const readerJob = mapChapterFunctionToReaderJob(packetArtifact.data.chapterFunction.function, marketPromise);

    const promptParts: string[] = [
      `Genre contract: ${compactJson(blueprintArtifacts.genreContract.data)}`,
      `Chapter function profile: ${compactJson(packetArtifact.data.chapterFunction)}`,
      `Approved spec: ${compactJson(approvedSpecArtifact.data)}`,
    ];

    if (marketPromise) {
      promptParts.push(
        `Market promise: ${compactJson({
          coreCommercialHook: marketPromise.coreCommercialHook,
          emotionalPromise: marketPromise.emotionalPromise,
          pacingContract: marketPromise.pacingContract,
          freshnessAngle: marketPromise.freshnessAngle,
        })}`,
      );
    }
    if (readerJob) {
      promptParts.push(`Declared reader job for this chapter: ${readerJob}`);
    }
    if (continuitySlice) {
      promptParts.push(`Continuity active slice: ${compactJson(continuitySlice)}`);
    }

    promptParts.push(
      `Style rules:\n${storyCore.styleRules.join("\n")}`,
      `Anti-patterns:\n${storyCore.antiPatterns.join("\n")}`,
      `Character voice cards:\n${voiceCardSummary}`,
      `Unresolved threads: ${compactJson(packetArtifact.data.rollingMemory?.unresolvedThreads ?? [])}`,
      `Active pressures: ${compactJson(packetArtifact.data.rollingMemory?.activePressures ?? [])}`,
      previousChapterTail
        ? `Previous chapter ending (last ~800 words):\n${previousChapterTail}`
        : "No previous chapter.",
      `Candidate id: ${candidateId}`,
      `Candidate prose:\n${draftArtifact.data.prose}`,
    );

    const stage = params.stageOverride ?? config.stageProfiles.literaryJudge;
    const result = await generateStructuredOutput<DraftReview>({
      stage,
      instructions: [
        "You are the literary judge for a chapter-by-chapter novel engine.",
        "Score the chapter on all 15 dimensions using a 0-100 scale. Never use a 0-10 scale.",
        "The 15 dimensions: beatCoverage, tension, forwardMotion, characterTruth, voiceConsistency, specificity, thematicEmbodiment, openingPower, endingHookStrength, revealControl, freshness, repetitionPenalty, proseQuality, dialogueAuthenticity, sensoryImmersion.",
        "proseQuality: sentence-level rhythm, precision, image quality, varied sentence structure.",
        "dialogueAuthenticity: distinct character voices matching their voice cards, subtext over exposition, naturalism under pressure.",
        "sensoryImmersion: physical grounding, environmental presence, body-in-space awareness, the reader feels present.",
        `Set passesThreshold true only when the overall chapter clearly clears ${passThreshold} and has no blocking literary or continuity issues.`,
        "When evaluating voice consistency, compare against the character voice cards and style rules provided.",
        "When evaluating continuity, check that the chapter opens consistently with where the previous chapter ended and respects the continuity active slice when provided.",
        "",
        "ANTI-COMMITTEE PRINCIPLES.",
        "REWARD: asymmetry, weird vivid specificity, uncomfortable character choices, scene-specific physicality, unresolved tension, strong taste, sentences that risk being wrong to feel true.",
        'PUNISH: generic polish, explained emotion, fake profundity, cinematic vagueness, "AI thriller voice," sentences sanded to sound smart.',
        "When two candidates score equally on craft but one risks more, the riskier one wins.",
        "",
        "BESTSELLER QUESTION (context signal, NOT a 16th rubric dimension):",
        readerJob
          ? `Treat this as a binding context signal: does this chapter make the target reader open chapter N+1 right now? The declared reader job is: ${readerJob}.`
          : "Does this chapter make the target reader open chapter N+1 right now?",
        "Weight this answer in the overall verdict and in revisionActions/blockingIssues, but DO NOT add a 16th score; never re-normalize the existing 15-dimension weights.",
      ].join("\n"),
      prompt: promptParts.join("\n\n"),
      schemaName: `draft_review_${candidateId}`,
      schema: reviewSchema,
    });
    const normalizedReview = normalizeReviewScale(result.value);
    const overallScore = calculateOverallScore(
      normalizedReview.scoreBreakdown,
      packetArtifact.data.chapterFunction.judgeWeights,
    );
    review = {
      ...normalizedReview,
      overallScore,
      passesThreshold: derivePassesThreshold(
        {
          ...normalizedReview,
          overallScore,
        },
        passThreshold,
      ),
    };
    usage = result.usage;
  }

  const artifactType = params.artifactType
    ?? (candidateId === "draft" ? "draft-review" : "revised-review");
  const artifact = createArtifact<DraftReview>({
    artifactType,
    blueprintHash: packetArtifact.blueprintHash,
    blueprintVersion: packetArtifact.blueprintVersion,
    chapterNumber: packetArtifact.chapterNumber,
    data: review,
    usage,
  });

  if (params.persistArtifact !== false) {
    await writeJson(
      chapterArtifactPath(
        packetArtifact.data.chapterNumber,
        candidateId === "draft" ? "draft-review" : "revised-review",
      ),
      artifact,
    );
  }

  return artifact;
}
