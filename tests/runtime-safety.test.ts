import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildHandoff } from "../src/pipeline/build-handoff.js";
import { buildRollingMemory, normalizeRollingMemory } from "../src/pipeline/build-rolling-memory.js";
import { buildChapterDeltaRequest } from "../src/pipeline/extract-chapter-delta.js";
import { buildSpecGenerationRequest, shouldRunOpusCritique } from "../src/pipeline/generate-spec.js";
import {
  buildLocalizedAuditPatchResult,
} from "../src/pipeline/localized-audit-patch.js";
import {
  calculateOverallScore,
  derivePassesThreshold,
  normalizeReviewScale,
} from "../src/pipeline/judge-draft.js";
import { buildSpecPacketView } from "../src/pipeline/prompt-packet-views.js";
import { buildFinalAuditPrompt } from "../src/pipeline/final-audit.js";
import { downgradePostFixWordBandError, hasBlockingAuditIssues, shouldSkipRevision } from "../src/pipeline/run-chapter.js";
import { resolveSelectionDecision } from "../src/pipeline/select-draft.js";
import { createSmokeDelta, createSmokeMemory, createSmokeReview, createSmokeSelection, createSmokeValidatorReport } from "../src/pipeline/smoke-helpers.js";
import { BlockedPipelineError, createArtifact, loadArtifact } from "../src/pipeline/stage-utils.js";
import { runDeterministicValidators } from "../src/validators/index.js";
import {
  checkDialogueTags,
  checkParagraphDistribution,
  detectFilterWords,
  detectKnowledgeLeaks,
  detectRepetition,
} from "../src/validators/prose-quality.js";
import { config } from "../src/config.js";
import { estimateOpenAiPromptTokens, estimateTextTokens } from "../src/metrics/token-budget.js";
import { stripMemoryPacketFields } from "../src/pipeline/update-memory.js";
import { compactJson, tailExcerpt } from "../src/utils/index.js";
import type {
  ArtifactEnvelope,
  BlueprintCompilationArtifacts,
  ChapterDelta,
  ChapterDraft,
  ChapterPacket,
  CompiledStoryBlueprint,
  DraftReview,
  FinalAuditReport,
  GenreContract,
  MemoryUpdateProposal,
  RollingMemory,
  SelectedChapter,
  SelfRedTeamReport,
} from "../src/types/index.js";

function makeReview(overrides: Partial<DraftReview> = {}): DraftReview {
  return {
    candidateId: "revision",
    overallScore: 91,
    passesThreshold: true,
    scoreBreakdown: {
      beatCoverage: 92,
      tension: 91,
      forwardMotion: 90,
      characterTruth: 89,
      voiceConsistency: 90,
      specificity: 93,
      thematicEmbodiment: 90,
      openingPower: 92,
      endingHookStrength: 91,
      revealControl: 90,
      freshness: 89,
      repetitionPenalty: 8,
      proseQuality: 90,
      dialogueAuthenticity: 89,
      sensoryImmersion: 91,
    },
    strengths: ["Strong mechanical clarity."],
    weaknesses: ["Minor line-level polish."],
    blockingIssues: [],
    revisionActions: [],
    issues: [],
    summary: "A strong pass.",
    ...overrides,
  };
}

test("buildRollingMemory preserves prior continuity state when proposal is partial", () => {
  const previousMemory = {
    storySpine: "Original spine",
    unresolvedThreads: ["Lena's scar still matters", "Director Sloane is still watching"],
    activePressures: ["The archive is closing in"],
    knowledgeMatrix: [
      {
        character: "Lena Vale",
        knows: ["The route was altered"],
        suspects: [],
        hides: [],
        mustNotKnowYet: ["She must not know the architect yet."],
      },
      {
        character: "Director Sloane",
        knows: ["The city has already been rewritten"],
        suspects: [],
        hides: ["The original consent trail"],
        mustNotKnowYet: [],
      },
    ],
    activeCharacterVoiceCards: [
      {
        character: "Lena Vale",
        activeTraits: ["Clipped under pressure"],
        stressPattern: "She gets quieter when cornered.",
        dialogueHabits: ["Deflects direct questions"],
        tabooNotes: ["Do not name the architect"],
        updatedFromChapter: 1,
      },
      {
        character: "Director Sloane",
        activeTraits: ["Managerial certainty"],
        stressPattern: "She treats damage as administration.",
        dialogueHabits: ["Answers with policy language"],
        tabooNotes: [],
        updatedFromChapter: 1,
      },
    ],
    revealPayoffLedger: [],
    nextChapterOpeningHandoff: {
      openingSituation: "Open in the aftermath.",
      physicalState: ["Nothing has reset."],
      emotionalState: ["Trust is worse."],
      causalState: ["The consequence is active."],
      mandatoryCallbacks: ["Lena's scar still matters"],
      characterStates: [],
    },
    compressedHistory: ["Chapter 0 setup"],
    lastChapterSummary: "Chapter 1 left Lena exposed.",
    emotionalStates: [],
  };

  const delta = {
    entityMentions: [],
    sceneLedgerDelta: [],
    knowledgeChanges: [
      {
        holder: "Lena Vale",
        gainedKnowledge: "Adrian knew the package before she spoke.",
        suspects: ["Adrian is withholding more than one fact."],
        hides: [],
        source: "Chapter 2",
      },
    ],
    irreversibleChanges: [],
    plotThreadProgression: [
      {
        thread: "A resolved false lead",
        previousStatus: "active",
        newStatus: "closed",
        update: "The lead collapsed.",
        resolved: true,
      },
    ],
    revealPayoffMovement: [],
    activePressures: ["Adrian now knows too much"],
    unresolvedThreads: ["The package is still dangerous to keep"],
    nextChapterOpeningHandoff: "Open from the package's immediate fallout.",
    activeVoiceSignals: [
      {
        character: "Lena Vale",
        voiceNotes: ["Cuts straight to logistics when afraid."],
      },
    ],
    storySpineUpdate: "The story pressure tightens around the package.",
    characterEmotionalStates: [],
  };

  const proposal = {
    storySpine: "Original spine under harder pressure",
    unresolvedThreads: ["The package is still dangerous to keep"],
    activePressures: ["Adrian now knows too much"],
    knowledgeMatrix: [
      {
        character: "Lena Vale",
        knows: ["The package is being tracked"],
        suspects: [],
        hides: [],
        mustNotKnowYet: ["She must not know the architect yet."],
      },
    ],
    activeCharacterVoiceCards: [
      {
        character: "Lena Vale",
        activeTraits: ["Sharper under suspicion"],
        stressPattern: "She turns colder under pressure.",
        dialogueHabits: ["Cuts straight to the point"],
        tabooNotes: ["Do not name the architect"],
        updatedFromChapter: 2,
      },
    ],
    nextChapterOpeningHandoff: {
      openingSituation: "Open in the package fallout.",
      physicalState: ["The package is still in play."],
      emotionalState: ["Trust is actively degrading."],
      causalState: ["Adrian's knowledge changes the next move."],
      mandatoryCallbacks: ["The package is still dangerous to keep"],
      characterStates: [],
    },
    compressedHistory: ["Chapter 1 left Lena exposed."],
    lastChapterSummary: "Chapter 2 tightened the package pressure.",
    emotionalStates: [],
  };

  const memory = buildRollingMemory({
    previousMemory,
    delta,
    proposal,
    chapterNumber: 2,
  });

  assert.ok(memory.unresolvedThreads.includes("Lena's scar still matters"));
  assert.ok(memory.unresolvedThreads.includes("The package is still dangerous to keep"));
  assert.ok(memory.activePressures.includes("The archive is closing in"));
  assert.ok(memory.activePressures.includes("Adrian now knows too much"));
  assert.ok(memory.knowledgeMatrix.some((entry) => entry.character === "Director Sloane"));

  const lenaKnowledge = memory.knowledgeMatrix.find((entry) => entry.character === "Lena Vale");
  assert.ok(lenaKnowledge);
  assert.ok(lenaKnowledge.knows.includes("The route was altered"));
  assert.ok(lenaKnowledge.knows.includes("The package is being tracked"));
  assert.ok(lenaKnowledge.knows.includes("Adrian knew the package before she spoke."));

  assert.ok(memory.activeCharacterVoiceCards.some((card) => card.character === "Director Sloane"));
  assert.ok(memory.compressedHistory.includes("Chapter 0 setup"));
  assert.equal(memory.lastChapterSummary, "Chapter 2 tightened the package pressure.");
});

test("normalizeReviewScale rescales 10-point literary judge output before thresholding", () => {
  const review = makeReview({
    overallScore: 9.18,
    passesThreshold: false,
    scoreBreakdown: {
      beatCoverage: 9.7,
      tension: 9.3,
      forwardMotion: 9.2,
      characterTruth: 8.9,
      voiceConsistency: 9.2,
      specificity: 9.5,
      thematicEmbodiment: 9.0,
      openingPower: 9.5,
      endingHookStrength: 9.4,
      revealControl: 9.2,
      freshness: 8.9,
      repetitionPenalty: 1.1,
      proseQuality: 9.1,
      dialogueAuthenticity: 8.8,
      sensoryImmersion: 9.2,
    },
    issues: [
      {
        severity: "info",
        category: "line-level polish",
        detail: "Only minor tightening remains.",
        evidence: undefined,
        suggestedFix: undefined,
      },
    ],
  });

  const normalized = normalizeReviewScale(review);
  assert.equal(normalized.scoreBreakdown.tension, 93);
  assert.equal(normalized.scoreBreakdown.repetitionPenalty, 11);

  const overallScore = calculateOverallScore(normalized.scoreBreakdown, {});
  assert.ok(overallScore >= 90);
  assert.equal(
    derivePassesThreshold({ ...normalized, overallScore }, 86),
    true,
  );
});

