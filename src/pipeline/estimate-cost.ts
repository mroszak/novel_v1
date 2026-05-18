import { config, type AnthropicStageProfile, type OpenAiStageProfile } from "../config.js";
import { estimateStageCost, writeCostEstimateArtifact } from "../metrics/cost-tracker.js";
import {
  estimateAnthropicPromptTokens,
  estimateOpenAiPromptTokens,
  estimateTextTokens,
  estimateWordTokens,
} from "../metrics/token-budget.js";
import type {
  BlueprintCompilationArtifacts,
  ChapterCostEstimate,
  ChapterPacket,
  OpusSpecCritique,
  StageTokenEstimate,
} from "../types/index.js";
import { buildChapterDeltaRequest } from "./extract-chapter-delta.js";
import { buildContinuityFixRequest } from "./fix-continuity.js";
import {
  buildSelfRedTeamRequest,
  buildSpecCritiqueRequest,
  buildSpecGenerationRequest,
  buildSpecRevisionRequest,
} from "./generate-spec.js";
import { buildRevisionPatchRequest } from "./revise-draft.js";
import {
  createSmokeAudit,
  createSmokeDelta,
  createSmokeDraft,
  createSmokeMemory,
  createSmokeReview,
  createSmokeSelectedChapter,
  createSmokeSelfRedTeam,
  createSmokeSpec,
  createSmokeValidatorReport,
} from "./smoke-helpers.js";
import { buildFinalAuditPrompt } from "./final-audit.js";
import { stripHeavyPacketFields } from "./generate-draft.js";
import { buildTrackedIssues } from "./track-issues.js";
import { stripMemoryPacketFields } from "./update-memory.js";

function pushWithNote(stages: StageTokenEstimate[], est: StageTokenEstimate, note?: string): void {
  if (note) est.notes.push(note);
  stages.push(est);
}

function estimateOpenAiStageRequest(params: {
  stage: OpenAiStageProfile;
  request: {
    instructions: string;
    prompt: string;
    schema: Record<string, unknown>;
  };
}): number {
  return estimateOpenAiPromptTokens({
    stage: params.stage,
    instructions: params.request.instructions,
    prompt: params.request.prompt,
    schema: params.request.schema,
  });
}

function estimateAnthropicStageRequest(params: {
  stage: AnthropicStageProfile;
  request: {
    system: string;
    prompt: string;
  };
}): number {
  return estimateAnthropicPromptTokens({
    stage: params.stage,
    system: params.request.system,
    prompt: params.request.prompt,
  });
}

