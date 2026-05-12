import { generateStructuredOutput } from "../api/openai.js";
import { config } from "../config.js";
import type {
  ArtifactEnvelope,
  BlueprintCompilationArtifacts,
  ChapterDraft,
  ChapterPacket,
  DraftReview,
  PairwiseSelection,
  SelectedChapter,
} from "../types/index.js";
import { hasBlockingReviewSignals } from "./judge-draft.js";
import { chapterArtifactPath, createArtifact } from "./stage-utils.js";
import { createSmokeSelectedChapter } from "./smoke-helpers.js";
import { writeJson } from "../utils/index.js";

const pairwiseSelectionSchema = {
  type: "object",
  properties: {
    presentedOrder: {
      type: "array",
      items: { type: "string", enum: ["draft", "revision"] },
      minItems: 2,
      maxItems: 2,
    },
    rawWinner: { type: "string", enum: ["draft", "revision"] },
    finalWinner: { type: "string", enum: ["draft", "revision"] },
    scoreDelta: { type: "number", minimum: -100, maximum: 100 },
    withinTolerance: { type: "boolean" },
    rationale: { type: "string", minLength: 1 },
    preservedOriginal: { type: "boolean" },
  },
  required: [
    "presentedOrder",
    "rawWinner",
    "finalWinner",
    "scoreDelta",
    "withinTolerance",
    "rationale",
    "preservedOriginal",
  ],
  additionalProperties: false,
} as const;

function choosePresentationOrder(seed: string): ["draft", "revision"] | ["revision", "draft"] {
  return seed.charCodeAt(0) % 2 === 0 ? ["draft", "revision"] : ["revision", "draft"];
}

export function resolveSelectionDecision(params: {
  rawWinner: "draft" | "revision";
  rawRationale: string;
  withinTolerance: boolean;
  draftPassed: boolean;
  revisionPassed: boolean;
  draftHasBlockers: boolean;
  revisionHasBlockers: boolean;
}): {
  finalWinner: "draft" | "revision";
  preservedOriginal: boolean;
  rationale: string;
} {
  if (params.draftPassed !== params.revisionPassed) {
    const finalWinner = params.draftPassed ? "draft" : "revision";
    return {
      finalWinner,
      preservedOriginal: false,
      rationale: finalWinner === params.rawWinner
        ? params.rawRationale
        : `${params.rawRationale} Deterministic override: selected ${finalWinner} because it was the only candidate that passed the literary threshold.`,
    };
  }

  if (params.draftHasBlockers !== params.revisionHasBlockers) {
    const finalWinner = params.draftHasBlockers ? "revision" : "draft";
    return {
      finalWinner,
      preservedOriginal: finalWinner === "draft",
      rationale: finalWinner === params.rawWinner
        ? params.rawRationale
        : `${params.rawRationale} Deterministic override: selected ${finalWinner} because it cleared blocking review signals the other candidate still carried.`,
    };
  }

  if (params.withinTolerance) {
    return {
      finalWinner: "draft",
      preservedOriginal: true,
      rationale: params.rawWinner === "draft"
        ? params.rawRationale
        : `${params.rawRationale} Deterministic override: candidates were within tolerance, so the original draft was preserved.`,
    };
  }

  return {
    finalWinner: params.rawWinner,
    preservedOriginal: false,
    rationale: params.rawRationale,
  };
}

