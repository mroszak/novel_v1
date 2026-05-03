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

    // Post-selection enhancement: opening/ending tournament. Advisory and
    // fail-soft; if it throws, downstream consumes `selected` unchanged.
    if (!startsAfterJudge(options)) {
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

      if (!selectedReviewArtifact.data.passesThreshold) {
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