test("normalizeReviewScale leaves 100-point reviews untouched", () => {
  const review = makeReview({
    overallScore: 89.86,
    scoreBreakdown: {
      beatCoverage: 93,
      tension: 90,
      forwardMotion: 91,
      characterTruth: 88,
      voiceConsistency: 88,
      specificity: 95,
      thematicEmbodiment: 91,
      openingPower: 92,
      endingHookStrength: 94,
      revealControl: 78,
      freshness: 87,
      repetitionPenalty: 9,
      proseQuality: 90,
      dialogueAuthenticity: 87,
      sensoryImmersion: 91,
    },
  });

  assert.deepEqual(normalizeReviewScale(review), review);
});

test("derivePassesThreshold fails reviews with explicit blocking signals", () => {
  const review = makeReview({
    blockingIssues: [],
    issues: [
      {
        severity: "error",
        category: "revealControl",
        detail: "The chapter leaks a withheld reveal too early.",
        evidence: undefined,
        suggestedFix: undefined,
      },
    ],
  });

  assert.equal(derivePassesThreshold(review, 86), false);
});

test("resolveSelectionDecision prefers the only passing candidate", () => {
  const decision = resolveSelectionDecision({
    rawWinner: "revision",
    rawRationale: "Revision reads slightly cleaner in isolation.",
    withinTolerance: false,
    draftPassed: true,
    revisionPassed: false,
  });

  assert.equal(decision.finalWinner, "draft");
  assert.equal(decision.preservedOriginal, false);
  assert.match(decision.rationale, /only candidate that passed the literary threshold/i);
});

test("loadArtifact rejects reused artifacts with mismatched metadata", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "novel-artifact-test-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const artifactPath = path.join(tempDir, "packet.json");
  const artifact = createArtifact({
    artifactType: "chapter-packet",
    blueprintHash: "correct-hash",
    blueprintVersion: "1.0.0",
    chapterNumber: 1,
    data: { ok: true },
  });
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2), "utf8");

  await assert.rejects(
    () => loadArtifact(artifactPath, "Chapter packet artifact", {
      artifactType: "chapter-packet",
      blueprintHash: "different-hash",
      blueprintVersion: "1.0.0",
      chapterNumber: 1,
    }),
    /metadata mismatch/i,
  );
});

test("normalizeRollingMemory keeps the more specific statement during de-dupe", () => {
  const memory: RollingMemory = {
    storySpine: "Test spine",
    unresolvedThreads: [],
    activePressures: [],
    knowledgeMatrix: [{
      character: "Adrian",
      knows: [
        "Adrian knows the package location",
        "Adrian knows the package location and the package key",
      ],
      suspects: [],
      hides: [],
      mustNotKnowYet: [],
    }],
    activeCharacterVoiceCards: [],
    revealPayoffLedger: [],
    nextChapterOpeningHandoff: {
      openingSituation: "Open.",
      physicalState: [],
      emotionalState: [],
      causalState: [],
      mandatoryCallbacks: [],
      characterStates: [],
    },
    compressedHistory: [],
    lastChapterSummary: "Test summary",
    emotionalStates: [],
  };

  const normalized = normalizeRollingMemory(memory);
  const adrianKnows = normalized.knowledgeMatrix.find((e) => e.character === "Adrian")!.knows;
  assert.ok(
    adrianKnows.some((s) => s.includes("package key")),
    "De-dupe must keep the more specific statement containing 'package key'",
  );
});

test("buildRollingMemory routes delta voiceNotes only to activeTraits, not tabooNotes or dialogueHabits", () => {
  const memory = buildRollingMemory({
    previousMemory: null,
    delta: {
      entityMentions: [],
      sceneLedgerDelta: [],
      knowledgeChanges: [],
      irreversibleChanges: [],
      plotThreadProgression: [],
      revealPayoffMovement: [],
      activePressures: [],
      unresolvedThreads: [],
      nextChapterOpeningHandoff: "Open cold.",
      activeVoiceSignals: [{
        character: "Lena Vale",
        voiceNotes: ["Cuts straight to logistics when afraid."],
      }],
      storySpineUpdate: "A story.",
      characterEmotionalStates: [],
    },
    proposal: {
      storySpine: "A story.",
      unresolvedThreads: [],
      activePressures: [],
      knowledgeMatrix: [],
      activeCharacterVoiceCards: [],
      nextChapterOpeningHandoff: {
        openingSituation: "Open.",
        physicalState: [],
        emotionalState: [],
        causalState: [],
        mandatoryCallbacks: [],
        characterStates: [],
      },
      compressedHistory: [],
      lastChapterSummary: "Summary.",
      emotionalStates: [],
    },
    chapterNumber: 3,
  });

  const card = memory.activeCharacterVoiceCards.find((c) => c.character === "Lena Vale")!;
  assert.ok(card.activeTraits.includes("Cuts straight to logistics when afraid."));
  assert.deepEqual(card.tabooNotes, [], "voiceNotes must not leak into tabooNotes");
  assert.deepEqual(card.dialogueHabits, [], "voiceNotes must not leak into dialogueHabits");
  assert.equal(card.updatedFromChapter, 3, "New voice cards must carry the current chapter number");
});

test("buildRollingMemory advances updatedFromChapter on existing cards touched by delta signals", () => {
  const memory = buildRollingMemory({
    previousMemory: {
      storySpine: "Spine.",
      unresolvedThreads: [],
      activePressures: [],
      knowledgeMatrix: [],
      activeCharacterVoiceCards: [{
        character: "Lena Vale",
        activeTraits: ["Clipped under pressure"],
        stressPattern: "Gets quieter when cornered.",
        dialogueHabits: ["Deflects direct questions"],
        tabooNotes: ["Do not name the architect"],
        updatedFromChapter: 1,
      }],
      revealPayoffLedger: [],
      nextChapterOpeningHandoff: {
        openingSituation: "Open.",
        physicalState: [],
        emotionalState: [],
        causalState: [],
        mandatoryCallbacks: [],
        characterStates: [],
      },
      compressedHistory: [],
      lastChapterSummary: "Summary.",
      emotionalStates: [],
    },
    delta: {
      entityMentions: [],
      sceneLedgerDelta: [],
      knowledgeChanges: [],
      irreversibleChanges: [],
      plotThreadProgression: [],
      revealPayoffMovement: [],
      activePressures: [],
      unresolvedThreads: [],
      nextChapterOpeningHandoff: "Continue.",
      activeVoiceSignals: [{
        character: "Lena Vale",
        voiceNotes: ["Switches to clipped commands under threat."],
      }],
      storySpineUpdate: "",
      characterEmotionalStates: [],
    },
    proposal: {
      storySpine: "Spine.",
      unresolvedThreads: [],
      activePressures: [],
      knowledgeMatrix: [],
      activeCharacterVoiceCards: [],
      nextChapterOpeningHandoff: {
        openingSituation: "Open.",
        physicalState: [],
        emotionalState: [],
        causalState: [],
        mandatoryCallbacks: [],
        characterStates: [],
      },
      compressedHistory: [],
      lastChapterSummary: "Summary.",
      emotionalStates: [],
    },
    chapterNumber: 3,
  });

  const card = memory.activeCharacterVoiceCards.find((c) => c.character === "Lena Vale")!;
  assert.equal(card.updatedFromChapter, 3, "Existing card must advance to current chapter when touched by delta");
  assert.deepEqual(card.dialogueHabits, ["Deflects direct questions"], "dialogueHabits must not gain delta voiceNotes");
  assert.deepEqual(card.tabooNotes, ["Do not name the architect"], "tabooNotes must not gain delta voiceNotes");
});

test("shouldRunOpusCritique still runs required critique when --skip-spec-critique is set", () => {
  const makePacketArtifact = (riskLevel: "low" | "medium" | "high") =>
    createArtifact<ChapterPacket>({
      artifactType: "chapter-packet",
      blueprintHash: "h",
      blueprintVersion: "1.0.0",
      chapterNumber: 1,
      data: { riskLevel } as ChapterPacket,
    });

  const noEscalation: SelfRedTeamReport = {
    criticalIssues: [],
    weaknesses: [],
    missingBeats: [],
    confidenceScore: 0.9,
    needsOpusEscalation: false,
    revisionActions: [],
  };
  const withEscalation: SelfRedTeamReport = { ...noEscalation, needsOpusEscalation: true };

  const highSkip = shouldRunOpusCritique(makePacketArtifact("high"), noEscalation, true);
  assert.equal(highSkip.run, true, "High-risk + skip => critique still runs");
  assert.equal(highSkip.required, true);

  const escalatedSkip = shouldRunOpusCritique(makePacketArtifact("low"), withEscalation, true);
  assert.equal(escalatedSkip.run, true, "Escalated + skip => critique still runs");
  assert.equal(escalatedSkip.required, true);
});

