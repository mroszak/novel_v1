import { config } from "../config.js";
import { writeCostSummaryArtifact } from "../metrics/cost-tracker.js";
import { parseBlueprint } from "../blueprint/parse-blueprint.js";
import { extractAndPersistVoiceTarget } from "../blueprint/extract-voice-fingerprint.js";
import { compileChapterPacket } from "./compile-chapter-packet.js";
import { compileBlueprintRuntime } from "./compile-blueprint.js";
import { estimateChapterCost } from "./estimate-cost.js";
import { extractChapterDelta } from "./extract-chapter-delta.js";
import { runFinalAudit } from "./final-audit.js";
import { fixContinuity, applyFixResult } from "./fix-continuity.js";
import { generateDraft } from "./generate-draft.js";
import { runSpecLoop } from "./generate-spec.js";
import { hasBlockingReviewSignals, judgeDraft } from "./judge-draft.js";
import { applyLocalizedAuditPatch, applyLocalizedAuditPatchResult } from "./localized-audit-patch.js";
import { runOpeningEndingTournament } from "./opening-ending-tournament.js";
import { reviseDraft } from "./revise-draft.js";
import { buildDeclaredRevealsFromSpec, updateContinuityState } from "./update-continuity-state.js";
import { runVoiceGritPass } from "./voice-grit-pass.js";
import { selectDraft } from "./select-draft.js";
import {
  BlockedPipelineError,
  chapterArtifactPath,
  createArtifact,
  loadArtifact,
  memoryArtifactPath,
  publishChapter,
  writeStatusArtifact,
} from "./stage-utils.js";
import { updateMemory } from "./update-memory.js";
import type {
  ArtifactEnvelope,
  ChapterDelta,
  ChapterDraft,
  ChapterPacket,
  ChapterSpec,
  DraftReview,
  PairwiseSelection,
  PublishCandidateSnapshot,
  RollingMemory,
  RunChapterOptions,
  RunChapterResult,
  SelectedChapter,
  StageUsage,
} from "../types/index.js";
import { writeJson } from "../utils/index.js";

function startsAfterPacket(options: RunChapterOptions): boolean {
  return Boolean(
    options.draftOnly
      || options.judgeOnly
      || options.auditOnly
      || (options.rerunFrom && options.rerunFrom !== "packet"),
  );
}

function startsAfterSpec(options: RunChapterOptions): boolean {
  return Boolean(
    options.draftOnly
      || options.judgeOnly
      || options.auditOnly
      || (options.rerunFrom && ["draft", "judge", "memory", "audit"].includes(options.rerunFrom)),
  );
}

function startsAfterDraft(options: RunChapterOptions): boolean {
  return Boolean(
    options.judgeOnly
      || options.auditOnly
      || (options.rerunFrom && ["judge", "memory", "audit"].includes(options.rerunFrom)),
  );
}

function startsAfterJudge(options: RunChapterOptions): boolean {
  return Boolean(
    options.auditOnly
      || (options.rerunFrom && ["memory", "audit"].includes(options.rerunFrom)),
  );
}

function startsAfterMemory(options: RunChapterOptions): boolean {
  return Boolean(options.rerunFrom === "audit");
}

function collectUsage(
  usages: Array<{ stage: string; usage: StageUsage }>,
  stage: string,
  artifact: { usage?: StageUsage },
): void {
  if (artifact.usage) {
    usages.push({ stage, usage: artifact.usage });
  }
}

export function hasBlockingAuditIssues(audit: {
  requiresFix: boolean;
  issues: Array<{ severity: string }>;
}): boolean {
  return audit.requiresFix || audit.issues.some((issue) => issue.severity === "error");
}

/**
 * After a successful continuity-fix attempt, downgrade WORD_BAND to a warning
 * so the loop does not trigger another fresh rewrite solely to expand prose.
 *
 * The fix loop's failure mode is non-convergent: an attempt that cleans repetition
 * by cutting content trips WORD_BAND on the next audit; the subsequent attempt has
 * to expand and tends to re-introduce the original phrasing from packet priming.
 * Accepting a slightly-short clean chapter beats a re-bloated dirty one.
 */
export function downgradePostFixWordBandError<
  T extends { requiresFix: boolean; issues: Array<{ severity: string; title: string }> },
>(audit: T): T {
  const errors = audit.issues.filter((i) => i.severity === "error");
  if (errors.length === 0) return audit;
  if (!errors.every((i) => i.title === "WORD_BAND")) return audit;
  return {
    ...audit,
    issues: audit.issues.map((i) =>
      i.severity === "error" && i.title === "WORD_BAND" ? { ...i, severity: "warning" } : i,
    ),
    requiresFix: false,
  };
}

/**
 * True when the audit is currently blocking (requiresFix or any error) AND
 * every error-severity issue came from the deterministic validators rather
 * than the model auditor.
 *
 * Validator errors are sometimes false positives (anchoring, scope, off-by-one
 * regex) and the wholesale fixContinuity pass rewrites the entire chapter,
 * which damages prose the literary judge already accepted. Keeping this
 * scenario out of the wholesale fix loop preserves the working draft and lets
 * us simply downgrade the validator noise to warnings on the published audit.
 */
export function isValidatorOnlyBlocking(audit: {
  requiresFix: boolean;
  issues: Array<{ severity: string; source?: "model" | "validator" }>;
}): boolean {
  const errorIssues = audit.issues.filter((i) => i.severity === "error");
  if (errorIssues.length === 0 && !audit.requiresFix) return false;
  if (errorIssues.length === 0 && audit.requiresFix) return false;
  return errorIssues.every((i) => i.source === "validator");
}