export async function estimateChapterCost(params: {
  chapterNumber: number;
  blueprintArtifacts: BlueprintCompilationArtifacts;
  packet: ChapterPacket;
  skipSpecCritique: boolean;
  noGenreAi: boolean;
}): Promise<string> {
  const profile = config.qualitySettings;
  const storyCore = params.blueprintArtifacts.compiledBlueprint.data;
  const genreAiDisabled = params.noGenreAi;

  // Build smoke fixtures to size every token pool from representative data
  const smokeSpec = createSmokeSpec(params.packet);
  const smokeDraft = createSmokeDraft(params.packet, smokeSpec, false);
  const smokeRevision = createSmokeDraft(params.packet, smokeSpec, true);
  const smokeReview = createSmokeReview("draft", smokeDraft, profile.judgePassThreshold);
  const smokeRevisionReview = createSmokeReview("revision", smokeRevision, profile.judgePassThreshold);
  const smokeSelected = createSmokeSelectedChapter(
    smokeDraft, smokeReview, smokeRevision, smokeRevisionReview, profile.pairwiseTolerance,
  );
  const smokeRedTeam = createSmokeSelfRedTeam(smokeSpec);
  const smokeCritique: OpusSpecCritique = {
    majorRisks: ["False reassurance could collapse too abruptly without enough emotional lift."],
    continuityThreats: ["Vivian must recognize the war logic entering the hotel without learning the military truth too early."],
    proseThreats: ["Scene turns could drift generic if the ballroom rescue beats do not stay physically grounded."],
    suggestedFixes: ["Stage the false hope as public spectacle while keeping Nathan and Luis privately out of rhythm with the official story."],
  };
  const smokeDeltaData = createSmokeDelta(params.packet, smokeSelected);
  const smokeMemory = createSmokeMemory(params.packet, smokeDeltaData, params.packet.rollingMemory);
  const smokeValidators = createSmokeValidatorReport();
  const smokeAudit = createSmokeAudit(smokeValidators);

  // --- Token pools ---

  const strippedPacketTokens = estimateTextTokens(
    JSON.stringify(stripHeavyPacketFields(params.packet)),
  );
  const memoryStrippedPacketTokens = estimateTextTokens(
    JSON.stringify(stripMemoryPacketFields(params.packet)),
  );
  const genreContractTokens = estimateTextTokens(
    JSON.stringify(params.blueprintArtifacts.genreContract.data),
  );
  const specTokens = estimateTextTokens(JSON.stringify(smokeSpec));
  const draftTokens = estimateWordTokens(smokeDraft.wordCount);
  const revisionTokens = estimateWordTokens(smokeRevision.wordCount);
  const memoryTokens = estimateTextTokens(JSON.stringify(params.packet.rollingMemory));
  const handoffTokens = estimateTextTokens(JSON.stringify(params.packet.handoffMemory));

  // Draft/revision send the FULL previous chapter, not a tail excerpt.
  // Use the actual packet data when available; fall back to target word count.
  const previousChapterFullTokens = params.packet.compactContext.previousChapterFull
    ? estimateTextTokens(params.packet.compactContext.previousChapterFull)
    : 0;
  const prevTailJudgeTokens = estimateWordTokens(800);

  const styleRulesTokens = estimateTextTokens(
    storyCore.styleRules.join("\n") + "\n" + storyCore.antiPatterns.join("\n"),
  );
  const voiceCardTokens = estimateTextTokens(
    params.packet.activeCast.map((c) => c.voiceNotes.join("; ")).join("\n"),
  );
  const motifsTokens = estimateTextTokens(storyCore.motifBank.join("\n"));
  const storyPromiseTokens = estimateTextTokens(JSON.stringify(storyCore.storyPromise));
  const functionTokens = estimateTextTokens(JSON.stringify(params.packet.chapterFunction));

  // Auxiliary structured-output payloads used as inputs to downstream stages
  const reviewTokens = estimateTextTokens(JSON.stringify(smokeReview));
  const deltaTokens = estimateTextTokens(JSON.stringify(smokeDeltaData));
  const validatorTokens = estimateTextTokens(JSON.stringify(smokeValidators));
  const revisionPatchInputTokens = estimateAnthropicStageRequest({
    stage: config.stageProfiles.revisionPatch,
    request: buildRevisionPatchRequest({
      packet: params.packet,
      spec: smokeSpec,
      draft: smokeDraft,
      review: smokeReview,
      trackedIssues: buildTrackedIssues({ review: smokeReview }),
    }),
  });

  // Critique inclusion: required (high risk — skip ignored) or preferred (profile flag).
  // needsOpusEscalation is unknowable at estimate time — see escalation note below.
  const includeCritique = params.packet.riskLevel === "high"
    || (profile.alwaysRunSpecCritique && !params.skipSpecCritique);
  const escalationNote = !includeCritique
    ? "May also run if self-red-team escalates (needsOpusEscalation)."
    : undefined;

  // --- Shared input pools ---

  const draftFamilyInput = strippedPacketTokens + genreContractTokens + specTokens
    + motifsTokens + memoryTokens + handoffTokens + previousChapterFullTokens + styleRulesTokens;
  const judgeInput = (candidateTokens: number) =>
    genreContractTokens + functionTokens + specTokens + candidateTokens
    + styleRulesTokens + voiceCardTokens + prevTailJudgeTokens;
  const fixLoopAuditInput = estimateTextTokens(buildFinalAuditPrompt({
    genreContract: params.blueprintArtifacts.genreContract.data,
    packet: params.packet,
    selectedReview: smokeSelected.review,
    delta: smokeDeltaData,
    memory: smokeMemory,
    validatorReport: smokeValidators,
    selectedProse: smokeSelected.prose,
  }));
  const fixLoopFixInput = estimateAnthropicStageRequest({
    stage: config.stageProfiles.continuityFix,
    request: buildContinuityFixRequest({
      packet: params.packet,
      selected: smokeSelected,
      trackedIssues: buildTrackedIssues({ audit: smokeAudit }),
    }),
  });

  // --- Build stage list ---

  const stages: StageTokenEstimate[] = [];

  // ── Blueprint-level deterministic compiles (zero model cost; one-time) ──
  stages.push({
    stage: "market-promise",
    provider: "openai",
    model: config.models.openAiPrimary,
    estimatedInputTokens: 0,
    maxOutputTokens: 0,
    contextWindowTokens: 0,
    withinBudget: true,
    estimatedCostUsd: 0,
    pricingConfigured: true,
    notes: ["Deterministic compile from blueprint; no model call; cached on blueprintHash."],
  });
  stages.push({
    stage: "continuity-manifest",
    provider: "openai",
    model: config.models.openAiPrimary,
    estimatedInputTokens: 0,
    maxOutputTokens: 0,
    contextWindowTokens: 0,
    withinBudget: true,
    estimatedCostUsd: 0,
    pricingConfigured: true,
    notes: ["Deterministic compile from blueprint; no model call; cached on blueprintHash."],
  });

  // ── Genre compilation (one model call per blueprint on cold cache) ──
  if (genreAiDisabled) {
    stages.push({
      stage: "genre-compilation",
      provider: config.stageProfiles.genreCompilation.provider,
      model: config.stageProfiles.genreCompilation.model,
      estimatedInputTokens: 0,
      maxOutputTokens: 0,
      contextWindowTokens: 0,
      withinBudget: true,
      estimatedCostUsd: 0,
      pricingConfigured: true,
      notes: ["Disabled by --no-genre-ai (or --smoke); deterministic preset compile only."],
    });
  } else {
    stages.push({
      ...estimateStageCost({
        stage: config.stageProfiles.genreCompilation,
        estimatedInputTokens: storyPromiseTokens + genreContractTokens,
      }),
      notes: ["Conditional: only runs on cold blueprint cache; cached on blueprintHash."],
    });
  }

  // ── Author brief (one model call per blueprint, amortized) ──
  if (genreAiDisabled) {
    stages.push({
      stage: "author-brief",
      provider: config.stageProfiles.authorBrief.provider,
      model: config.stageProfiles.authorBrief.model,
      estimatedInputTokens: 0,
      maxOutputTokens: 0,
      contextWindowTokens: 0,
      withinBudget: true,
      estimatedCostUsd: 0,
      pricingConfigured: true,
      notes: ["Disabled by --no-genre-ai (or --smoke); deterministic fallback brief only."],
    });
  } else {
    stages.push({
      ...estimateStageCost({
        stage: config.stageProfiles.authorBrief,
        estimatedInputTokens: storyPromiseTokens + genreContractTokens + styleRulesTokens
          + motifsTokens + (params.packet.marketPromise
            ? estimateTextTokens(JSON.stringify(params.packet.marketPromise))
            : 0),
      }),
      notes: ["One-time per blueprint; cached on blueprintHash. Amortizes over the full chapter run."],
    });
  }

  const specGenerationInputTokens = estimateOpenAiStageRequest({
    stage: config.stageProfiles.specGeneration,
    request: buildSpecGenerationRequest({
      storyCore,
      genreContract: params.blueprintArtifacts.genreContract.data,
      packet: params.packet,
    }),
  });
  const selfRedTeamInputTokens = estimateOpenAiStageRequest({
    stage: config.stageProfiles.selfRedTeam,
    request: buildSelfRedTeamRequest({
      packet: params.packet,
      spec: smokeSpec,
    }),
  });
  const specCritiqueInputTokens = includeCritique
    ? estimateAnthropicStageRequest({
      stage: config.stageProfiles.specCritique,
      request: buildSpecCritiqueRequest({
        genreContract: params.blueprintArtifacts.genreContract.data,
        packet: params.packet,
        spec: smokeSpec,
      }),
    })
    : null;
  const specRevisionInputTokens = estimateOpenAiStageRequest({
    stage: config.stageProfiles.specRevision,
    request: buildSpecRevisionRequest({
      packet: params.packet,
      spec: smokeSpec,
      selfRedTeam: smokeRedTeam,
      opusCritique: includeCritique ? smokeCritique : undefined,
    }),
  });
  const chapterDeltaInputTokens = estimateOpenAiStageRequest({
    stage: config.stageProfiles.chapterDelta,
    request: buildChapterDeltaRequest({
      genreContract: params.blueprintArtifacts.genreContract.data,
      packet: params.packet,
      previousMemory: params.packet.rollingMemory,
      selectedProse: smokeSelected.prose,
    }),
  });

  // ── Spec loop ──

  stages.push(estimateStageCost({
    stage: config.stageProfiles.specGeneration,
    estimatedInputTokens: specGenerationInputTokens,
  }));

  stages.push(estimateStageCost({
    stage: config.stageProfiles.selfRedTeam,
    estimatedInputTokens: selfRedTeamInputTokens,
  }));

  if (includeCritique) {
    stages.push(estimateStageCost({
      stage: config.stageProfiles.specCritique,
      estimatedInputTokens: specCritiqueInputTokens ?? 0,
    }));
  }

  const specRevisionEst = estimateStageCost({
    stage: config.stageProfiles.specRevision,
    estimatedInputTokens: specRevisionInputTokens,
  });
  if (escalationNote) specRevisionEst.notes.push(escalationNote);
  stages.push(specRevisionEst);

  // ── Draft / judge / revision / selection ──

  stages.push(estimateStageCost({
    stage: config.stageProfiles.drafting,
    estimatedInputTokens: draftFamilyInput,
  }));

  stages.push(estimateStageCost({
    stage: config.stageProfiles.literaryJudge,
    estimatedInputTokens: judgeInput(draftTokens),
  }));

  const skipNote = profile.skipRevisionThreshold !== null
    ? "Skipped when draft scores >= skipRevisionThreshold and has no blocking signals."
    : undefined;

  const revisionEst = estimateStageCost({
    stage: config.stageProfiles.revision,
    estimatedInputTokens: draftFamilyInput + draftTokens + styleRulesTokens
      + storyPromiseTokens + reviewTokens,
  });
  pushWithNote(
    stages,
    revisionEst,
    skipNote
      ? `${skipNote} Structural fallback only when revisionRouting thresholds or planner self-escalation require it.`
      : "Structural fallback only when revisionRouting thresholds or planner self-escalation require it.",
  );

  const revisionPatchEst = estimateStageCost({
    stage: config.stageProfiles.revisionPatch,
    estimatedInputTokens: revisionPatchInputTokens,
  });
  pushWithNote(
    stages,
    revisionPatchEst,
    skipNote
      ? `${skipNote} Default revision path; emits a RevisionDiff sidecar.`
      : "Default revision path; emits a RevisionDiff sidecar.",
  );

  const revisionJudgeEst: StageTokenEstimate = {
    ...estimateStageCost({
      stage: config.stageProfiles.literaryJudge,
      estimatedInputTokens: judgeInput(revisionTokens),
    }),
    stage: `${config.stageProfiles.literaryJudge.stageName}-revision`,
  };
  if (skipNote) revisionJudgeEst.notes = [...revisionJudgeEst.notes, skipNote];
  stages.push(revisionJudgeEst);

  const selectionEst = estimateStageCost({
    stage: config.stageProfiles.pairwiseSelection,
    estimatedInputTokens: genreContractTokens + functionTokens
      + draftTokens + revisionTokens + 2 * reviewTokens,
  });
  if (skipNote) selectionEst.notes.push(skipNote);
  selectionEst.notes.push(
    "Also skipped when deterministic gates decide the winner (pass-mismatch, blocker-mismatch, or within-tolerance) without a model call.",
  );
  stages.push(selectionEst);

  // ── Post-selection enhancement: voice-grit (advisory/fail-soft) ──
  const selectedProseTokens = estimateWordTokens(smokeSelected.wordCount);
  stages.push({
    ...estimateStageCost({
      stage: config.stageProfiles.voiceGritPlan,
      estimatedInputTokens: strippedPacketTokens + styleRulesTokens + motifsTokens + selectedProseTokens,
    }),
    notes: ["Conditional: runs only when a voice-target is available."],
  });
  stages.push({
    ...estimateStageCost({
      stage: config.stageProfiles.voiceGritRejudge,
      estimatedInputTokens: judgeInput(selectedProseTokens),
    }),
    notes: ["Conditional: runs only when voice-grit-plan returned applied patches that passed validators."],
  });

  // ── Post-selection enhancement: tournament (advisory/fail-soft) ──
  for (const stageProfile of [
    config.stageProfiles.openingCandidate,
    config.stageProfiles.endingCandidate,
  ]) {
    stages.push({
      ...estimateStageCost({
        stage: stageProfile,
        estimatedInputTokens: strippedPacketTokens + styleRulesTokens + selectedProseTokens,
      }),
      stage: `${stageProfile.stageName}-1`,
      notes: ["Conditional: runs only when the zone is locatable in the selected prose."],
    });
  }
  for (const zone of ["opening", "ending"]) {
    stages.push({
      ...estimateStageCost({
        stage: config.stageProfiles.tournamentSelection,
        estimatedInputTokens: strippedPacketTokens + selectedProseTokens / 2,
      }),
      stage: `${config.stageProfiles.tournamentSelection.stageName}-${zone}-1`,
      notes: ["Conditional: runs only when candidate generation succeeded for that zone."],
    });
  }

  // ── Post-selection: delta, memory, initial audit ──

  stages.push(estimateStageCost({
    stage: config.stageProfiles.chapterDelta,
    estimatedInputTokens: chapterDeltaInputTokens,
  }));

  stages.push(estimateStageCost({
    stage: config.stageProfiles.memoryUpdate,
    estimatedInputTokens: memoryStrippedPacketTokens + memoryTokens + deltaTokens,
  }));

  stages.push(estimateStageCost({
    stage: config.stageProfiles.finalAudit,
    estimatedInputTokens: fixLoopAuditInput,
  }));

  // ── Continuity fix loop (up to maxFixAttempts iterations) ──

  const maxFixes = profile.maxFixAttempts;
  for (let i = 1; i <= maxFixes; i++) {
    const fixNote = `Conditional: only runs if audit finds blocking issues${i > 1 ? ` after attempt ${i - 1}` : ""}.`;

    const fixEst: StageTokenEstimate = {
      ...estimateStageCost({
        stage: config.stageProfiles.continuityFix,
        estimatedInputTokens: fixLoopFixInput,
      }),
      stage: `${config.stageProfiles.continuityFix.stageName}-${i}`,
      notes: [fixNote],
    };
    stages.push(fixEst);

    const deltaFixEst: StageTokenEstimate = {
      ...estimateStageCost({
        stage: config.stageProfiles.chapterDelta,
        estimatedInputTokens: chapterDeltaInputTokens,
      }),
      stage: `${config.stageProfiles.chapterDelta.stageName}-fix-${i}`,
      notes: [fixNote],
    };
    stages.push(deltaFixEst);

    const memoryFixEst: StageTokenEstimate = {
      ...estimateStageCost({
        stage: config.stageProfiles.memoryUpdate,
        estimatedInputTokens: memoryStrippedPacketTokens + memoryTokens + deltaTokens,
      }),
      stage: `${config.stageProfiles.memoryUpdate.stageName}-fix-${i}`,
      notes: [fixNote],
    };
    stages.push(memoryFixEst);

    const auditFixEst: StageTokenEstimate = {
      ...estimateStageCost({
        stage: config.stageProfiles.finalAudit,
        estimatedInputTokens: fixLoopAuditInput,
      }),
      stage: `${config.stageProfiles.finalAudit.stageName}-fix-${i}`,
      notes: [fixNote],
    };
    stages.push(auditFixEst);
  }

  // Post-fix literary judge (runs once after the fix loop if any fixes were applied)
  const postFixJudgeEst: StageTokenEstimate = {
    ...estimateStageCost({
      stage: config.stageProfiles.literaryJudge,
      estimatedInputTokens: judgeInput(draftTokens),
    }),
    stage: `${config.stageProfiles.literaryJudge.stageName}-post-fix`,
    notes: ["Conditional: only runs after continuity fixes are applied."],
  };
  stages.push(postFixJudgeEst);


  // ── Voice calibration (post-publish; deterministic local extraction) ──
  // The voice fingerprint is computed deterministically from published prose
  // and does not call a model. Hand-build the stage shape so we don't surface
  // a per-stage cost for a deterministic step.
  stages.push({
    stage: "voice-calibration",
    provider: config.stageProfiles.voiceCalibration.provider,
    model: config.stageProfiles.voiceCalibration.model,
    estimatedInputTokens: 0,
    maxOutputTokens: 0,
    contextWindowTokens: 0,
    withinBudget: true,
    estimatedCostUsd: 0,
    pricingConfigured: true,
    notes: [
      "Deterministic local extraction after publish; no model call by default.",
      "Reads STYLE_SAMPLE.md when present, otherwise derives from the latest 1-3 published chapters (including the chapter that just published).",
    ],
  });

  // ── Continuity state update (post-publish; deterministic merge) ──
  stages.push({
    stage: "continuity-state-update",
    provider: "openai",
    model: config.models.openAiPrimary,
    estimatedInputTokens: 0,
    maxOutputTokens: 0,
    contextWindowTokens: 0,
    withinBudget: true,
    estimatedCostUsd: 0,
    pricingConfigured: true,
    notes: [
      "Deterministic per-chapter merge of manifest baseline + previous state + published prose. No model call.",
      "Skipped when the blueprint omits a Continuity Manifest.",
    ],
  });

  return writeCostEstimateArtifact({
    chapterNumber: params.chapterNumber,
    stages,
    blueprintHash: params.blueprintArtifacts.compiledBlueprint.blueprintHash,
    blueprintVersion: params.blueprintArtifacts.compiledBlueprint.blueprintVersion,
  });
}