test("hasBlockingAuditIssues blocks on requiresFix even without error-severity issues", () => {
  assert.equal(
    hasBlockingAuditIssues({
      requiresFix: true,
      issues: [{ severity: "warning" }],
    }),
    true,
    "requiresFix=true should block even if no error-severity issues exist",
  );

  assert.equal(
    hasBlockingAuditIssues({
      requiresFix: false,
      issues: [{ severity: "error" }],
    }),
    true,
    "error-severity issues should still block",
  );

  assert.equal(
    hasBlockingAuditIssues({
      requiresFix: false,
      issues: [{ severity: "warning" }],
    }),
    false,
    "No requiresFix and no errors should not block",
  );
});

test("createSmokeReview fails draft under max quality threshold", () => {
  const draft: ChapterDraft = { prose: "Smoke prose.", wordCount: 50 };
  const maxThreshold = config.qualitySettings.judgePassThreshold;

  const draftReview = createSmokeReview("draft", draft, maxThreshold);
  assert.ok(draftReview.overallScore < maxThreshold, `Draft derived score ${draftReview.overallScore} must be below max threshold ${maxThreshold}`);
  assert.equal(draftReview.passesThreshold, false, "Draft must fail max threshold");

  const revisionReview = createSmokeReview("revision", draft, maxThreshold);
  assert.ok(revisionReview.overallScore >= maxThreshold, `Revision derived score ${revisionReview.overallScore} must clear max threshold ${maxThreshold}`);
  assert.equal(revisionReview.passesThreshold, true, "Revision must pass max threshold");
});

test("createSmokeSelection uses real pairwise tolerance from quality profile", () => {
  const draft: ChapterDraft = { prose: "Smoke prose.", wordCount: 50 };
  const draftReview = createSmokeReview("draft", draft, 78);
  const revisedReview = createSmokeReview("revision", draft, 78);

  const scoreDelta = revisedReview.overallScore - draftReview.overallScore;
  assert.ok(scoreDelta > 0, "Revision must outscore draft");

  const maxTolerance = config.qualitySettings.pairwiseTolerance;
  const maxSelection = createSmokeSelection(draftReview, revisedReview, maxTolerance);
  assert.ok(scoreDelta > maxTolerance, `Score delta ${scoreDelta} must exceed max tolerance ${maxTolerance}`);
  assert.equal(maxSelection.withinTolerance, false, "Must be outside max tolerance");
  assert.equal(maxSelection.finalWinner, "revision", "Revision must win when outside max tolerance");
});

test("createSmokeReview honors provided judge weights", () => {
  const draft: ChapterDraft = { prose: "Smoke prose.", wordCount: 50 };
  const weights = { repetitionPenalty: 5 };

  const unweighted = createSmokeReview("revision", draft, 0);
  const weighted = createSmokeReview("revision", draft, 0, weights);

  assert.notEqual(weighted.overallScore, unweighted.overallScore);
  assert.equal(weighted.overallScore, calculateOverallScore(weighted.scoreBreakdown, weights));
});

test("mandatory beat coverage failure produces BlockedPipelineError with exit-2 semantics", () => {
  const error = new BlockedPipelineError(
    "BLOCKED_QUALITY",
    "spec-revision",
    "Approved spec is missing mandatory beat coverage for: test beat",
    { missingBeats: ["test beat"] },
  );
  assert.ok(error instanceof BlockedPipelineError);
  assert.ok(error instanceof Error);
  assert.equal(error.code, "BLOCKED_QUALITY");
  assert.equal(error.stage, "spec-revision");
  assert.deepEqual(error.details, { missingBeats: ["test beat"] });
});

test("buildHandoff uses proposal characterStates as authoritative, not delta emotionalRegister", () => {
  const proposal: MemoryUpdateProposal = {
    storySpine: "Spine.",
    unresolvedThreads: [],
    activePressures: [],
    knowledgeMatrix: [],
    activeCharacterVoiceCards: [],
    nextChapterOpeningHandoff: {
      openingSituation: "Open in tension.",
      physicalState: ["Old flat physical."],
      emotionalState: ["Old flat emotional."],
      causalState: ["Continue."],
      mandatoryCallbacks: [],
      characterStates: [
        { character: "Lena Vale", physicalState: "Standing in the corridor.", emotionalState: "Wary and calculating." },
      ],
    },
    compressedHistory: [],
    lastChapterSummary: "Summary.",
    emotionalStates: [],
  };

  const delta: ChapterDelta = {
    entityMentions: [],
    sceneLedgerDelta: [],
    knowledgeChanges: [],
    irreversibleChanges: [],
    plotThreadProgression: [],
    revealPayoffMovement: [],
    activePressures: [],
    unresolvedThreads: [],
    nextChapterOpeningHandoff: "Continue from fallout.",
    activeVoiceSignals: [],
    storySpineUpdate: "",
    characterEmotionalStates: [{
      character: "Lena Vale",
      currentBelief: "Believes the system failed.",
      currentDoubt: "Doubts her own judgment.",
      emotionalRegister: "Raw and exposed.",
      arcDistance: "Midpoint.",
    }],
  };

  const handoff = buildHandoff(proposal, delta);

  assert.equal(handoff.characterStates.length, 1);
  const lenaState = handoff.characterStates[0]!;
  assert.equal(lenaState.emotionalState, "Wary and calculating.",
    "Proposal's next-chapter-entry state must be authoritative, not delta's chapter-end register");
  assert.ok(handoff.physicalState[0]?.includes("Standing in the corridor."),
    "Flat physicalState must derive from characterStates");
  assert.ok(handoff.emotionalState[0]?.includes("Wary and calculating."),
    "Flat emotionalState must derive from characterStates");
});

test("buildHandoff falls back to flat arrays when proposal characterStates is empty", () => {
  const proposal: MemoryUpdateProposal = {
    storySpine: "Spine.",
    unresolvedThreads: [],
    activePressures: [],
    knowledgeMatrix: [],
    activeCharacterVoiceCards: [],
    nextChapterOpeningHandoff: {
      openingSituation: "Open.",
      physicalState: ["The wreckage is still warm."],
      emotionalState: ["Trust is fractured."],
      causalState: [],
      mandatoryCallbacks: [],
      characterStates: [],
    },
    compressedHistory: [],
    lastChapterSummary: "Summary.",
    emotionalStates: [],
  };

  const delta: ChapterDelta = {
    entityMentions: [],
    sceneLedgerDelta: [],
    knowledgeChanges: [],
    irreversibleChanges: [],
    plotThreadProgression: [],
    revealPayoffMovement: [],
    activePressures: [],
    unresolvedThreads: [],
    nextChapterOpeningHandoff: "Continue.",
    activeVoiceSignals: [],
    storySpineUpdate: "",
    characterEmotionalStates: [{
      character: "Lena Vale",
      currentBelief: "Belief.",
      currentDoubt: "Doubt.",
      emotionalRegister: "Raw.",
      arcDistance: "Midpoint.",
    }],
  };

  const handoff = buildHandoff(proposal, delta);

  assert.deepEqual(handoff.physicalState, ["The wreckage is still warm."],
    "Empty characterStates must fall back to proposal's flat physicalState");
  assert.deepEqual(handoff.emotionalState, ["Trust is fractured."],
    "Empty characterStates must fall back to proposal's flat emotionalState");
  assert.deepEqual(handoff.characterStates, [],
    "Delta emotional states must not leak into handoff characterStates");
});

test("buildRollingMemory merges emotionalStates with newest chapter winning per character", () => {
  const memory = buildRollingMemory({
    previousMemory: {
      storySpine: "Spine.",
      unresolvedThreads: [],
      activePressures: [],
      knowledgeMatrix: [],
      activeCharacterVoiceCards: [],
      revealPayoffLedger: [],
      nextChapterOpeningHandoff: {
        openingSituation: "Open.",
        physicalState: [],
        emotionalState: [],
        causalState: [],
        mandatoryCallbacks: [],
        characterStates: [],
      },
      compressedHistory: [],
      lastChapterSummary: "Summary.",
      emotionalStates: [{
        character: "Lena Vale",
        currentBelief: "Old belief.",
        currentDoubt: "Old doubt.",
        emotionalRegister: "Controlled.",
        arcDistance: "Early.",
      }, {
        character: "Director Sloane",
        currentBelief: "The system works.",
        currentDoubt: "None visible.",
        emotionalRegister: "Bureaucratic certainty.",
        arcDistance: "Static.",
      }],
    },
    delta: {
      entityMentions: [],
      sceneLedgerDelta: [],
      knowledgeChanges: [],
      irreversibleChanges: [],
      plotThreadProgression: [],
      revealPayoffMovement: [],
      activePressures: [],
      unresolvedThreads: [],
      nextChapterOpeningHandoff: "Continue.",
      activeVoiceSignals: [],
      storySpineUpdate: "Updated.",
      characterEmotionalStates: [{
        character: "Lena Vale",
        currentBelief: "Delta belief wins.",
        currentDoubt: "Delta doubt.",
        emotionalRegister: "Sharpened.",
        arcDistance: "Midpoint.",
      }],
    },
    proposal: {
      storySpine: "Updated.",
      unresolvedThreads: [],
      activePressures: [],
      knowledgeMatrix: [],
      activeCharacterVoiceCards: [],
      nextChapterOpeningHandoff: {
        openingSituation: "Open.",
        physicalState: [],
        emotionalState: [],
        causalState: [],
        mandatoryCallbacks: [],
        characterStates: [],
      },
      compressedHistory: [],
      lastChapterSummary: "Summary.",
      emotionalStates: [{
        character: "Lena Vale",
        currentBelief: "Proposal belief.",
        currentDoubt: "Proposal doubt.",
        emotionalRegister: "Proposal register.",
        arcDistance: "Proposal arc.",
      }],
    },
    chapterNumber: 3,
  });

  const lena = memory.emotionalStates.find((s) => s.character === "Lena Vale");
  assert.ok(lena);
  assert.equal(lena.currentBelief, "Delta belief wins.",
    "Delta (newest) must override proposal for the same character");

  const sloane = memory.emotionalStates.find((s) => s.character === "Director Sloane");
  assert.ok(sloane, "Untouched characters must be preserved from previousMemory");
  assert.equal(sloane.currentBelief, "The system works.");
});