/**
 * Downgrades all validator-sourced error issues to warnings and clears
 * `requiresFix`. Used when `isValidatorOnlyBlocking` is true so we can
 * publish the literary-judge-approved prose without rewriting it.
 */
export function downgradeValidatorOnlyErrors<
  T extends { requiresFix: boolean; issues: Array<{ severity: string; source?: "model" | "validator" }> },
>(audit: T): T {
  return {
    ...audit,
    issues: audit.issues.map((i) =>
      i.severity === "error" && i.source === "validator" ? { ...i, severity: "warning" } : i,
    ),
    requiresFix: false,
  };
}

/**
 * Downgrades every error-severity issue to warning and clears `requiresFix`,
 * preserving the original `source` (model vs validator) so operators can still
 * see which issues came from where. Used by the publish-candidate ratchet on
 * revert: we trust the literary judge's approval over downstream blockers, but
 * we must not lie about who flagged what.
 */
export function downgradeAllErrorsToWarnings<
  T extends { requiresFix: boolean; issues: Array<{ severity: string; source?: "model" | "validator" }> },
>(audit: T): T {
  return {
    ...audit,
    issues: audit.issues.map((i) => (i.severity === "error" ? { ...i, severity: "warning" } : i)),
    requiresFix: false,
  };
}

const REVERT_SUMMARY_SUFFIX
  = " [publish-candidate ratchet reverted to the literary-judge-approved prose; the issues above are retained as advisory warnings.]";

/**
 * Appends a single sentinel sentence to the audit summary so the published
 * artifact is internally consistent on the revert path: `requiresFix: false`
 * matches a summary string that explains why. Idempotent — no-op if the
 * sentinel is already present.
 */
export function annotateRevertedAuditSummary<
  T extends { summary: string },
>(audit: T): T {
  if (audit.summary.includes(REVERT_SUMMARY_SUFFIX.trim())) return audit;
  return { ...audit, summary: `${audit.summary}${REVERT_SUMMARY_SUFFIX}` };
}

export function prepareRevertedPublishCandidateAudit<
  T extends { requiresFix: boolean; summary: string; issues: Array<{ severity: string; source?: "model" | "validator" }> },
>(audit: T): T {
  return hasBlockingAuditIssues(audit)
    ? annotateRevertedAuditSummary(downgradeAllErrorsToWarnings(audit))
    : audit;
}

/**
 * Publish-candidate ratchet: returns true when the post-fix re-judge score
 * has dropped more than `tolerance` below the candidate score captured at the
 * start of the final-audit phase. Reverting protects against silent
 * downstream degradation — fix-loop rewrites that pass threshold but produce
 * artistically weaker prose than the literary stack approved.
 *
 * Also reverts when the candidate cleared `passThreshold` but the post-fix
 * does not, even within tolerance. Otherwise a fix-loop nudge that lands
 * just under threshold would block the chapter even though the candidate
 * was publishable — the threshold gate would beat the ratchet to the punch.
 * Preserving immutability means the candidate always wins when the fix path
 * cannot match it on the threshold the literary judge already approved.
 */
export function shouldRevertToPublishCandidate(params: {
  candidateScore: number;
  postFixScore: number;
  tolerance: number;
  passThreshold?: number;
  postFixPassesThreshold?: boolean;
}): boolean {
  if (params.postFixScore < params.candidateScore - params.tolerance) {
    return true;
  }
  if (
    params.passThreshold !== undefined
    && params.postFixPassesThreshold === false
    && params.candidateScore >= params.passThreshold
  ) {
    return true;
  }
  return false;
}

export function shouldSkipRevision(params: {
  skipRevisionThreshold: number | null;
  overallScore: number;
  passesThreshold: boolean;
  review: Pick<DraftReview, "blockingIssues" | "issues">;
}): boolean {
  return params.skipRevisionThreshold !== null
    && params.overallScore >= params.skipRevisionThreshold
    && params.passesThreshold
    && !hasBlockingReviewSignals(params.review);
}

function createSelectedDraftArtifact(params: {
  selectedArtifact: ArtifactEnvelope<SelectedChapter>;
  artifactType: string;
}): ArtifactEnvelope<ChapterDraft> {
  const { selectedArtifact, artifactType } = params;
  return createArtifact<ChapterDraft>({
    artifactType,
    blueprintHash: selectedArtifact.blueprintHash,
    blueprintVersion: selectedArtifact.blueprintVersion,
    chapterNumber: selectedArtifact.chapterNumber,
    data: {
      prose: selectedArtifact.data.prose,
      wordCount: selectedArtifact.data.wordCount,
    },
  });
}

function emptyResult(status: RunChapterResult["status"], blueprintHash: string): RunChapterResult {
  return {
    status,
    blueprintHash,
    packetArtifactPath: null,
    approvedSpecArtifactPath: null,
    draftArtifactPath: null,
    selectedArtifactPath: null,
    memoryArtifactPath: null,
    auditArtifactPath: null,
    publishedChapterPath: null,
    statusArtifactPath: null,
    costEstimateArtifactPath: null,
    costSummaryArtifactPath: null,
    reusedArtifacts: [],
  };
}

