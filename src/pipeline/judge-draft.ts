import { generateStructuredOutput } from "../api/openai.js";
import { config, type OpenAiStageProfile } from "../config.js";
import type {
  ArtifactEnvelope,
  BlueprintCompilationArtifacts,
  ChapterDraft,
  ChapterPacket,
  ChapterSpec,
  CharacterCard,
  DraftReview,
  ReviewScoreBreakdown,
  VoiceCard,
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

export function buildVoiceCardSummary(
  activeCast: CharacterCard[],
  runtimeCards: VoiceCard[],
  mistakenBeliefsByCharacter: Record<string, string[]> = {},
): string {
  return activeCast
    .map((c) => {
      const noticesSegment = c.noticingEngine ? ` notices="${c.noticingEngine}"` : "";
      const beliefs = mistakenBeliefsByCharacter[c.name] ?? [];
      const beliefsSegment = beliefs.length > 0
        ? `; believes=[${beliefs.map((b) => `"${b}"`).join(", ")}]`
        : "";
      const runtimeCard = runtimeCards.find(
        (card) => card.character.toLowerCase() === c.name.toLowerCase(),
      );
      if (runtimeCard) {
        return `${c.name} (${c.role}): traits=[${runtimeCard.activeTraits.join("; ")}] habits=[${runtimeCard.dialogueHabits.join("; ")}] stress="${runtimeCard.stressPattern}" taboo=[${runtimeCard.tabooNotes.join("; ")}]${noticesSegment}${beliefsSegment}`;
      }
      return `${c.name} (${c.role}): ${c.voiceNotes.join("; ")}${noticesSegment}${beliefsSegment}`;
    })
    .join("\n");
}

export function buildJudgeInstructions(
  passThreshold: number,
  readerJob: string | null,
): string {
  return [
    "You are the literary judge for a chapter-by-chapter novel engine.",
    "Score the chapter on all 15 dimensions using a 0-100 scale. Never use a 0-10 scale.",
    "The 15 dimensions: beatCoverage, tension, forwardMotion, characterTruth, voiceConsistency, specificity, thematicEmbodiment, openingPower, endingHookStrength, revealControl, freshness, repetitionPenalty, proseQuality, dialogueAuthenticity, sensoryImmersion.",
    "proseQuality: sentence-level rhythm, precision, image quality, varied sentence structure.",
    "dialogueAuthenticity: distinct character voices matching their voice cards, subtext over exposition, naturalism under pressure.",
    "sensoryImmersion: physical grounding, environmental presence, body-in-space awareness, the reader feels present.",
    "voiceConsistency: scene prose stays inside the POV character's perceptual filter and authorized knowledge.",
    "repetitionPenalty: this dimension is INVERTED from the other 14. It scores PENALTY MAGNITUDE, not cleanliness. Score 0 when the chapter has no perceived repetition problem, score 100 when the chapter is saturated with repeated words, phrases, sentence shapes, body anchors, gestures, or rhetorical structures. Treat the deterministic validator's repetition warnings as one input but use literary judgment for the final number. Higher values lower the overall score.",
    `Set passesThreshold true only when the overall chapter clearly clears ${passThreshold} and has no blocking literary or continuity issues.`,
    "When evaluating voice consistency, compare against the character voice cards and style rules provided.",
    "When evaluating continuity, check that the chapter opens consistently with where the previous chapter ended and respects the continuity active slice when provided.",
    "",
    "POV DISCIPLINE (strict — penalize voiceConsistency hard for any violation).",
    "Close-third stays inside the POV character's head. Treat as a violation any narration that gives a fact the POV character has no on-page reason to know in the moment: exact ages, full names of strangers, rehearsal history, training history, biographical detail, backstory of background characters, what someone said in a private conversation the POV did not witness, or what someone is feeling internally.",
    "An on-page reason can be: prior establishment within this chapter or the previous chapter, the character has just been introduced by name, a packet/spec note that the POV personally knows the fact, or the prose makes the inference observable (e.g. \"young enough to flush like a schoolgirl\" instead of \"sixteen years old and trained all spring\"). Inference from observable behavior is allowed; omniscient assertion is not.",
    "Flag every POV violation in revisionActions and, when the violation is structural rather than incidental, add it to blockingIssues.",
    "BLOCKING SUB-RULE (no discretion): any unsourced demographic assertion about a non-cast walk-on — ethnicity, nationality, exact age, training history, professional background, or any biographical fact the POV character has no on-page reason to know — is STRUCTURAL, not incidental. Add it to blockingIssues every time, even if it appears only once and reads as a small detail. The fix is trivial (let the prose use observable description, or have a cast character introduce the fact in dialogue), so the bar for blocking is low.",
    "",
    "SCENE TURN CHECK (feeds forwardMotion).",
    "For each scene break in the candidate prose, evaluate whether the scene actually changed the story state — someone now knows more, hides more, fears more, has misread something, has made a choice, has lost control, or has shifted loyalty. Atmosphere alone is not a turn. When a scene fails this check, lower forwardMotion, name the failing scene in weaknesses with a one-line reason, and add a concrete fix to revisionActions.",
    "",
    "NAMED WITHOUT FUTURE USE (feeds freshness).",
    "Flag named figures who appear in this chapter but have neither an on-page hook for future appearance, recognition, or recall, NOR a packet/spec reason to be named (active cast, mandatory beat participants, secondary cameos already scheduled). Required active-cast names are not flagged. The target is the named walk-on whose name does no work — give them a hook the reader will need later, or render them by role + one vivid detail. When this pattern appears, lower freshness slightly and list the over-named figures in weaknesses. Judging this from one chapter is necessarily uncertain; bias toward not flagging when in doubt.",
    "Additionally, when a POV character inventories three or more named figures in a single observational beat (a guest list, a room sweep, a roll call of arrivals), each named figure must do one of three things: reveal the POV character (what they notice betrays them), reveal social pressure in the room (alliances, watching, surveillance), or set up future consequence (recurrence, recognition, recall). Names that only add color should be compressed to role + one vivid detail. When this pattern fails, lower freshness slightly, name the over-inventoried beat in weaknesses, and add a concrete revisionAction asking for unnecessary names to be compressed to role + one vivid detail; bias toward not flagging when the inventory is short or when each figure clearly earns their name.",
    "",
    "WITHHELD ACTION VARIETY (feeds freshness).",
    "Restraint beats — characters who 'did not look', 'did not turn', 'did not drink', 'had not corrected', 'had not raised' — are a powerful suspense device in moderation. When a chapter leans on six or more such `did/had not + perception/action verb` beats in narration, the device becomes one mechanic rather than a varied texture. Count narration instances yourself (dialogue is exempt). When the count clears that threshold, lower freshness slightly, name two or three of the weakest restraint beats in weaknesses, and add a concrete revisionAction asking for the weakest instances to be replaced with active choices, misreadings, interruptions, or practical behavior. Keep the strongest restraint beats; vary the rest.",
    "",
    "PHYSICAL CLUE ANCHOR CHECK (feeds specificity).",
    "When the approved spec contains a non-empty `physicalClueAnchors` array, verify each entry's geometry is legible in the prose: the marker is named, the before-state is concrete, and the after-state is told apart from the before-state. When a referenced clue's before/after geometry is not legible (marker missing, before-state fuzzy, after-state indistinguishable from before), lower specificity and add a one-line entry to weaknesses naming which clue/marker failed.",
    "Additionally, the before/after change must be statable in one sentence each, anchored to a single fixed marker. Supporting geometry (other hardware, reflections, secondary surfaces) is allowed but must not obscure which marker the reader is tracking or what the change is. When the surrounding density makes the reader re-read to identify the change, lower specificity, add a one-line entry to weaknesses naming the over-built clue, and add a concrete revisionAction asking for the supporting geometry to be compressed.",
    "",
    "NOTICING ENGINE CHECK (feeds voiceConsistency).",
    "When a character voice card carries a `notices=\"...\"` segment, that character must perceive the scene through the declared engine during their POV section (job, fear, training, class, guilt, or habit). When the prose makes no use of it and the POV reads as generic narrator perception, lower voiceConsistency and add a one-line entry to weaknesses naming the character. These are weakness signals, not blocking issues.",
    "",
    "OVER-COMPOSED CLUSTER CHECK (feeds proseQuality).",
    "Identify the densest ornate cluster in the chapter — the passage where literary comparisons, abstract formulations, balanced clauses, and stylized sentence shapes pile up most heavily. A handful of polished lines across a chapter is good craft; three or more polished lines in immediate succession reads composed rather than lived. When such a cluster exists, lower proseQuality slightly and identify it in weaknesses by its opening phrase (the first 4-7 words of the passage, quoted exactly) plus the scene number it appears in — not by paragraph index, which is unreliable to count. Describe the dominant ornate device in one short clause. Add a concrete revisionAction asking for the identified passage's densest 10% to be thinned toward plain physical action, concrete observation, or direct cause-and-effect. Do not ask for a whole-chapter plainness rewrite; the target is local density only. Judging this from one chapter is necessarily uncertain; bias toward not flagging when the cluster carries genuine emotional pressure rather than substituting for it.",
    "",
    "ANTI-COMMITTEE PRINCIPLES.",
    "REWARD: asymmetry, weird vivid specificity, uncomfortable character choices, scene-specific physicality, unresolved tension, strong taste, sentences that risk being wrong to feel true.",
    'PUNISH: generic polish, explained emotion, fake profundity, cinematic vagueness, "AI thriller voice," sentences sanded to sound smart.',
    "When two candidates score equally on craft but one risks more, the riskier one wins.",
    "Judge by necessity, not abundance. A beautiful detail, clue, metaphor, character beat, or line of dialogue should be cut or demoted when it does not serve the chapter's dominant job, scene turn, pressure change, belief state, or POV truth — even when the material is genuinely good. The goal of the chapter is the necessary, not the accumulated.",
    "",
    "DOMINANT JOB DISCIPLINE (feeds forwardMotion).",
    "The approved spec's `purpose` field declares this chapter's dominant job in one sentence — what must change in the reader's experience (knowledge, suspicion, allegiance, pressure, belief) by the chapter's end. Evaluate whether the chapter served that job. Scenes, mandatory beats, named figures, ornate paragraphs, and stylistic flourishes that pull energy away from the chapter's dominant job without earning their place are competing material. When competing material exists, lower forwardMotion, name the competing element(s) in weaknesses with a one-line description, and add a concrete revisionAction asking for them to be compressed, demoted, or cut. Beautiful material that competes with the dominant job should be demoted, not retained. A chapter may carry many threads; only some should actively advance, and those that do must serve the declared `purpose`.",
    "",
    "BESTSELLER QUESTION (context signal, NOT a 16th rubric dimension):",
    readerJob
      ? `Treat this as a binding context signal: does this chapter make the target reader open chapter N+1 right now? The declared reader job is: ${readerJob}.`
      : "Does this chapter make the target reader open chapter N+1 right now?",
    "Weight this answer in the overall verdict and in revisionActions/blockingIssues, but DO NOT add a 16th score; never re-normalize the existing 15-dimension weights.",
  ].join("\n");
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
    const beliefStringsByCharacter: Record<string, string[]> = {};
    for (const c of packetArtifact.data.activeCast) {
      const beliefs = packetArtifact.data.mistakenBeliefs?.[c.name] ?? [];
      const filtered = beliefs
        .filter((b) => b.status === "active" || b.status === "questioned")
        .map((b) => b.belief);
      if (filtered.length > 0) beliefStringsByCharacter[c.name] = filtered;
    }
    const voiceCardSummary = buildVoiceCardSummary(
      packetArtifact.data.activeCast,
      runtimeCards,
      beliefStringsByCharacter,
    );

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
      instructions: buildJudgeInstructions(passThreshold, readerJob),
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