// --- Prose validator tests ---

test("detectRepetition flags 4-word phrases repeated 4+ times as errors", () => {
  const prose = [
    "The corridor closed around her as the lights flickered overhead.",
    "The corridor closed around her while she pressed forward into the dark.",
    "Again the corridor closed around her and she faltered at the threshold.",
    "Once more the corridor closed around her, and she did not stop.",
    "Beyond the door, everything changed.",
  ].join("\n\n");

  const issues = detectRepetition(prose);
  assert.ok(
    issues.some((i) => i.severity === "error" && i.code === "REPETITION"),
    "Must flag 4+ repetitions as error",
  );
});

test("detectRepetition flags exactly 3 repetitions as warning, not error", () => {
  const prose = [
    "The corridor closed around her as the lights flickered overhead.",
    "The corridor closed around her while she pressed forward into the dark.",
    "Again the corridor closed around her and she faltered at the threshold.",
    "Beyond the door, everything changed.",
  ].join("\n\n");

  const issues = detectRepetition(prose);
  const repIssues = issues.filter((i) => i.code === "REPETITION");
  assert.ok(
    repIssues.some((i) => i.severity === "warning"),
    "3 occurrences must produce a warning",
  );
  assert.ok(
    !repIssues.some((i) => i.severity === "error"),
    "3 occurrences must NOT produce an error (4+ is the new threshold)",
  );
});

test("detectRepetition does not flag exactly 2 occurrences", () => {
  const prose = [
    "She held the line and the line held her.",
    "The harbor lights blinked once on the far side of the channel.",
    "On the far side of the channel, the lighthouse kept its rhythm.",
  ].join("\n\n");

  const issues = detectRepetition(prose);
  const repIssues = issues.filter((i) => i.code === "REPETITION");
  assert.equal(
    repIssues.length,
    0,
    "Two occurrences of a 4-word span are incidental and must not flag at all",
  );
});

test("detectRepetition ignores trivial stop-word-only phrases", () => {
  const prose = [
    "She had been with them for the first time in years.",
    "He had been with them through the worst of it.",
    "They had been with them when everything fell apart.",
  ].join("\n\n");

  const issues = detectRepetition(prose);
  const errors = issues.filter((i) => i.severity === "error" && i.code === "REPETITION");
  assert.equal(errors.length, 0, "Stop-word-heavy phrases must not produce errors");
});

test("detectRepetition surfaces duplicate paragraphs as DUPLICATE_PARAGRAPH then deduplicates for n-gram analysis", () => {
  const paragraph = "The pressure mounted steadily through the scene, and the characters responded with precision and restraint.";
  const prose = Array.from({ length: 5 }, () => paragraph).join("\n\n");

  const issues = detectRepetition(prose);
  assert.ok(
    issues.some((i) => i.code === "DUPLICATE_PARAGRAPH" && i.severity === "error"),
    "Must surface DUPLICATE_PARAGRAPH error for exact copies",
  );
  const ngramErrors = issues.filter((i) => i.code === "REPETITION" && i.severity === "error");
  assert.equal(ngramErrors.length, 0, "N-gram analysis must operate on deduped text");
});

test("detectFilterWords flags high density of filter words", () => {
  const filler = "She walked down the corridor carefully. ";
  const filterHeavy = "She felt the cold. She noticed the door. She realized the lock was broken. She heard footsteps. She saw the shadow. She thought about running. She watched the figure. She looked at the exit. She knew it was too late. She wondered if escape was possible. She observed the room. She perceived danger. ";
  const prose = filler.repeat(10) + filterHeavy.repeat(3);

  const issues = detectFilterWords(prose);
  assert.ok(
    issues.some((i) => i.code === "FILTER_WORD_DENSITY"),
    "Must flag high filter word density",
  );
});

test("detectFilterWords passes clean prose", () => {
  const prose = "The corridor stretched ahead, cold and narrow. Metal panels lined the walls, humming with a frequency that pressed against the teeth. Lena counted exits without turning her head: three doors, one service hatch, a ventilation shaft too small to fit through. The geometry of the space offered exactly one viable path forward. She took it. ".repeat(4);

  const issues = detectFilterWords(prose);
  assert.equal(issues.length, 0, "Clean prose must not trigger filter word warnings");
});

test("checkParagraphDistribution flags consecutive single-sentence paragraphs", () => {
  const prose = [
    "She stopped.",
    "The door opened.",
    "Light flooded in.",
    "Someone was waiting.",
    "She recognized the face.",
    "It was too late to turn back.",
  ].join("\n\n");

  const issues = checkParagraphDistribution(prose);
  assert.ok(
    issues.some((i) => i.code === "PARAGRAPH_DISTRIBUTION" && i.message.includes("consecutive")),
    "Must flag 5+ consecutive single-sentence paragraphs",
  );
});

test("checkParagraphDistribution flags excessive long paragraphs", () => {
  const longParagraph = "Word ".repeat(220).trim() + ".";
  const prose = Array.from({ length: 5 }, (_, i) =>
    i < 3 ? longParagraph : "Short paragraph here.",
  ).join("\n\n");

  const issues = checkParagraphDistribution(prose);
  assert.ok(
    issues.some((i) => i.code === "PARAGRAPH_DISTRIBUTION" && i.message.includes("exceed 200")),
    "Must flag >30% paragraphs over 200 words",
  );
});

test("checkDialogueTags flags excessive said-adverb pattern", () => {
  const prose = [
    '"I don\'t know," she said quietly.',
    '"Try harder," he said firmly.',
    '"It\'s too late," she said softly.',
    '"Not yet," he said urgently.',
    '"Fine," she whispered.',
  ].join("\n");

  const issues = checkDialogueTags(prose);
  assert.ok(
    issues.some((i) => i.code === "DIALOGUE_TAG_VARIETY"),
    "Must flag >50% said/asked + adverb",
  );
});

test("checkDialogueTags passes varied dialogue tags", () => {
  const prose = [
    '"I don\'t know," she whispered.',
    '"Try harder," he called from across the room.',
    '"It\'s too late," she murmured.',
    '"Not yet," he declared.',
    '"Fine," she replied.',
  ].join("\n");

  const issues = checkDialogueTags(prose);
  assert.equal(issues.length, 0, "Varied dialogue tags must not trigger warning");
});

test("detectKnowledgeLeaks flags character near forbidden knowledge", () => {
  const prose = "Lena Vale stared at the document. The architect's identity was right there, encoded in the routing manifest she held. The architect had signed the original consent trail, and now Lena understood what that meant.";

  const issues = detectKnowledgeLeaks(prose, [
    {
      character: "Lena Vale",
      knows: ["The route was altered"],
      suspects: [],
      hides: [],
      mustNotKnowYet: ["The architect's identity and the original consent trail"],
    },
  ]);

  assert.ok(
    issues.some((i) => i.severity === "error" && i.code === "KNOWLEDGE_LEAK_PROSE"),
    "Must flag character appearing near forbidden knowledge keywords",
  );
});

test("detectKnowledgeLeaks passes when forbidden keywords are absent", () => {
  const prose = "Lena Vale walked through the corridor. The lights flickered overhead. She counted her steps and kept moving.";

  const issues = detectKnowledgeLeaks(prose, [
    {
      character: "Lena Vale",
      knows: [],
      suspects: [],
      hides: [],
      mustNotKnowYet: ["The architect's identity and the original consent trail"],
    },
  ]);

  assert.equal(issues.length, 0, "Must not flag when forbidden keywords are absent from prose");
});

// --- Utility tests ---

test("tailExcerpt returns clean paragraph-boundary text", () => {
  const text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph with more words here.\n\nFourth paragraph at the end.";
  const result = tailExcerpt(text, 10);
  assert.ok(result.includes("Fourth paragraph"), "Must include the last paragraph");
  assert.ok(!result.includes("First paragraph"), "Must not include distant paragraphs");
});

test("compactJson produces valid minified output", () => {
  const data = { a: 1, b: [2, 3], c: { d: "hello" } };
  const result = compactJson(data);
  assert.equal(result, '{"a":1,"b":[2,3],"c":{"d":"hello"}}');
  assert.deepEqual(JSON.parse(result), data);
});