export async function runChapter(options: RunChapterOptions): Promise<RunChapterResult> {
  const parsedBlueprint = await parseBlueprint(options.blueprintPath);
  const parsedBlueprintIdentity = {
    blueprintHash: parsedBlueprint.blueprintHash,
    blueprintVersion: parsedBlueprint.metadata.blueprintVersion,
  };
  const result = emptyResult("SUCCESS", parsedBlueprint.blueprintHash);
  const usages: Array<{ stage: string; usage: StageUsage }> = [];

  try {
    console.error(`[ch${options.chapterNumber}] Compiling blueprint...`);
    const compilation = await compileBlueprintRuntime({
      blueprintPath: options.blueprintPath,
      noGenreAi: options.noGenreAi || options.smoke,
    });
    const artifactIdentity = {
      blueprintHash: compilation.parsed.blueprintHash,
      blueprintVersion: compilation.parsed.metadata.blueprintVersion,
      chapterNumber: options.chapterNumber,
    };

    result.blueprintHash = compilation.parsed.blueprintHash;

    if (options.compileBlueprintOnly) {
      return result;
    }

    let packetArtifact: ArtifactEnvelope<ChapterPacket>;
    if (startsAfterPacket(options)) {
      packetArtifact = await loadArtifact<ChapterPacket>(
        chapterArtifactPath(options.chapterNumber, "packet"),
        "Chapter packet artifact",
        {
          ...artifactIdentity,
          artifactType: "chapter-packet",
        },
      );
      result.reusedArtifacts.push("chapter-packet");
    } else {
      console.error(`[ch${options.chapterNumber}] Building chapter packet...`);
      packetArtifact = await compileChapterPacket({
        chapterNumber: options.chapterNumber,
        blueprintArtifacts: compilation.artifacts,
      });
    }
    result.packetArtifactPath = chapterArtifactPath(options.chapterNumber, "packet");

    if (options.estimateCost) {
      result.costEstimateArtifactPath = await estimateChapterCost({
        chapterNumber: options.chapterNumber,
        blueprintArtifacts: compilation.artifacts,
        packet: packetArtifact.data,
        skipSpecCritique: options.skipSpecCritique,
        noGenreAi: options.noGenreAi || options.smoke,
      });
      return result;
    }

    if (options.packetOnly) {
      return result;
    }

    let approvedSpecArtifact: ArtifactEnvelope<ChapterSpec>;
    if (startsAfterSpec(options)) {
      approvedSpecArtifact = await loadArtifact<ChapterSpec>(
        chapterArtifactPath(options.chapterNumber, "approved-spec"),
        "Approved spec artifact",
        {
          ...artifactIdentity,
          artifactType: "approved-chapter-spec",
        },
      );
      result.reusedArtifacts.push("approved-chapter-spec");
    } else {
      const specLoop = await runSpecLoop({
        packetArtifact,
        blueprintArtifacts: compilation.artifacts,
        smoke: options.smoke,
        skipSpecCritique: options.skipSpecCritique,
      });
      approvedSpecArtifact = specLoop.approvedSpecArtifact;
      collectUsage(usages, config.stageProfiles.specGeneration.stageName, specLoop.specArtifact);
      collectUsage(usages, config.stageProfiles.selfRedTeam.stageName, specLoop.selfRedTeamArtifact);
      if (specLoop.opusCritiqueArtifact) {
        collectUsage(usages, config.stageProfiles.specCritique.stageName, specLoop.opusCritiqueArtifact);
      }
      collectUsage(usages, config.stageProfiles.specRevision.stageName, approvedSpecArtifact);
    }
    result.approvedSpecArtifactPath = chapterArtifactPath(options.chapterNumber, "approved-spec");

    if (options.specOnly) {
      return result;
    }

    let draftArtifact: ArtifactEnvelope<ChapterDraft>;
    if (startsAfterDraft(options)) {
      draftArtifact = await loadArtifact<ChapterDraft>(
        chapterArtifactPath(options.chapterNumber, "draft"),
        "Draft artifact",
        {
          ...artifactIdentity,
          artifactType: "chapter-draft",
        },
      );
      result.reusedArtifacts.push("chapter-draft");
    } else {
      console.error(`[ch${options.chapterNumber}] Drafting chapter...`);
      draftArtifact = await generateDraft({
        packetArtifact,
        approvedSpecArtifact,
        blueprintArtifacts: compilation.artifacts,
        smoke: options.smoke,
      });
      collectUsage(usages, config.stageProfiles.drafting.stageName, draftArtifact);
    }
    result.draftArtifactPath = chapterArtifactPath(options.chapterNumber, "draft");

    if (options.draftOnly) {
      return result;
    }

    let selectedArtifact: ArtifactEnvelope<SelectedChapter>;
    let selectedReviewArtifact: ArtifactEnvelope<DraftReview>;

    if (startsAfterJudge(options)) {
      selectedArtifact = await loadArtifact<SelectedChapter>(
        chapterArtifactPath(options.chapterNumber, "selected"),
        "Selected chapter artifact",
        {
          ...artifactIdentity,
          artifactType: "selected-chapter",
        },
      );
      selectedReviewArtifact = await loadArtifact<DraftReview>(
        chapterArtifactPath(options.chapterNumber, "review"),
        "Selected review artifact",
        artifactIdentity,
      );
      result.reusedArtifacts.push("selected-chapter");
      result.reusedArtifacts.push("selected-review");
    } else {
      console.error(`[ch${options.chapterNumber}] Judging draft...`);
      const draftReviewArtifact = await judgeDraft({
        candidateId: "draft",
        packetArtifact,
        approvedSpecArtifact,
        draftArtifact,
        blueprintArtifacts: compilation.artifacts,
        smoke: options.smoke,
      });
      collectUsage(usages, config.stageProfiles.literaryJudge.stageName, draftReviewArtifact);

      const skipThreshold = config.qualitySettings.skipRevisionThreshold;
      if (shouldSkipRevision({
        skipRevisionThreshold: skipThreshold,
        overallScore: draftReviewArtifact.data.overallScore,
        passesThreshold: draftReviewArtifact.data.passesThreshold,
        review: draftReviewArtifact.data,
      })) {
        console.error(
          `[run-chapter] Draft score ${draftReviewArtifact.data.overallScore} >= skipRevisionThreshold ${skipThreshold}; skipping revision.`,
        );

        const skipSelection: PairwiseSelection = {
          presentedOrder: ["draft", "revision"],
          rawWinner: "draft",
          finalWinner: "draft",
          scoreDelta: 0,
          withinTolerance: true,
          preservedOriginal: true,
          rationale: "Revision skipped because the draft exceeded skipRevisionThreshold with no blocking review signals.",
        };

        const selectionArtifact = createArtifact<PairwiseSelection>({
          artifactType: "pairwise-selection",
          blueprintHash: packetArtifact.blueprintHash,
          blueprintVersion: packetArtifact.blueprintVersion,
          chapterNumber: packetArtifact.chapterNumber,
          data: skipSelection,
        });
        await writeJson(chapterArtifactPath(options.chapterNumber, "selection"), selectionArtifact);

        selectedArtifact = createArtifact<SelectedChapter>({
          artifactType: "selected-chapter",
          blueprintHash: packetArtifact.blueprintHash,
          blueprintVersion: packetArtifact.blueprintVersion,
          chapterNumber: packetArtifact.chapterNumber,
          data: {
            winner: "draft",
            prose: draftArtifact.data.prose,
            wordCount: draftArtifact.data.wordCount,
            review: draftReviewArtifact.data,
            selection: skipSelection,
          },
        });
        await writeJson(chapterArtifactPath(options.chapterNumber, "selected"), selectedArtifact);

        selectedReviewArtifact = draftReviewArtifact;
        await writeJson(chapterArtifactPath(options.chapterNumber, "review"), selectedReviewArtifact);
      } else {
        console.error(`[ch${options.chapterNumber}] Revising chapter...`);
        const revisedDraftArtifact = await reviseDraft({
          packetArtifact,
          approvedSpecArtifact,
          draftArtifact,
          draftReviewArtifact,
          blueprintArtifacts: compilation.artifacts,
          smoke: options.smoke,
        });
        console.error(`[ch${options.chapterNumber}] Judging revision...`);
        const revisedReviewArtifact = await judgeDraft({
          candidateId: "revision",
          packetArtifact,
          approvedSpecArtifact,
          draftArtifact: revisedDraftArtifact,
          blueprintArtifacts: compilation.artifacts,
          smoke: options.smoke,
        });
        console.error(`[ch${options.chapterNumber}] Selecting winner...`);
        const selection = await selectDraft({
          packetArtifact,
          draftArtifact,
          draftReviewArtifact,
          revisedDraftArtifact,
          revisedReviewArtifact,
          blueprintArtifacts: compilation.artifacts,
          smoke: options.smoke,
        });

        selectedArtifact = selection.selectedArtifact;
        selectedReviewArtifact = selection.selectedReviewArtifact;
        collectUsage(usages, config.stageProfiles.revision.stageName, revisedDraftArtifact);
        collectUsage(usages, `${config.stageProfiles.literaryJudge.stageName}-revision`, revisedReviewArtifact);
        collectUsage(usages, config.stageProfiles.pairwiseSelection.stageName, selection.selectionArtifact);
      }
    }

    result.selectedArtifactPath = chapterArtifactPath(options.chapterNumber, "selected");

    if (!selectedReviewArtifact.data.passesThreshold) {
      result.status = "BLOCKED_QUALITY";
      result.statusArtifactPath = await writeStatusArtifact({
        chapterNumber: options.chapterNumber,
        blueprintHash: compilation.parsed.blueprintHash,
        blueprintVersion: compilation.parsed.metadata.blueprintVersion,
        status: "BLOCKED_QUALITY",
        stage: "literary-judge",
        message: "Selected chapter did not clear the literary quality threshold.",
        details: {
          overallScore: selectedReviewArtifact.data.overallScore,
          blockingIssues: selectedReviewArtifact.data.blockingIssues,
        },
      });
      return result;
    }

    // Post-selection enhancements (advisory + fail-soft; downstream consumes
    // `selected` unchanged on any thrown error). Order is critical: voice-grit
    // runs before the opening/ending tournament so the tournament still owns
    // its reserved zones (opening, ending, paragraph-end, scene-break leadout).
    if (!startsAfterJudge(options)) {
      if (!packetArtifact.data.voiceTarget) {
        console.error(`[ch${options.chapterNumber}] Voice-grit skipped: no voice-target available.`);
      } else {
        try {
          console.error(`[ch${options.chapterNumber}] Voice-grit pass...`);
          const gritResult = await runVoiceGritPass({
            packetArtifact,
            approvedSpecArtifact,
            selectedArtifact,
            selectedReviewArtifact,
            voiceTarget: packetArtifact.data.voiceTarget,
            blueprintArtifacts: compilation.artifacts,
            smoke: options.smoke,
          });
          selectedArtifact = gritResult.selectedArtifact;
          selectedReviewArtifact = gritResult.selectedReviewArtifact;
          for (const u of gritResult.usages) usages.push(u);
        } catch (error) {
          console.error(`[voice-grit] Outer failure, keeping selected as-is: ${(error as Error).message}`);
        }
      }

      try {
        console.error(`[ch${options.chapterNumber}] Opening/ending tournament...`);
        const tournamentResult = await runOpeningEndingTournament({
          packetArtifact,
          approvedSpecArtifact,
          selectedArtifact,
          selectedReviewArtifact,
          voiceTarget: packetArtifact.data.voiceTarget,
          blueprintArtifacts: compilation.artifacts,
          smoke: options.smoke,
        });
        selectedArtifact = tournamentResult.selectedArtifact;
        selectedReviewArtifact = tournamentResult.selectedReviewArtifact;
        for (const u of tournamentResult.usages) usages.push(u);
      } catch (error) {
        console.error(`[tournament] Outer failure, keeping selected as-is: ${(error as Error).message}`);
      }
    }

    if (options.judgeOnly) {
      return result;
    }

    const previousMemory = packetArtifact.data.rollingMemory;

    let deltaArtifact: ArtifactEnvelope<ChapterDelta>;
    let memoryArtifact: ArtifactEnvelope<RollingMemory>;

    if (startsAfterMemory(options)) {
      deltaArtifact = await loadArtifact<ChapterDelta>(
        chapterArtifactPath(options.chapterNumber, "delta"),
        "Chapter delta artifact",
        {
          ...artifactIdentity,
          artifactType: "chapter-delta",
        },
      );
      memoryArtifact = await loadArtifact<RollingMemory>(
        memoryArtifactPath(options.chapterNumber),
        "Rolling memory artifact",
        {
          ...artifactIdentity,
          artifactType: "rolling-memory",
        },
      );
      result.reusedArtifacts.push("chapter-delta");
      result.reusedArtifacts.push("rolling-memory");
    } else {
      console.error(`[ch${options.chapterNumber}] Extracting delta...`);
      deltaArtifact = await extractChapterDelta({
        packetArtifact,
        selectedArtifact,
        blueprintArtifacts: compilation.artifacts,
        previousMemory,
        smoke: options.smoke,
      });
      console.error(`[ch${options.chapterNumber}] Updating memory...`);
      memoryArtifact = await updateMemory({
        packetArtifact,
        deltaArtifact,
        previousMemory,
        smoke: options.smoke,
      });
      collectUsage(usages, config.stageProfiles.chapterDelta.stageName, deltaArtifact);
      collectUsage(usages, config.stageProfiles.memoryUpdate.stageName, memoryArtifact);
    }
    result.memoryArtifactPath = memoryArtifactPath(options.chapterNumber);

    // Publish-candidate snapshot. The prose entering the final audit is the
    // last version judged by the literary stack (pairwise + voice-grit +
    // tournament rejudges). Anything the fix loop produces downstream must
    // re-judge >= candidateScore - tolerance or the pipeline reverts here.
    const publishCandidateSnapshot: PublishCandidateSnapshot = {
      prose: selectedArtifact.data.prose,
      wordCount: selectedArtifact.data.wordCount,
      candidateScore: selectedReviewArtifact.data.overallScore,
      capturedAfter: "tournament",
      capturedAt: new Date().toISOString(),
    };
    const publishCandidateArtifact = createArtifact<PublishCandidateSnapshot>({
      artifactType: "publish-candidate",
      blueprintHash: selectedArtifact.blueprintHash,
      blueprintVersion: selectedArtifact.blueprintVersion,
      chapterNumber: selectedArtifact.chapterNumber,
      data: publishCandidateSnapshot,
    });
    await writeJson(
      chapterArtifactPath(options.chapterNumber, "publish-candidate"),
      publishCandidateArtifact,
    );
    const publishCandidateReviewArtifact = selectedReviewArtifact;

    console.error(`[ch${options.chapterNumber}] Running final audit...`);
    let auditRun = await runFinalAudit({
      packetArtifact,
      selectedArtifact,
      selectedReviewArtifact,
      deltaArtifact,
      memoryArtifact,
      previousMemory,
      blueprintArtifacts: compilation.artifacts,
      smoke: options.smoke,
    });
    collectUsage(usages, config.stageProfiles.finalAudit.stageName, auditRun.auditArtifact);
    result.auditArtifactPath = chapterArtifactPath(options.chapterNumber, "final-audit");
    const publishCandidateDeltaArtifact = deltaArtifact;
    const publishCandidateMemoryArtifact = memoryArtifact;
    const publishCandidateAuditArtifact = auditRun.auditArtifact;

    let currentSelectedArtifact = selectedArtifact;
    let currentDeltaArtifact = deltaArtifact;
    let currentMemoryArtifact = memoryArtifact;

    const maxFixAttempts = config.qualitySettings.maxFixAttempts;
    let fixAttempt = 0;
    let localizedAuditPatchApplied = false;
    let localizedAuditPatchAttempt = 0;
    let localizedPatchStale = false;
    while (hasBlockingAuditIssues(auditRun.auditArtifact.data) && fixAttempt < maxFixAttempts) {
      if (!localizedPatchStale) {
        const localizedPatchArtifact = await applyLocalizedAuditPatch({
          selectedArtifact: currentSelectedArtifact,
          auditArtifact: auditRun.auditArtifact,
          attemptNumber: localizedAuditPatchAttempt + 1,
        });
        if (localizedPatchArtifact) {
          localizedAuditPatchAttempt += 1;
          localizedAuditPatchApplied = true;
          console.error(
            `[ch${options.chapterNumber}] Localized audit patch attempt `
            + `${localizedAuditPatchAttempt}/${maxFixAttempts}...`,
          );
          currentSelectedArtifact = applyLocalizedAuditPatchResult(
            currentSelectedArtifact,
            localizedPatchArtifact,
          );
          await writeJson(chapterArtifactPath(options.chapterNumber, "selected"), currentSelectedArtifact);

          auditRun = await runFinalAudit({
            packetArtifact,
            selectedArtifact: currentSelectedArtifact,
            selectedReviewArtifact,
            deltaArtifact: currentDeltaArtifact,
            memoryArtifact: currentMemoryArtifact,
            previousMemory,
            blueprintArtifacts: compilation.artifacts,
            smoke: options.smoke,
          });
          collectUsage(
            usages,
            `${config.stageProfiles.finalAudit.stageName}-localized-${localizedAuditPatchAttempt}`,
            auditRun.auditArtifact,
          );
          if (!hasBlockingAuditIssues(auditRun.auditArtifact.data)) {
            break;
          }
        }
        localizedPatchStale = true;
      }

      // Validator-only blocking is a known false-positive surface. Refuse to
      // wholesale-rewrite a literary-judge-approved chapter for it; downgrade
      // the noise to warnings, persist the cleaned audit, and exit the loop.
      if (isValidatorOnlyBlocking(auditRun.auditArtifact.data)) {
        const downgraded = downgradeValidatorOnlyErrors(auditRun.auditArtifact.data);
        auditRun.auditArtifact = { ...auditRun.auditArtifact, data: downgraded };
        await writeJson(chapterArtifactPath(options.chapterNumber, "final-audit"), auditRun.auditArtifact);
        console.error(
          `[ch${options.chapterNumber}] Skipping wholesale continuity fix: only deterministic-validator errors remain. Downgraded to warnings.`,
        );
        break;
      }

      fixAttempt += 1;
      localizedPatchStale = false;
      console.error(`[ch${options.chapterNumber}] Continuity fix attempt ${fixAttempt}/${maxFixAttempts}...`);
      const fixArtifact = await fixContinuity({
        packetArtifact,
        selectedArtifact: currentSelectedArtifact,
        memoryArtifact: currentMemoryArtifact,
        auditArtifact: auditRun.auditArtifact,
        blueprintArtifacts: compilation.artifacts,
        attemptNumber: fixAttempt,
        smoke: options.smoke,
      });
      collectUsage(usages, `${config.stageProfiles.continuityFix.stageName}-${fixAttempt}`, fixArtifact);

      currentSelectedArtifact = applyFixResult(currentSelectedArtifact, fixArtifact);
      await writeJson(chapterArtifactPath(options.chapterNumber, "selected"), currentSelectedArtifact);

      currentDeltaArtifact = await extractChapterDelta({
        packetArtifact,
        selectedArtifact: currentSelectedArtifact,
        blueprintArtifacts: compilation.artifacts,
        previousMemory,
        smoke: options.smoke,
      });
      collectUsage(usages, `${config.stageProfiles.chapterDelta.stageName}-fix-${fixAttempt}`, currentDeltaArtifact);
      currentMemoryArtifact = await updateMemory({
        packetArtifact,
        deltaArtifact: currentDeltaArtifact,
        previousMemory,
        smoke: options.smoke,
      });
      collectUsage(usages, `${config.stageProfiles.memoryUpdate.stageName}-fix-${fixAttempt}`, currentMemoryArtifact);
      auditRun = await runFinalAudit({
        packetArtifact,
        selectedArtifact: currentSelectedArtifact,
        selectedReviewArtifact,
        deltaArtifact: currentDeltaArtifact,
        memoryArtifact: currentMemoryArtifact,
        previousMemory,
        blueprintArtifacts: compilation.artifacts,
        smoke: options.smoke,
      });
      const downgradedAuditData = downgradePostFixWordBandError(auditRun.auditArtifact.data);
      if (downgradedAuditData !== auditRun.auditArtifact.data) {
        auditRun.auditArtifact = { ...auditRun.auditArtifact, data: downgradedAuditData };
        await writeJson(chapterArtifactPath(options.chapterNumber, "final-audit"), auditRun.auditArtifact);
      }
      collectUsage(usages, `${config.stageProfiles.finalAudit.stageName}-fix-${fixAttempt}`, auditRun.auditArtifact);
    }

    if (hasBlockingAuditIssues(auditRun.auditArtifact.data)) {
      const finalLocalizedPatchArtifact = await applyLocalizedAuditPatch({
        selectedArtifact: currentSelectedArtifact,
        auditArtifact: auditRun.auditArtifact,
        attemptNumber: localizedAuditPatchAttempt + 1,
      });
      if (finalLocalizedPatchArtifact) {
        localizedAuditPatchAttempt += 1;
        localizedAuditPatchApplied = true;
        console.error(
          `[ch${options.chapterNumber}] Localized audit patch attempt `
          + `${localizedAuditPatchAttempt}/${maxFixAttempts + 1}...`,
        );
        currentSelectedArtifact = applyLocalizedAuditPatchResult(
          currentSelectedArtifact,
          finalLocalizedPatchArtifact,
        );
        await writeJson(chapterArtifactPath(options.chapterNumber, "selected"), currentSelectedArtifact);
        auditRun = await runFinalAudit({
          packetArtifact,
          selectedArtifact: currentSelectedArtifact,
          selectedReviewArtifact,
          deltaArtifact: currentDeltaArtifact,
          memoryArtifact: currentMemoryArtifact,
          previousMemory,
          blueprintArtifacts: compilation.artifacts,
          smoke: options.smoke,
        });
        collectUsage(
          usages,
          `${config.stageProfiles.finalAudit.stageName}-localized-${localizedAuditPatchAttempt}`,
          auditRun.auditArtifact,
        );
      }
    }

    if ((fixAttempt > 0 || localizedAuditPatchApplied)
      && currentSelectedArtifact.data.wordCount < packetArtifact.data.targetWordBand.min) {
      auditRun.auditArtifact = {
        ...auditRun.auditArtifact,
        data: {
          ...auditRun.auditArtifact.data,
          issues: [
            ...auditRun.auditArtifact.data.issues,
            {
              severity: "warning" as const,
              title: "POST_FIX_WORD_COUNT",
              description: `Post-fix word count ${currentSelectedArtifact.data.wordCount} is below target band minimum ${packetArtifact.data.targetWordBand.min}.`,
              fixInstruction: "Expand prose to meet the target word band without reintroducing continuity errors.",
            },
          ],
        },
      };
      await writeJson(chapterArtifactPath(options.chapterNumber, "final-audit"), auditRun.auditArtifact);
    }

    if (hasBlockingAuditIssues(auditRun.auditArtifact.data)) {
      // One final downgrade gate before failing the chapter: if everything
      // still blocking is validator-only, we trust the literary judge's
      // approval over the deterministic noise and publish anyway.
      if (isValidatorOnlyBlocking(auditRun.auditArtifact.data)) {
        const downgraded = downgradeValidatorOnlyErrors(auditRun.auditArtifact.data);
        auditRun.auditArtifact = { ...auditRun.auditArtifact, data: downgraded };
        await writeJson(chapterArtifactPath(options.chapterNumber, "final-audit"), auditRun.auditArtifact);
        console.error(
          `[ch${options.chapterNumber}] Publishing despite validator-only blocking issues; downgraded to warnings.`,
        );
      }
    }

    if (hasBlockingAuditIssues(auditRun.auditArtifact.data)) {
      result.status = "BLOCKED_AUDIT_FIX_LOOP_EXHAUSTED";
      result.statusArtifactPath = await writeStatusArtifact({
        chapterNumber: options.chapterNumber,
        blueprintHash: compilation.parsed.blueprintHash,
        blueprintVersion: compilation.parsed.metadata.blueprintVersion,
        status: "BLOCKED_AUDIT_FIX_LOOP_EXHAUSTED",
        stage: "final-audit",
        message: "Final audit still reports blocking errors after exhausting the surgical fix loop.",
        details: {
          attempts: maxFixAttempts,
          localizedAuditPatchAttempts: localizedAuditPatchAttempt,
          issues: auditRun.auditArtifact.data.issues,
        },
      });
      return result;
    }

    if (fixAttempt > 0 || localizedAuditPatchApplied) {
      console.error(
        `[ch${options.chapterNumber}] Re-judging after ${fixAttempt} fix(es)`
        + `${localizedAuditPatchApplied ? " and localized audit patching" : ""}...`,
      );
      selectedReviewArtifact = await judgeDraft({
        candidateId: currentSelectedArtifact.data.winner,
        packetArtifact,
        approvedSpecArtifact,
        draftArtifact: createSelectedDraftArtifact({
          selectedArtifact: currentSelectedArtifact,
          artifactType: "post-fix-draft",
        }),
        blueprintArtifacts: compilation.artifacts,
        smoke: options.smoke,
      });
      collectUsage(usages, `${config.stageProfiles.literaryJudge.stageName}-post-fix`, selectedReviewArtifact);

      currentSelectedArtifact = {
        ...currentSelectedArtifact,
        createdAt: new Date().toISOString(),
        data: {
          ...currentSelectedArtifact.data,
          review: selectedReviewArtifact.data,
        },
      };
      await writeJson(chapterArtifactPath(options.chapterNumber, "selected"), currentSelectedArtifact);
      await writeJson(chapterArtifactPath(options.chapterNumber, "review"), selectedReviewArtifact);

      // Publish-candidate immutability ratchet runs before the threshold
      // gate. The fix-loop just rewrote prose; if the rejudge regressed
      // beyond tolerance, OR fell below the literary threshold the
      // candidate had already cleared, revert. Later passes are allowed
      // to improve or repair, never to quietly degrade — including by
      // nudging a publishable candidate just under threshold.
      if (shouldRevertToPublishCandidate({
        candidateScore: publishCandidateSnapshot.candidateScore,
        postFixScore: selectedReviewArtifact.data.overallScore,
        tolerance: config.qualitySettings.publishCandidateRegressionTolerance,
        passThreshold: config.qualitySettings.judgePassThreshold,
        postFixPassesThreshold: selectedReviewArtifact.data.passesThreshold,
      })) {
        console.error(
          `[ch${options.chapterNumber}] Reverting to publish-candidate: post-fix score `
          + `${selectedReviewArtifact.data.overallScore.toFixed(2)} (passesThreshold=`
          + `${selectedReviewArtifact.data.passesThreshold}) vs candidate `
          + `${publishCandidateSnapshot.candidateScore.toFixed(2)}, tol `
          + `${config.qualitySettings.publishCandidateRegressionTolerance}, threshold `
          + `${config.qualitySettings.judgePassThreshold}.`,
        );
        currentSelectedArtifact = {
          ...currentSelectedArtifact,
          createdAt: new Date().toISOString(),
          data: {
            ...currentSelectedArtifact.data,
            prose: publishCandidateSnapshot.prose,
            wordCount: publishCandidateSnapshot.wordCount,
            review: publishCandidateReviewArtifact.data,
          },
        };
        selectedReviewArtifact = publishCandidateReviewArtifact;
        await writeJson(chapterArtifactPath(options.chapterNumber, "selected"), currentSelectedArtifact);
        await writeJson(chapterArtifactPath(options.chapterNumber, "review"), selectedReviewArtifact);

        currentDeltaArtifact = publishCandidateDeltaArtifact;
        currentMemoryArtifact = publishCandidateMemoryArtifact;
        auditRun.auditArtifact = {
          ...publishCandidateAuditArtifact,
          data: prepareRevertedPublishCandidateAudit(publishCandidateAuditArtifact.data),
        };
        await writeJson(chapterArtifactPath(options.chapterNumber, "delta"), currentDeltaArtifact);
        await writeJson(memoryArtifactPath(options.chapterNumber), currentMemoryArtifact);
        await writeJson(chapterArtifactPath(options.chapterNumber, "final-audit"), auditRun.auditArtifact);
      } else if (!selectedReviewArtifact.data.passesThreshold) {
        // No revert path available (candidate also under threshold) — block.
        const localizedOnly = localizedAuditPatchApplied && fixAttempt === 0;
        result.status = "BLOCKED_QUALITY";
        result.statusArtifactPath = await writeStatusArtifact({
          chapterNumber: options.chapterNumber,
          blueprintHash: compilation.parsed.blueprintHash,
          blueprintVersion: compilation.parsed.metadata.blueprintVersion,
          status: "BLOCKED_QUALITY",
          stage: localizedOnly ? "localized-audit-patch" : "continuity-fix",
          message: localizedOnly
            ? "Localized audit patch preserved continuity but nudged the selected chapter below the literary quality threshold."
            : "Continuity fixes pushed the selected chapter below the literary quality threshold.",
          details: {
            overallScore: selectedReviewArtifact.data.overallScore,
            blockingIssues: selectedReviewArtifact.data.blockingIssues,
          },
        });
        return result;
      }
    }

    console.error(`[ch${options.chapterNumber}] Publishing chapter...`);
    result.publishedChapterPath = await publishChapter(
      options.chapterNumber,
      currentSelectedArtifact.data.prose,
    );

    try {
      console.error(`[ch${options.chapterNumber}] Updating continuity state...`);
      await updateContinuityState({
        chapterNumber: options.chapterNumber,
        manifest: compilation.artifacts.continuityManifest.data,
        publishedProse: currentSelectedArtifact.data.prose,
        declaredReveals: buildDeclaredRevealsFromSpec({
          revealControl: approvedSpecArtifact.data.revealControl ?? null,
          chapterNumber: options.chapterNumber,
        }),
        chapterDelta: currentDeltaArtifact.data,
        blueprintHash: compilation.parsed.blueprintHash,
        blueprintVersion: compilation.parsed.metadata.blueprintVersion,
      });
    } catch (error) {
      console.error(`[continuity-state] Update failed (advisory), continuing: ${(error as Error).message}`);
    }

    try {
      console.error(`[ch${options.chapterNumber}] Extracting voice target...`);
      await extractAndPersistVoiceTarget({
        publishedThroughChapter: options.chapterNumber,
        blueprint: compilation.artifacts.compiledBlueprint.data,
        blueprintHash: compilation.parsed.blueprintHash,
        blueprintVersion: compilation.parsed.metadata.blueprintVersion,
      });
    } catch (error) {
      console.error(`[voice-calibration] Extraction failed (advisory), continuing: ${(error as Error).message}`);
    }

    result.costSummaryArtifactPath = await writeCostSummaryArtifact({
      chapterNumber: options.chapterNumber,
      usages,
      blueprintHash: compilation.parsed.blueprintHash,
      blueprintVersion: compilation.parsed.metadata.blueprintVersion,
    });

    result.statusArtifactPath = await writeStatusArtifact({
      chapterNumber: options.chapterNumber,
      blueprintHash: compilation.parsed.blueprintHash,
      blueprintVersion: compilation.parsed.metadata.blueprintVersion,
      status: "SUCCESS",
      stage: "publish",
      message: "Chapter passed literary judgment and final audit and was published.",
      details: {
        publishedChapterPath: result.publishedChapterPath,
      },
    });

    return result;
  } catch (error) {
    if (error instanceof BlockedPipelineError) {
      result.status = error.code;
      result.statusArtifactPath = await writeStatusArtifact({
        chapterNumber: options.chapterNumber,
        blueprintHash: parsedBlueprintIdentity.blueprintHash,
        blueprintVersion: parsedBlueprintIdentity.blueprintVersion,
        status: error.code,
        stage: error.stage,
        message: error.message,
        details: error.details,
      });
      return result;
    }

    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Blueprint validation failed")) {
      result.status = "BLOCKED_BLUEPRINT_UNDERSPECIFIED";
      result.statusArtifactPath = await writeStatusArtifact({
        chapterNumber: options.chapterNumber,
        blueprintHash: parsedBlueprintIdentity.blueprintHash,
        blueprintVersion: parsedBlueprintIdentity.blueprintVersion,
        status: "BLOCKED_BLUEPRINT_UNDERSPECIFIED",
        stage: "blueprint-validation",
        message,
      });
      return result;
    }

    if (message.startsWith("BLOCKED_BUDGET")) {
      result.status = "BLOCKED_BUDGET";
      result.statusArtifactPath = await writeStatusArtifact({
        chapterNumber: options.chapterNumber,
        blueprintHash: parsedBlueprintIdentity.blueprintHash,
        blueprintVersion: parsedBlueprintIdentity.blueprintVersion,
        status: "BLOCKED_BUDGET",
        stage: "token-budget",
        message,
      });
      return result;
    }

    if (message.startsWith("Missing required environment variable")) {
      result.status = "BLOCKED_RUNTIME_CONFIGURATION";
      result.statusArtifactPath = await writeStatusArtifact({
        chapterNumber: options.chapterNumber,
        blueprintHash: parsedBlueprintIdentity.blueprintHash,
        blueprintVersion: parsedBlueprintIdentity.blueprintVersion,
        status: "BLOCKED_RUNTIME_CONFIGURATION",
        stage: "configuration",
        message,
      });
      return result;
    }

    throw error;
  }
}