export async function selectDraft(params: {
  packetArtifact: ArtifactEnvelope<ChapterPacket>;
  draftArtifact: ArtifactEnvelope<ChapterDraft>;
  draftReviewArtifact: ArtifactEnvelope<DraftReview>;
  revisedDraftArtifact: ArtifactEnvelope<ChapterDraft>;
  revisedReviewArtifact: ArtifactEnvelope<DraftReview>;
  blueprintArtifacts: BlueprintCompilationArtifacts;
  smoke: boolean;
}): Promise<{
  selectionArtifact: ArtifactEnvelope<PairwiseSelection>;
  selectedArtifact: ArtifactEnvelope<SelectedChapter>;
  selectedReviewArtifact: ArtifactEnvelope<DraftReview>;
}> {
  const {
    packetArtifact,
    draftArtifact,
    draftReviewArtifact,
    revisedDraftArtifact,
    revisedReviewArtifact,
    blueprintArtifacts,
    smoke,
  } = params;

  const tolerance = config.qualitySettings.pairwiseTolerance;
  const order = choosePresentationOrder(packetArtifact.blueprintHash);

  let selection: PairwiseSelection;
  let usage: ArtifactEnvelope<PairwiseSelection>["usage"];

  if (smoke) {
    const smokeSelected = createSmokeSelectedChapter(
      draftArtifact.data,
      draftReviewArtifact.data,
      revisedDraftArtifact.data,
      revisedReviewArtifact.data,
      tolerance,
    );
    selection = smokeSelected.selection;
    usage = undefined;
  } else {
    const candidateFor = (label: "draft" | "revision") => (
      label === "draft"
        ? { prose: draftArtifact.data.prose, review: draftReviewArtifact.data }
        : { prose: revisedDraftArtifact.data.prose, review: revisedReviewArtifact.data }
    );

    const result = await generateStructuredOutput<PairwiseSelection>({
      stage: config.stageProfiles.pairwiseSelection,
      instructions: [
        "You select the stronger of two full-chapter candidates.",
        "Anchor the choice to the genre contract, chapter-function profile, and review evidence.",
        "Never select a failing candidate over one that passed threshold.",
        `If the candidates are within ${tolerance} points, preserve the original draft by default.`,
      ].join("\n"),
      prompt: [
        `Genre contract: ${JSON.stringify(blueprintArtifacts.genreContract.data, null, 2)}`,
        `Chapter function profile: ${JSON.stringify(packetArtifact.data.chapterFunction, null, 2)}`,
        `Presentation order: ${order.join(", ")}`,
        `Candidate ${order[0]}: ${JSON.stringify(candidateFor(order[0]), null, 2)}`,
        `Candidate ${order[1]}: ${JSON.stringify(candidateFor(order[1]), null, 2)}`,
      ].join("\n\n"),
      schemaName: "pairwise_selection",
      schema: pairwiseSelectionSchema,
    });

    const rawSelection = result.value;
    const scoreDelta = revisedReviewArtifact.data.overallScore - draftReviewArtifact.data.overallScore;
    const withinTolerance = Math.abs(scoreDelta) <= tolerance;
    const decision = resolveSelectionDecision({
      rawWinner: rawSelection.rawWinner,
      rawRationale: rawSelection.rationale,
      withinTolerance,
      draftPassed: draftReviewArtifact.data.passesThreshold,
      revisionPassed: revisedReviewArtifact.data.passesThreshold,
      draftHasBlockers: hasBlockingReviewSignals(draftReviewArtifact.data),
      revisionHasBlockers: hasBlockingReviewSignals(revisedReviewArtifact.data),
    });
    selection = {
      ...rawSelection,
      presentedOrder: order,
      scoreDelta,
      withinTolerance,
      finalWinner: decision.finalWinner,
      preservedOriginal: decision.preservedOriginal,
      rationale: decision.rationale,
    };
    usage = result.usage;
  }

  const selectionArtifact = createArtifact<PairwiseSelection>({
    artifactType: "pairwise-selection",
    blueprintHash: packetArtifact.blueprintHash,
    blueprintVersion: packetArtifact.blueprintVersion,
    chapterNumber: packetArtifact.chapterNumber,
    data: selection,
    usage,
  });
  await writeJson(chapterArtifactPath(packetArtifact.data.chapterNumber, "selection"), selectionArtifact);

  const winner = selection.finalWinner;
  const selectedDraft = winner === "draft" ? draftArtifact.data : revisedDraftArtifact.data;
  const selectedReviewArtifact = winner === "draft" ? draftReviewArtifact : revisedReviewArtifact;

  const selectedArtifact = createArtifact<SelectedChapter>({
    artifactType: "selected-chapter",
    blueprintHash: packetArtifact.blueprintHash,
    blueprintVersion: packetArtifact.blueprintVersion,
    chapterNumber: packetArtifact.chapterNumber,
    data: {
      winner,
      prose: selectedDraft.prose,
      wordCount: selectedDraft.wordCount,
      review: selectedReviewArtifact.data,
      selection,
    },
  });

  await writeJson(chapterArtifactPath(packetArtifact.data.chapterNumber, "selected"), selectedArtifact);
  await writeJson(chapterArtifactPath(packetArtifact.data.chapterNumber, "review"), selectedReviewArtifact);

  return {
    selectionArtifact,
    selectedArtifact,
    selectedReviewArtifact,
  };
}