test("buildLocalizedAuditPatchResult fixes temporal mismatch but leaves REPETITION for the LLM continuity fix", () => {
  const prose = [
    "The signal rode a frequency they had cleaned off the guest-facing channels hours ago.",
    "The Dock Two intake was already crowded, and the Dock Two intake stayed in view while the crowd kept walking.",
  ].join("\n\n");
  const audit: FinalAuditReport = {
    status: "issues_found",
    summary: "Blocking issue found.",
    factualConfidence: 0.95,
    requiresFix: true,
    issues: [
      {
        severity: "error",
        title: "Temporal inconsistency in radio-suppression line",
        description: "The phrase 'hours ago' overstates elapsed time.",
        fixInstruction: "Change 'hours ago' to a time frame consistent with the current sequence (for example 'earlier tonight' or similar).",
      },
      {
        severity: "warning",
        title: "REPETITION",
        description: "Phrase \"the dock two intake\" appears twice.",
        fixInstruction: "Resolve the issue using this evidence: the dock two intake",
      },
    ],
  };

  const patch = buildLocalizedAuditPatchResult(prose, audit);
  assert.ok(patch, "Localized patch should be produced for the temporal issue");
  assert.equal(patch.requiresDeltaRefresh, false, "Cosmetic localized patch should skip delta/memory refresh");
  assert.ok(patch.appliedFixes.includes("Temporal inconsistency in radio-suppression line"));
  assert.ok(!patch.prose.includes("hours ago"), "Temporal phrase should be localized to the chapter timeline");
  assert.ok(patch.prose.includes("earlier tonight"));
  assert.ok(
    !patch.appliedFixes.includes("REPETITION"),
    "REPETITION must NOT be patched locally — the deterministic replacement was unsafe and regressed prose; the LLM continuity fix handles repetition",
  );
  assert.ok(
    patch.prose.includes("the Dock Two intake stayed in view"),
    "Repeated phrase should be left untouched for the LLM continuity fix",
  );
});

test("buildLocalizedAuditPatchResult returns null when no issues are patchable", () => {
  const prose = "The panel hummed under her hand while the signal broke and returned.";
  const audit: FinalAuditReport = {
    status: "issues_found",
    summary: "Blocking issue found.",
    factualConfidence: 0.9,
    requiresFix: true,
    issues: [
      {
        severity: "error",
        title: "Wall-borne signal needs one grounding cue",
        description: "The mechanism is under-explained and risks reading uncanny.",
        fixInstruction: "Add a brief grounding detail that the panel backs onto comms/service infrastructure.",
      },
    ],
  };

  assert.equal(
    buildLocalizedAuditPatchResult(prose, audit),
    null,
    "Completely unsupported issues must return null",
  );
});

test("buildLocalizedAuditPatchResult patches what it can and leaves unsupported issues for full fix", () => {
  const prose = "The signal rode a frequency they had cleaned off hours ago. The mechanism needs grounding.";
  const audit: FinalAuditReport = {
    status: "issues_found",
    summary: "Two blocking issues.",
    factualConfidence: 0.9,
    requiresFix: true,
    issues: [
      {
        severity: "error",
        title: "Temporal inconsistency",
        description: "The phrase 'hours ago' overstates elapsed time.",
        fixInstruction: "Change 'hours ago' to 'earlier tonight'.",
      },
      {
        severity: "error",
        title: "Wall-borne signal needs grounding",
        description: "The mechanism is under-explained.",
        fixInstruction: "Add a grounding detail.",
      },
    ],
  };

  const patch = buildLocalizedAuditPatchResult(prose, audit);
  assert.ok(patch, "Partial patch should be returned when at least one issue is fixable");
  assert.ok(!patch.prose.includes("hours ago"), "Patchable temporal issue should be fixed");
  assert.ok(patch.appliedFixes.length === 1, "Only the patchable issue should appear in appliedFixes");
  assert.ok(patch.prose.includes("The mechanism needs grounding"), "Unsupported issue's prose should be untouched");
});

// --- Knowledge-boundary convergence ---

test("mergeKnowledgeMatrix clears mustNotKnowYet when the character now knows the information", () => {
  const memory = buildRollingMemory({
    previousMemory: {
      storySpine: "Spine.",
      unresolvedThreads: [],
      activePressures: [],
      knowledgeMatrix: [{
        character: "Lena Vale",
        knows: ["The route was altered"],
        suspects: [],
        hides: [],
        mustNotKnowYet: ["The architect identity and consent trail"],
      }],
      activeCharacterVoiceCards: [],
      revealPayoffLedger: [],
      nextChapterOpeningHandoff: {
        openingSituation: "Open.", physicalState: [], emotionalState: [],
        causalState: [], mandatoryCallbacks: [], characterStates: [],
      },
      compressedHistory: [],
      lastChapterSummary: "Summary.",
      emotionalStates: [],
    },
    delta: {
      entityMentions: [],
      sceneLedgerDelta: [],
      knowledgeChanges: [{
        holder: "Lena Vale",
        gainedKnowledge: "Lena now knows the architect identity and the consent trail",
        suspects: [],
        hides: [],
        source: "Chapter 5",
      }],
      irreversibleChanges: [],
      plotThreadProgression: [],
      revealPayoffMovement: [],
      activePressures: [],
      unresolvedThreads: [],
      nextChapterOpeningHandoff: "Continue.",
      activeVoiceSignals: [],
      storySpineUpdate: "Updated.",
      characterEmotionalStates: [],
    },
    proposal: {
      storySpine: "Updated.",
      unresolvedThreads: [],
      activePressures: [],
      knowledgeMatrix: [{
        character: "Lena Vale",
        knows: ["The architect identity and the consent trail"],
        suspects: [],
        hides: [],
        mustNotKnowYet: [],
      }],
      activeCharacterVoiceCards: [],
      nextChapterOpeningHandoff: {
        openingSituation: "Open.", physicalState: [], emotionalState: [],
        causalState: [], mandatoryCallbacks: [], characterStates: [],
      },
      compressedHistory: [],
      lastChapterSummary: "Summary.",
      emotionalStates: [],
    },
    chapterNumber: 5,
  });

  const lena = memory.knowledgeMatrix.find((e) => e.character === "Lena Vale");
  assert.ok(lena, "Lena must be in the knowledge matrix");
  assert.equal(
    lena.mustNotKnowYet.length, 0,
    "mustNotKnowYet must be empty after the reveal lands in knows",
  );
  assert.ok(
    lena.knows.some((k) => k.toLowerCase().includes("architect")),
    "Lena must now know about the architect",
  );
});

// --- Substring false-positive prevention ---

test("detectKnowledgeLeaks does not false-positive on substring character names", () => {
  const prose = "The annual fleet maneuver was announced. Sleeping delegates ignored the architect identity and original consent trail mentioned in the briefing.";

  const issues = detectKnowledgeLeaks(prose, [{
    character: "Ann Lee",
    knows: [],
    suspects: [],
    hides: [],
    mustNotKnowYet: ["The architect identity and the original consent trail"],
  }]);

  assert.equal(issues.length, 0,
    "Must not flag 'annual'/'fleet'/'sleeping' as mentions of 'Ann'/'Lee'");
});

test("detectKnowledgeLeaks respects word boundaries for keywords", () => {
  const prose = "Lena reconsidered the architecture of the building. The consentaneous agreement was old news.";

  const issues = detectKnowledgeLeaks(prose, [{
    character: "Lena Vale",
    knows: [],
    suspects: [],
    hides: [],
    mustNotKnowYet: ["The architect identity and the original consent trail"],
  }]);

  assert.equal(issues.length, 0,
    "Must not match 'architecture' against keyword 'architect' or 'consentaneous' against 'consent'");
});

// --- Duplicate paragraph detection ---

test("detectRepetition flags exact duplicate paragraphs as DUPLICATE_PARAGRAPH errors", () => {
  const paragraph = "The corridor stretched ahead, cold and narrow. Metal panels lined the walls with a frequency that pressed against the teeth.";
  const prose = [paragraph, "A unique middle paragraph.", paragraph, paragraph].join("\n\n");

  const issues = detectRepetition(prose);
  assert.ok(
    issues.some((i) => i.severity === "error" && i.code === "DUPLICATE_PARAGRAPH"),
    "Must flag exact duplicate paragraphs as error",
  );
});

test("detectRepetition reports only one DUPLICATE_PARAGRAPH per unique duplicated text", () => {
  const p = "Repeated paragraph content here for testing purposes.";
  const prose = [p, p, p, "Unique paragraph.", p].join("\n\n");

  const issues = detectRepetition(prose);
  const dupes = issues.filter((i) => i.code === "DUPLICATE_PARAGRAPH");
  assert.equal(dupes.length, 1, "Should report one DUPLICATE_PARAGRAPH error, not one per copy");
});

// --- POST_FIX_WORD_COUNT path coverage ---

test("hasBlockingAuditIssues ignores POST_FIX_WORD_COUNT warning", () => {
  assert.equal(
    hasBlockingAuditIssues({
      requiresFix: false,
      issues: [{ severity: "warning" }],
    }),
    false,
    "Warning-only audit (including POST_FIX_WORD_COUNT) must not block",
  );
});

// --- WORD_BAND post-fix downgrade ---

test("downgradePostFixWordBandError downgrades when WORD_BAND is the only error", () => {
  const audit = {
    requiresFix: true,
    issues: [
      { severity: "error", title: "WORD_BAND" },
      { severity: "warning", title: "REPETITION" },
    ],
  };
  const next = downgradePostFixWordBandError(audit);
  assert.equal(next.requiresFix, false, "Sole WORD_BAND error must clear requiresFix");
  assert.equal(
    next.issues.find((i) => i.title === "WORD_BAND")?.severity,
    "warning",
    "WORD_BAND must be downgraded to warning",
  );
  assert.equal(
    hasBlockingAuditIssues(next),
    false,
    "Downgraded audit must no longer block the loop",
  );
});

test("downgradePostFixWordBandError preserves WORD_BAND severity when other errors remain", () => {
  const audit = {
    requiresFix: true,
    issues: [
      { severity: "error", title: "WORD_BAND" },
      { severity: "error", title: "Timeline contradiction" },
    ],
  };
  const next = downgradePostFixWordBandError(audit);
  assert.equal(next.requiresFix, true, "Other errors must keep the audit blocking");
  assert.equal(
    next.issues.find((i) => i.title === "WORD_BAND")?.severity,
    "error",
    "WORD_BAND must remain an error when there are non-WORD_BAND blockers",
  );
});

test("downgradePostFixWordBandError is a no-op when there are no errors", () => {
  const audit = {
    requiresFix: false,
    issues: [{ severity: "warning", title: "REPETITION" }],
  };
  const next = downgradePostFixWordBandError(audit);
  assert.deepEqual(next, audit, "No-op when no errors are present");
});

// --- mustNotKnowYet convergence strictness ---

test("mergeKnowledgeMatrix does NOT clear mustNotKnowYet when knows only shares some tokens", () => {
  const memory = buildRollingMemory({
    previousMemory: {
      storySpine: "Spine.",
      unresolvedThreads: [],
      activePressures: [],
      knowledgeMatrix: [{
        character: "Lena Vale",
        knows: [],
        suspects: [],
        hides: [],
        mustNotKnowYet: ["The architect identity and consent trail"],
      }],
      activeCharacterVoiceCards: [],
      revealPayoffLedger: [],
      nextChapterOpeningHandoff: {
        openingSituation: "Open.", physicalState: [], emotionalState: [],
        causalState: [], mandatoryCallbacks: [], characterStates: [],
      },
      compressedHistory: [],
      lastChapterSummary: "Summary.",
      emotionalStates: [],
    },
    delta: {
      entityMentions: [],
      sceneLedgerDelta: [],
      knowledgeChanges: [{
        holder: "Lena Vale",
        gainedKnowledge: "The architect altered the consent forms",
        suspects: [],
        hides: [],
        source: "Chapter 3",
      }],
      irreversibleChanges: [],
      plotThreadProgression: [],
      revealPayoffMovement: [],
      activePressures: [],
      unresolvedThreads: [],
      nextChapterOpeningHandoff: "Continue.",
      activeVoiceSignals: [],
      storySpineUpdate: "Updated.",
      characterEmotionalStates: [],
    },
    proposal: {
      storySpine: "Updated.",
      unresolvedThreads: [],
      activePressures: [],
      knowledgeMatrix: [{
        character: "Lena Vale",
        knows: ["The architect altered the consent forms"],
        suspects: [],
        hides: [],
        mustNotKnowYet: [],
      }],
      activeCharacterVoiceCards: [],
      nextChapterOpeningHandoff: {
        openingSituation: "Open.", physicalState: [], emotionalState: [],
        causalState: [], mandatoryCallbacks: [], characterStates: [],
      },
      compressedHistory: [],
      lastChapterSummary: "Summary.",
      emotionalStates: [],
    },
    chapterNumber: 3,
  });

  const lena = memory.knowledgeMatrix.find((e) => e.character === "Lena Vale");
  assert.ok(lena);
  assert.ok(
    lena.mustNotKnowYet.length > 0,
    "mustNotKnowYet must NOT be cleared when knows only shares some tokens (architect + consent) but misses others (identity + trail)",
  );
});

// --- Punctuated mention detection ---

test("detectKnowledgeLeaks detects character names and keywords through punctuation", () => {
  const prose = '"Lena," Adrian said. "The architect identity is on the consent trail."';

  const issues = detectKnowledgeLeaks(prose, [{
    character: "Lena Vale",
    knows: [],
    suspects: [],
    hides: [],
    mustNotKnowYet: ["The architect identity and the original consent trail"],
  }]);

  assert.ok(
    issues.some((i) => i.severity === "error" && i.code === "KNOWLEDGE_LEAK_PROSE"),
    "Must detect 'Lena,' (with comma) as character mention and keywords through quotes",
  );
});

// --- Validator false-positive regressions ---

test("PLACEHOLDER_TEXT does not flag normal prose containing 'insert'", () => {
  const prose = "She tried to insert the key into the lock, but the mechanism resisted.\n\nThe door held fast.";
  const wordCount = prose.split(/\s+/).length;
  const packet = {
    targetWordBand: { min: 1, target: wordCount, max: 10000 },
    mandatoryBeats: [],
    revealBudget: { show: [], hint: [], reveal: [], withhold: [] },
    callbackObligations: [],
    rollingMemory: null,
    compactContext: { knowledgeWarnings: [] },
  } as unknown as ChapterPacket;
  const selected = { prose, wordCount } as unknown as SelectedChapter;
  const delta = {
    knowledgeChanges: [], plotThreadProgression: [], entityMentions: [],
  } as unknown as ChapterDelta;
  const memory = { knowledgeMatrix: [], unresolvedThreads: [] } as unknown as RollingMemory;
  const report = runDeterministicValidators({
    packet,
    selected,
    delta,
    memory,
    previousMemory: null,
    blueprintArtifacts: {
      compiledBlueprint: { data: { characters: [], storyPromise: {} } },
      continuityManifest: { data: null },
    } as unknown as BlueprintCompilationArtifacts,
  });
  assert.ok(
    !report.issues.some((i) => i.code === "PLACEHOLDER_TEXT"),
    "Normal use of 'insert' must not trigger PLACEHOLDER_TEXT",
  );
});

test("DUPLICATE_PARAGRAPH ignores scene-break glyphs", () => {
  const prose = [
    "The door closed behind her.",
    "◆",
    "Morning arrived without ceremony.",
    "***",
    "She checked the lock again.",
    "◆",
    "The hallway was empty.",
  ].join("\n\n");
  const issues = detectRepetition(prose);
  assert.ok(
    !issues.some((i) => i.code === "DUPLICATE_PARAGRAPH"),
    "Scene-break glyphs like ◆ and *** must not trigger DUPLICATE_PARAGRAPH",
  );
});

test("DUPLICATE_PARAGRAPH still flags real duplicated paragraphs", () => {
  const dup = "The rain hammered the glass with a sound like static, relentless and indifferent.";
  const prose = [dup, "She turned away from the window.", dup].join("\n\n");
  const issues = detectRepetition(prose);
  assert.ok(
    issues.some((i) => i.code === "DUPLICATE_PARAGRAPH"),
    "Real duplicated paragraphs must still be flagged",
  );
});

// --- shouldSkipRevision ---

test("shouldSkipRevision returns true when draft exceeds threshold with no blocking signals", () => {
  const review = makeReview({ overallScore: 95, passesThreshold: true });
  assert.equal(shouldSkipRevision({
    skipRevisionThreshold: 93,
    overallScore: review.overallScore,
    passesThreshold: review.passesThreshold,
    review,
  }), true);
});

test("shouldSkipRevision returns false when score is below threshold", () => {
  const review = makeReview({ overallScore: 90, passesThreshold: true });
  assert.equal(shouldSkipRevision({
    skipRevisionThreshold: 93,
    overallScore: review.overallScore,
    passesThreshold: review.passesThreshold,
    review,
  }), false);
});

test("shouldSkipRevision returns false when threshold is null (disabled)", () => {
  const review = makeReview({ overallScore: 99, passesThreshold: true });
  assert.equal(shouldSkipRevision({
    skipRevisionThreshold: null,
    overallScore: review.overallScore,
    passesThreshold: review.passesThreshold,
    review,
  }), false);
});

test("shouldSkipRevision returns false when passesThreshold is false despite high score", () => {
  const review = makeReview({ overallScore: 95, passesThreshold: false });
  assert.equal(shouldSkipRevision({
    skipRevisionThreshold: 93,
    overallScore: review.overallScore,
    passesThreshold: review.passesThreshold,
    review,
  }), false);
});

test("shouldSkipRevision returns false when blocking review signals exist", () => {
  const review = makeReview({
    overallScore: 95,
    passesThreshold: true,
    blockingIssues: ["Critical continuity break"],
  });
  assert.equal(shouldSkipRevision({
    skipRevisionThreshold: 93,
    overallScore: review.overallScore,
    passesThreshold: review.passesThreshold,
    review,
  }), false);
});

test("shouldSkipRevision returns false when review has error-severity issues", () => {
  const review = makeReview({
    overallScore: 95,
    passesThreshold: true,
    issues: [{ severity: "error", category: "continuity", detail: "break", evidence: undefined, suggestedFix: undefined }],
  });
  assert.equal(shouldSkipRevision({
    skipRevisionThreshold: 93,
    overallScore: review.overallScore,
    passesThreshold: review.passesThreshold,
    review,
  }), false);
});

// --- Memory-update budget regression ---

function makeHeavyPacket(): ChapterPacket {
  const heavyProse = "Word ".repeat(2000).trim() + ".";
  return {
    chapterNumber: 2,
    title: "Chapter Two",
    riskLevel: "medium",
    purpose: "Advance the central conflict.",
    chapterFunction: {
      function: "escalation", riskLevel: "medium",
      pacingDirective: "Raise stakes.", judgeWeights: {},
    } as ChapterPacket["chapterFunction"],
    openingHandoff: "Continue from prior fallout.",
    previousChapterExcerpt: heavyProse,
    activeCast: [
      {
        name: "Lena Vale", role: "protagonist",
        desire: "Freedom", fear: "Exposure", contradiction: "Obeys to rebel",
        publicFace: "Compliant", privateTruth: "Defiant",
        voiceNotes: ["Clipped under pressure."],
        knowledgeBoundary: "Knows the route was altered", rawBody: "",
      },
    ],
    mandatoryBeats: ["Beat A", "Beat B"],
    revealBudget: { show: ["X"], hint: ["Y"], reveal: [], withhold: ["Z"] },
    callbackObligations: ["Callback 1"],
    targetWordBand: { min: 3500, target: 4200, max: 5000 },
    endingHookTarget: "End on a cliffhanger.",
    voiceGuidance: ["Match prior chapter register.", "Keep POV tight."],
    pacingGuidance: ["Slow burn opening.", "Escalate in final third."],
    continuityNotes: ["Scar is still visible."],
    chapterNotes: [],
    rollingMemory: {
      storySpine: "The story so far.",
      unresolvedThreads: ["Thread A"],
      activePressures: ["Pressure X"],
      knowledgeMatrix: [],
      activeCharacterVoiceCards: [],
      revealPayoffLedger: [],
      nextChapterOpeningHandoff: {
        openingSituation: "Open.", physicalState: [], emotionalState: [],
        causalState: [], mandatoryCallbacks: [], characterStates: [],
      },
      compressedHistory: ["Ch1 happened."],
      lastChapterSummary: "Ch1 summary.",
      emotionalStates: [],
    },
    handoffMemory: {
      openingSituation: "Open.", physicalState: [], emotionalState: [],
      causalState: [], mandatoryCallbacks: [], characterStates: [],
    },
    compactContext: {
      previousChapterFull: heavyProse,
      olderHistory: ["Even older context."],
      revealLedger: [],
      knowledgeWarnings: [],
    },
    voiceTarget: null,
    marketPromise: null,
    continuityActiveSlice: null,
    authorBrief: { authorialPersona: "Test persona.", craftDirectives: ["Test directive."], source: "deterministic" },
  };
}

function makeBudgetTestStoryCore(): CompiledStoryBlueprint {
  return {
    metadata: {
      title: "Budget Test",
      author: "Test",
      blueprintVersion: "1.0.0",
      totalChapters: 12,
      defaultChapterWordCount: 3500,
    },
    storyPromise: {
      corePremise: "A sealed luxury habitat becomes a pressure chamber of lies.",
      storyPromise: "Every chapter tightens mechanical dread and moral compromise.",
      readerPromise: "The reader should feel elegant spectacle collapsing into trapped survival.",
      endingPromise: "Survival must be costly and truth must remain at risk.",
    },
    marketPositioning: {
      marketCategory: "upmarket thriller",
      audience: "Readers who want disaster spectacle and moral pressure.",
      shelfPositioning: "A Cold War survival thriller under the sea.",
      comparables: ["The Abyss", "The Poseidon Adventure"],
    },
    marketPromise: null,
    genre: {
      primaryGenre: "thriller",
      subgenres: ["disaster thriller"],
      toneKeywords: ["claustrophobic", "elegant"],
      readerExperience: "Pressure and consequence.",
      runtimeOverrides: {},
    },
    continuityManifest: null,
    canonLaw: ["The ocean always wins any delay."],
    antiPatterns: ["No miracle fixes.", "No cartoon villains."],
    styleRules: ["Keep POV tight.", "Let action carry emotion."],
    motifBank: ["white seams", "black water", "pressure groans"],
    characters: [],
    chapterOutline: [],
    sectionDigests: {
      "Knowledge Boundaries and Reveal Timing": "Do not leak the military truth early.",
      "Act Spine and Chapter-by-Chapter Obligations": "Act one imports war into the hotel.",
    },
  };
}

function makeBudgetTestGenreContract(): GenreContract {
  return {
    primaryGenre: "thriller",
    contributingGenres: ["disaster thriller"],
    toneKeywords: ["claustrophobic", "elegant"],
    readerExperience: "Pressure and consequence.",
    controls: {
      pacingCurve: "slow-burn pressure with violent ruptures",
      sceneDensity: "medium-high",
      dialogueRatioTarget: "medium",
      interiorityRatioTarget: "close-third",
      revealCadence: "controlled",
      hookStyle: "systems failure plus moral dread",
      endingMode: "costly survival",
      povDistance: "close",
      ambiguityTolerance: "medium",
      sensoryDensity: "cold metal and black water",
      proseCompression: "muscular but cinematic",
      emotionalDwellExpectation: "brief but earned",
      violenceExplicitness: "restrained",
      romanceProminence: "low",
      validatorThresholdOverrides: [],
    },
    aiRefinementUsed: false,
    aiRefinementNotes: [],
  };
}

function makePlanningStressPacket(): ChapterPacket {
  const packet = makeHeavyPacket();
  const baseCharacter = packet.activeCast[0]!;

  packet.activeCast = Array.from({ length: 6 }, (_, index) => ({
    ...baseCharacter,
    name: `Character ${index + 1}`,
    role: `Role ${index + 1}`,
    desire: `Protect something vital ${index + 1}.`,
    fear: `Fail publicly under pressure ${index + 1}.`,
    contradiction: `Needs control but improvises badly ${index + 1}.`,
    publicFace: `Looks calm ${index + 1}.`,
    privateTruth: `Carries a buried compromise ${index + 1}.`,
    voiceNotes: [
      `Voice note ${index + 1}A ` + "word ".repeat(20).trim(),
      `Voice note ${index + 1}B ` + "word ".repeat(20).trim(),
      `Voice note ${index + 1}C ` + "word ".repeat(20).trim(),
    ],
    knowledgeBoundary: `Must not know the deepest truth ${index + 1}.`,
    rawBody: "Source text ".repeat(120).trim(),
  }));

  packet.previousChapterExcerpt = "Word ".repeat(3200).trim() + ".";
  packet.voiceGuidance = Array.from({ length: 12 }, (_, index) => `Voice guidance ${index + 1} ` + "word ".repeat(18).trim());
  packet.pacingGuidance = Array.from({ length: 8 }, (_, index) => `Pacing guidance ${index + 1} ` + "word ".repeat(14).trim());
  packet.chapterNotes = Array.from({ length: 8 }, (_, index) => `Chapter note ${index + 1} ` + "word ".repeat(14).trim());

  packet.rollingMemory = {
    ...packet.rollingMemory!,
    storySpine: "Story spine ".repeat(90).trim(),
    unresolvedThreads: Array.from({ length: 24 }, (_, index) => `Unresolved thread ${index + 1} ` + "word ".repeat(18).trim()),
    activePressures: Array.from({ length: 18 }, (_, index) => `Active pressure ${index + 1} ` + "word ".repeat(16).trim()),
    knowledgeMatrix: packet.activeCast.map((character, index) => ({
      character: character.name,
      knows: Array.from({ length: 4 }, (_, itemIndex) => `Knowledge ${index + 1}.${itemIndex + 1} ` + "word ".repeat(16).trim()),
      suspects: Array.from({ length: 3 }, (_, itemIndex) => `Suspicion ${index + 1}.${itemIndex + 1} ` + "word ".repeat(14).trim()),
      hides: Array.from({ length: 3 }, (_, itemIndex) => `Hidden fact ${index + 1}.${itemIndex + 1} ` + "word ".repeat(14).trim()),
      mustNotKnowYet: Array.from({ length: 2 }, (_, itemIndex) => `Boundary ${index + 1}.${itemIndex + 1} ` + "word ".repeat(14).trim()),
    })),
    activeCharacterVoiceCards: packet.activeCast.map((character, index) => ({
      character: character.name,
      activeTraits: Array.from({ length: 4 }, (_, itemIndex) => `Trait ${index + 1}.${itemIndex + 1} ` + "word ".repeat(10).trim()),
      stressPattern: `Stress pattern ${index + 1} ` + "word ".repeat(24).trim(),
      dialogueHabits: Array.from({ length: 3 }, (_, itemIndex) => `Habit ${index + 1}.${itemIndex + 1} ` + "word ".repeat(12).trim()),
      tabooNotes: Array.from({ length: 2 }, (_, itemIndex) => `Taboo ${index + 1}.${itemIndex + 1} ` + "word ".repeat(12).trim()),
      updatedFromChapter: 2,
    })),
    revealPayoffLedger: Array.from({ length: 18 }, (_, index) => ({
      thread: `Reveal thread ${index + 1}`,
      latestMovement: "hint" as const,
      description: `Reveal movement ${index + 1} ` + "word ".repeat(10).trim(),
      status: `Status ${index + 1} ` + "word ".repeat(12).trim(),
      chapterNumber: Math.max(1, index - 1),
    })),
    compressedHistory: Array.from({ length: 16 }, (_, index) => `History ${index + 1} ` + "word ".repeat(22).trim()),
    lastChapterSummary: "Last chapter summary ".repeat(60).trim(),
    emotionalStates: packet.activeCast.map((character, index) => ({
      character: character.name,
      currentBelief: `Belief ${index + 1} ` + "word ".repeat(12).trim(),
      currentDoubt: `Doubt ${index + 1} ` + "word ".repeat(12).trim(),
      emotionalRegister: `Register ${index + 1} ` + "word ".repeat(10).trim(),
      arcDistance: `Arc ${index + 1} ` + "word ".repeat(8).trim(),
    })),
  };

  packet.compactContext = {
    previousChapterFull: "Word ".repeat(5200).trim() + ".",
    olderHistory: Array.from({ length: 16 }, (_, index) => `Older history ${index + 1} ` + "word ".repeat(18).trim()),
    revealLedger: Array.from({ length: 18 }, (_, index) => `Reveal ledger ${index + 1} ` + "word ".repeat(12).trim()),
    knowledgeWarnings: Array.from({ length: 14 }, (_, index) => `Knowledge warning ${index + 1} ` + "word ".repeat(14).trim()),
  };

  return packet;
}

test("stripMemoryPacketFields removes all heavy/redundant fields", () => {
  const packet = makeHeavyPacket();
  const stripped = stripMemoryPacketFields(packet);

  assert.equal("rollingMemory" in stripped, false);
  assert.equal("handoffMemory" in stripped, false);
  assert.equal("compactContext" in stripped, false);
  assert.equal("previousChapterExcerpt" in stripped, false);
  assert.equal("voiceGuidance" in stripped, false);
  assert.equal("pacingGuidance" in stripped, false);

  assert.equal(stripped.chapterNumber, 2);
  assert.deepEqual(stripped.mandatoryBeats, ["Beat A", "Beat B"]);
  assert.ok(stripped.revealBudget.withhold.includes("Z"));
});

test("stripMemoryPacketFields yields meaningful token savings on a heavy packet", () => {
  const packet = makeHeavyPacket();
  const fullTokens = estimateTextTokens(JSON.stringify(packet));
  const strippedTokens = estimateTextTokens(JSON.stringify(stripMemoryPacketFields(packet)));

  assert.ok(
    strippedTokens < fullTokens * 0.5,
    `Stripped packet (${strippedTokens}) must be less than 50% of full packet (${fullTokens})`,
  );
});

test("buildSpecPacketView strips heavy packet fields and keeps recent planning context", () => {
  const packet = makePlanningStressPacket();
  const view = buildSpecPacketView(packet);

  assert.equal("voiceGuidance" in view, false);
  assert.equal("pacingGuidance" in view, false);
  assert.equal("previousChapterExcerpt" in view, false);
  assert.equal("rollingMemory" in view, false);
  assert.equal("handoffMemory" in view, false);
  assert.equal("compactContext" in view, false);

  assert.deepEqual(
    Object.keys(view.activeCast[0]!).sort(),
    ["contradiction", "desire", "fear", "knowledgeBoundary", "name", "privateTruth", "role"],
  );
  assert.ok(view.storyState.activeCharacterArcs.length > 0, "Active cast arc positions must be preserved");
  assert.ok(
    !view.storyState.compressedHistory.includes(packet.rollingMemory!.compressedHistory[0]!),
    "Oldest compressed-history entries should drop first when the planning budget is tight",
  );
  assert.ok(
    view.storyState.compressedHistory.includes(packet.rollingMemory!.compressedHistory.at(-1)!),
    "Most recent compressed-history entries should survive compaction",
  );

  const fullTokens = estimateTextTokens(compactJson(packet));
  const viewTokens = estimateTextTokens(compactJson(view));
  assert.ok(
    viewTokens < fullTokens * 0.45,
    `Spec packet view (${viewTokens}) must be less than 45% of full packet (${fullTokens})`,
  );
});

test("spec-generation prompt compaction keeps a planning-stress packet within budget", () => {
  const packet = makePlanningStressPacket();
  const request = buildSpecGenerationRequest({
    storyCore: makeBudgetTestStoryCore(),
    genreContract: makeBudgetTestGenreContract(),
    packet,
  });
  const stage = config.stageProfiles.specGeneration;

  const estimatedInputTokens = estimateOpenAiPromptTokens({
    stage,
    instructions: request.instructions,
    prompt: request.prompt,
    schema: request.schema,
  });

  assert.ok(
    estimatedInputTokens <= stage.inputTokenBudget,
    `Compacted spec-generation input (${estimatedInputTokens}) must fit within budget (${stage.inputTokenBudget})`,
  );
  assert.ok(
    estimatedInputTokens + stage.maxOutputTokens <= stage.contextWindowTokens,
    `Compacted spec-generation total (${estimatedInputTokens + stage.maxOutputTokens}) must fit context window (${stage.contextWindowTokens})`,
  );
});

test("chapter-delta prompt compaction removes packet-memory duplication and fits within budget", () => {
  const packet = makePlanningStressPacket();
  const request = buildChapterDeltaRequest({
    genreContract: makeBudgetTestGenreContract(),
    packet,
    previousMemory: packet.rollingMemory,
    selectedProse: "Word ".repeat(4200).trim() + ".",
  });
  const stage = config.stageProfiles.chapterDelta;

  assert.ok(
    !request.prompt.includes("\"rollingMemory\""),
    "Chapter-delta prompt should not duplicate rollingMemory inside the packet view",
  );
  assert.ok(
    !request.prompt.includes("\"previousChapterFull\""),
    "Chapter-delta packet view should not include the full previous chapter text",
  );

  const estimatedInputTokens = estimateOpenAiPromptTokens({
    stage,
    instructions: request.instructions,
    prompt: request.prompt,
    schema: request.schema,
  });

  assert.ok(
    estimatedInputTokens <= stage.inputTokenBudget,
    `Compacted chapter-delta input (${estimatedInputTokens}) must fit within budget (${stage.inputTokenBudget})`,
  );
  assert.ok(
    estimatedInputTokens + stage.maxOutputTokens <= stage.contextWindowTokens,
    `Compacted chapter-delta total (${estimatedInputTokens + stage.maxOutputTokens}) must fit context window (${stage.contextWindowTokens})`,
  );
});

test("memory-update budget accommodates stripped ch2-sized packet within stage limits", () => {
  const stage = config.stageProfiles.memoryUpdate;
  const packet = makeHeavyPacket();

  const strippedPacketTokens = estimateTextTokens(compactJson(stripMemoryPacketFields(packet)));
  const memoryTokens = estimateTextTokens(compactJson(packet.rollingMemory));
  const deltaTokens = estimateTextTokens(compactJson({
    entityMentions: [], sceneLedgerDelta: [],
    knowledgeChanges: [{ holder: "Lena Vale", gainedKnowledge: "New fact", suspects: [], hides: [], source: "Ch2" }],
    irreversibleChanges: [], plotThreadProgression: [],
    revealPayoffMovement: [], activePressures: ["Pressure"],
    unresolvedThreads: ["Thread"], nextChapterOpeningHandoff: "Continue.",
    activeVoiceSignals: [], storySpineUpdate: "Updated.", characterEmotionalStates: [],
  }));

  const totalInput = strippedPacketTokens + memoryTokens + deltaTokens;
  assert.ok(
    totalInput <= stage.inputTokenBudget,
    `Stripped memory-update input (${totalInput}) must fit within budget (${stage.inputTokenBudget})`,
  );
  assert.ok(
    totalInput + stage.maxOutputTokens <= stage.contextWindowTokens,
    `Stripped input + output (${totalInput + stage.maxOutputTokens}) must fit context window (${stage.contextWindowTokens})`,
  );
});

test("final-audit prompt compaction keeps heavy ch2-sized packet within stage budget", () => {
  const packet = makeHeavyPacket();
  const prose = "Word ".repeat(4200).trim() + ".";
  const selected: SelectedChapter = {
    winner: "revision",
    prose,
    wordCount: prose.split(/\s+/).length,
    review: makeReview(),
    selection: {
      presentedOrder: ["draft", "revision"],
      rawWinner: "revision",
      finalWinner: "revision",
      scoreDelta: 2.4,
      withinTolerance: true,
      rationale: "Revision passes threshold and must win.",
      preservedOriginal: false,
    },
  };
  const delta = createSmokeDelta(packet, selected);
  const memory = createSmokeMemory(packet, delta, packet.rollingMemory);
  const validators = createSmokeValidatorReport();
  const instructions = [
    "You are the final factual auditor for a chapter-by-chapter novel engine.",
    "Audit only factual continuity, reveal discipline, contract adherence, and chapter-to-chapter causality.",
    "Take deterministic validator findings seriously and escalate concrete repair actions when needed.",
  ].join("\n");

  const prompt = buildFinalAuditPrompt({
    genreContract: {
      primaryGenre: "science fiction",
      contributingGenres: ["thriller"],
      toneKeywords: ["tense"],
      readerExperience: "Pressure and consequence.",
      controls: {
        pacingCurve: "rising",
        sceneDensity: "dense",
        dialogueRatioTarget: "balanced",
        interiorityRatioTarget: "close-third",
        revealCadence: "controlled",
        hookStyle: "pressure",
        endingMode: "cliff",
        povDistance: "close",
        ambiguityTolerance: "medium",
        sensoryDensity: "high",
        proseCompression: "tight",
        emotionalDwellExpectation: "earned",
        violenceExplicitness: "moderate",
        romanceProminence: "low",
        validatorThresholdOverrides: [],
      },
      aiRefinementUsed: false,
      aiRefinementNotes: [],
    },
    packet,
    selectedReview: selected.review,
    delta,
    memory,
    validatorReport: validators,
    selectedProse: selected.prose,
  });

  const estimatedInputTokens = estimateOpenAiPromptTokens({
    stage: config.stageProfiles.finalAudit,
    instructions,
    prompt,
    schema: { type: "object" },
  });

  assert.ok(
    estimatedInputTokens <= config.stageProfiles.finalAudit.inputTokenBudget,
    `Compacted final-audit input (${estimatedInputTokens}) must fit within budget (${config.stageProfiles.finalAudit.inputTokenBudget})`,
  );
});
