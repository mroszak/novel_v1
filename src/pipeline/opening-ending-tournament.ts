import { generateText as generateAnthropicText } from "../api/anthropic.js";
import { generateStructuredOutput } from "../api/openai.js";
import { config } from "../config.js";
import type {
  ArtifactEnvelope,
  BlueprintCompilationArtifacts,
  ChapterDraft,
  ChapterPacket,
  ChapterSpec,
  DraftReview,
  SelectedChapter,
  StageUsage,
  TournamentCandidate,
  TournamentMerged,
  TournamentPairResult,
  TournamentResult,
  TournamentZone,
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
import { compactJson, countWords as countWordsUtil, writeJson } from "../utils/index.js";
import { judgeDraft } from "./judge-draft.js";
import { chapterArtifactPath, createArtifact } from "./stage-utils.js";

const REJUDGE_REGRESSION_TOLERANCE = 2;

const tournamentPickSchema = {
  type: "object",
  properties: {
    winnerId: { type: "string", minLength: 1 },
    rationale: { type: "string", minLength: 1 },
  },
  required: ["winnerId", "rationale"],
  additionalProperties: false,
} as const;

interface ZoneSlice {
  paragraphIndex: number;
  text: string;
}

interface OpeningSlice {
  paragraphs: number[]; // indices included
  text: string;
}

function paragraphsOf(prose: string): string[] {
  return prose.split(/\n\n+/);
}

export function locateOpeningSlice(prose: string): OpeningSlice | null {
  const paragraphs = paragraphsOf(prose);
  if (paragraphs.length === 0) return null;

  const start = paragraphs[0]?.trim() ?? "";
  let startIndex = 0;
  // Skip a single short title-like line if present.
  if (start.length < 80 && !/[.!?]$/.test(start)) {
    startIndex = 1;
  }

  const indices: number[] = [];
  let cumulative = 0;
  for (let i = startIndex; i < paragraphs.length; i += 1) {
    const paragraph = paragraphs[i] ?? "";
    if (paragraph.trim().length === 0) continue;
    indices.push(i);
    cumulative += countWordsUtil(paragraph);
    if (cumulative >= 200) break;
  }
  if (indices.length === 0) return null;

  const text = indices.map((i) => paragraphs[i] ?? "").join("\n\n");
  return { paragraphs: indices, text };
}

export function locateEndingSlice(prose: string): ZoneSlice | null {
  const paragraphs = paragraphsOf(prose);
  for (let i = paragraphs.length - 1; i >= 0; i -= 1) {
    const paragraph = paragraphs[i] ?? "";
    if (paragraph.trim().length > 0) {
      return { paragraphIndex: i, text: paragraph };
    }
  }
  return null;
}

export function locateTitleSlice(prose: string): ZoneSlice | null {
  const paragraphs = paragraphsOf(prose);
  const first = paragraphs[0]?.trim() ?? "";
  if (first.length === 0) return null;
  if (first.length < 80 && !/[.!?]$/.test(first)) {
    return { paragraphIndex: 0, text: first };
  }
  return null;
}

function spliceOpening(prose: string, slice: OpeningSlice, replacement: string): string {
  const paragraphs = paragraphsOf(prose);
  const newParagraphs: string[] = [];
  const drop = new Set(slice.paragraphs);
  let inserted = false;
  for (let i = 0; i < paragraphs.length; i += 1) {
    if (drop.has(i)) {
      if (!inserted) {
        newParagraphs.push(replacement.trim());
        inserted = true;
      }
      continue;
    }
    newParagraphs.push(paragraphs[i] ?? "");
  }
  return newParagraphs.join("\n\n");
}

function spliceParagraph(prose: string, paragraphIndex: number, replacement: string): string {
  const paragraphs = paragraphsOf(prose);
  if (paragraphIndex < 0 || paragraphIndex >= paragraphs.length) return prose;
  paragraphs[paragraphIndex] = replacement.trim();
  return paragraphs.join("\n\n");
}

interface ZoneGenerationContext {
  packet: ChapterPacket;
  approvedSpec: ChapterSpec;
  voiceTarget: VoiceTarget | null;
  blueprintArtifacts: BlueprintCompilationArtifacts;
  selected: SelectedChapter;
}

function buildZoneSystemPrompt(zone: TournamentZone, context: ZoneGenerationContext): string {
  const storyCore = context.blueprintArtifacts.compiledBlueprint.data;
  const voiceLines = context.voiceTarget?.guidanceLines ?? [];
  const baseLines = [
    "You are Opus generating a single high-leverage chapter zone — not a full chapter.",
    "Match the existing chapter prose for POV, tense, and factual content.",
    "Output ONLY the zone text. No preamble, no commentary, no JSON.",
  ];
  const zoneLines = zone === "title"
    ? [
      "ZONE: chapter title.",
      "Return a single short title line (2-7 words). No quotes, no punctuation at end.",
    ]
    : zone === "opening"
      ? [
        "ZONE: chapter opening (~150-220 words).",
        "Open the chapter with an irresistible first paragraph or two: body in space, immediate pressure, signature voice. Do not summarize or recap.",
      ]
      : [
        "ZONE: chapter ending (single final paragraph).",
        "Land the chapter on the strongest possible page-turn beat consistent with the existing chapter ending and the spec ending hook target.",
        `Spec ending hook target: ${context.packet.endingHookTarget}`,
      ];
  return [
    ...baseLines,
    ...zoneLines,
    `STYLE RULES:\n${storyCore.styleRules.join("\n") || "None"}`,
    `ANTI-PATTERNS:\n${storyCore.antiPatterns.join("\n") || "None"}`,
    voiceLines.length > 0 ? `VOICE TARGET:\n${voiceLines.join("\n")}` : "VOICE TARGET: match the existing chapter's voice.",
  ].join("\n\n");
}

function buildZonePrompt(zone: TournamentZone, context: ZoneGenerationContext, currentZoneText: string): string {
  return [
    "<chapter_purpose>",
    context.packet.purpose,
    "</chapter_purpose>",
    "<approved_spec_excerpt>",
    compactJson({ openingImage: context.approvedSpec.openingImage, endingBeat: context.approvedSpec.endingBeat, scenePlan: context.approvedSpec.scenePlan.slice(-1) }),
    "</approved_spec_excerpt>",
    "<current_zone>",
    currentZoneText,
    "</current_zone>",
    "<chapter_prose>",
    context.selected.prose,
    "</chapter_prose>",
    `Generate ONE candidate for the ${zone} zone now. Do not repeat the current zone verbatim.`,
  ].join("\n\n");
}

const STAGE_FOR_ZONE: Record<TournamentZone, "openingCandidate" | "endingCandidate" | "titleCandidate"> = {
  opening: "openingCandidate",
  ending: "endingCandidate",
  title: "titleCandidate",
};

async function generateCandidate(params: {
  zone: TournamentZone;
  context: ZoneGenerationContext;
  currentZoneText: string;
  candidateIndex: number;
}): Promise<{ candidate: TournamentCandidate; usage?: StageUsage }> {
  const stageKey = STAGE_FOR_ZONE[params.zone];
  const stage = config.stageProfiles[stageKey];
  const result = await generateAnthropicText({
    stage,
    system: buildZoneSystemPrompt(params.zone, params.context),
    prompt: [
      buildZonePrompt(params.zone, params.context, params.currentZoneText),
      `Variation seed: candidate-${params.candidateIndex}.`,
    ].join("\n\n"),
  });
  return {
    candidate: {
      id: `${params.zone}-${params.candidateIndex}`,
      text: result.value.trim(),
      rationale: `Anthropic ${stage.stageName} candidate ${params.candidateIndex}.`,
    },
    usage: result.usage,
  };
}

async function pickPair(params: {
  zone: TournamentZone;
  pair: [TournamentCandidate, TournamentCandidate];
  context: ZoneGenerationContext;
  smoke: boolean;
}): Promise<{ result: TournamentPairResult; usage?: StageUsage }> {
  if (params.smoke) {
    // Deterministic: prefer the candidate with lower id sort
    const winner = params.pair[0].id <= params.pair[1].id ? params.pair[0] : params.pair[1];
    return {
      result: {
        pair: [params.pair[0].id, params.pair[1].id],
        winner: winner.id,
        rationale: `Smoke pairwise: deterministic preference for ${winner.id}.`,
      },
    };
  }

  const result = await generateStructuredOutput<{ winnerId: string; rationale: string }>({
    stage: config.stageProfiles.tournamentSelection,
    instructions: [
      "Pick the stronger of two candidates for a single chapter zone.",
      "Anchor the choice to genre contract, voice target, and reader compulsion.",
      "Return only the winnerId (must match one of the two candidate ids exactly) and a one-sentence rationale.",
    ].join("\n"),
    prompt: [
      `Zone: ${params.zone}`,
      `Genre contract: ${compactJson(params.context.blueprintArtifacts.genreContract.data)}`,
      `Voice target: ${compactJson(params.context.voiceTarget?.guidanceLines ?? [])}`,
      `Candidate ${params.pair[0].id}:\n${params.pair[0].text}`,
      `Candidate ${params.pair[1].id}:\n${params.pair[1].text}`,
    ].join("\n\n"),
    schemaName: "tournament_pick",
    schema: tournamentPickSchema,
  });
  const allowed = new Set(params.pair.map((c) => c.id));
  const winnerId = allowed.has(result.value.winnerId) ? result.value.winnerId : params.pair[0].id;
  return {
    result: {
      pair: [params.pair[0].id, params.pair[1].id],
      winner: winnerId,
      rationale: result.value.rationale,
    },
    usage: result.usage,
  };
}

interface ZoneRunResult {
  result: TournamentResult;
  usages: Array<{ stage: string; usage: StageUsage }>;
}

async function runZoneTournament(params: {
  zone: TournamentZone;
  currentZoneText: string;
  context: ZoneGenerationContext;
  smoke: boolean;
}): Promise<ZoneRunResult> {
  const usages: Array<{ stage: string; usage: StageUsage }> = [];
  const candidates: TournamentCandidate[] = [];

  if (params.smoke) {
    const baseText = params.zone === "title"
      ? params.currentZoneText.length > 0 ? params.currentZoneText : "Smoke Title"
      : params.currentZoneText;
    for (let i = 1; i <= 3; i += 1) {
      candidates.push({
        id: `${params.zone}-${i}`,
        text: params.zone === "title"
          ? `${baseText} ${i}`.trim()
          : `${baseText}\n\nSmoke variation ${i}: tighter rhythm, sharper exit.`.trim(),
        rationale: `Smoke candidate ${i}.`,
      });
    }
  } else {
    for (let i = 1; i <= 3; i += 1) {
      try {
        const generated = await generateCandidate({
          zone: params.zone,
          context: params.context,
          currentZoneText: params.currentZoneText,
          candidateIndex: i,
        });
        candidates.push(generated.candidate);
        if (generated.usage) {
          usages.push({
            stage: `${config.stageProfiles[STAGE_FOR_ZONE[params.zone]].stageName}-${i}`,
            usage: generated.usage,
          });
        }
      } catch (error) {
        console.error(`[tournament] ${params.zone} candidate ${i} failed: ${(error as Error).message}`);
      }
    }
  }

  const fallback: TournamentResult = {
    zone: params.zone,
    candidates,
    rounds: [],
    winnerId: "",
    winnerText: params.currentZoneText,
    applied: false,
    skipReason: null,
  };

  if (candidates.length === 0) {
    return {
      result: { ...fallback, skipReason: "No candidates generated." },
      usages,
    };
  }

  if (candidates.length === 1) {
    const winner = candidates[0]!;
    return {
      result: {
        ...fallback,
        winnerId: winner.id,
        winnerText: winner.text,
        applied: false,
        skipReason: "Only one candidate generated; held in artifact for review but did not enter merge.",
      },
      usages,
    };
  }

  const rounds: TournamentPairResult[] = [];
  let leader = candidates[0]!;
  for (let i = 1; i < candidates.length; i += 1) {
    const challenger = candidates[i]!;
    const pickResult = await pickPair({
      zone: params.zone,
      pair: [leader, challenger],
      context: params.context,
      smoke: params.smoke,
    });
    rounds.push(pickResult.result);
    if (pickResult.usage) {
      usages.push({
        stage: `${config.stageProfiles.tournamentSelection.stageName}-${params.zone}-${i}`,
        usage: pickResult.usage,
      });
    }
    leader = pickResult.result.winner === leader.id ? leader : challenger;
  }

  return {
    result: {
      ...fallback,
      candidates,
      rounds,
      winnerId: leader.id,
      winnerText: leader.text,
      applied: false,
      skipReason: null,
    },
    usages,
  };
}

function applyZoneToProse(params: {
  prose: string;
  zone: TournamentZone;
  zoneResult: TournamentResult;
}): string {
  if (params.zoneResult.skipReason || !params.zoneResult.winnerId) return params.prose;
  if (params.zone === "opening") {
    const slice = locateOpeningSlice(params.prose);
    if (!slice) return params.prose;
    return spliceOpening(params.prose, slice, params.zoneResult.winnerText);
  }
  if (params.zone === "ending") {
    const slice = locateEndingSlice(params.prose);
    if (!slice) return params.prose;
    return spliceParagraph(params.prose, slice.paragraphIndex, params.zoneResult.winnerText);
  }
  if (params.zone === "title") {
    const slice = locateTitleSlice(params.prose);
    if (!slice) return params.prose;
    return spliceParagraph(params.prose, slice.paragraphIndex, params.zoneResult.winnerText);
  }
  return params.prose;
}

function runProseValidators(packet: ChapterPacket, prose: string): ValidatorIssue[] {
  const wordCount = countWordsUtil(prose);
  const issues: ValidatorIssue[] = [];
  if (wordCount < packet.targetWordBand.min || wordCount > packet.targetWordBand.max) {
    issues.push({
      severity: "error",
      code: "WORD_BAND",
      message: `Tournament-merged word count ${wordCount} outside target band ${packet.targetWordBand.min}-${packet.targetWordBand.max}.`,
      evidence: [String(wordCount)],
    });
  }
  const knowledgeMatrix = packet.rollingMemory?.knowledgeMatrix ?? [];
  issues.push(
    ...detectRepetition(prose),
    ...detectFilterWords(prose),
    ...checkParagraphDistribution(prose),
    ...checkDialogueTags(prose),
    ...detectKnowledgeLeaks(prose, knowledgeMatrix),
  );
  return issues;
}

export interface TournamentRunResult {
  selectedArtifact: ArtifactEnvelope<SelectedChapter>;
  selectedReviewArtifact: ArtifactEnvelope<DraftReview>;
  mergedArtifact: ArtifactEnvelope<TournamentMerged>;
  zoneArtifacts: Partial<Record<TournamentZone, ArtifactEnvelope<TournamentResult>>>;
  rejudgeArtifact: ArtifactEnvelope<DraftReview> | null;
  usages: Array<{ stage: string; usage: StageUsage }>;
}

export async function runOpeningEndingTournament(params: {
  packetArtifact: ArtifactEnvelope<ChapterPacket>;
  approvedSpecArtifact: ArtifactEnvelope<ChapterSpec>;
  selectedArtifact: ArtifactEnvelope<SelectedChapter>;
  selectedReviewArtifact: ArtifactEnvelope<DraftReview>;
  voiceTarget: VoiceTarget | null;
  blueprintArtifacts: BlueprintCompilationArtifacts;
  smoke: boolean;
}): Promise<TournamentRunResult> {
  const usages: Array<{ stage: string; usage: StageUsage }> = [];
  const preProse = params.selectedArtifact.data.prose;
  const preReviewScore = params.selectedReviewArtifact.data.overallScore;
  const context: ZoneGenerationContext = {
    packet: params.packetArtifact.data,
    approvedSpec: params.approvedSpecArtifact.data,
    voiceTarget: params.voiceTarget,
    blueprintArtifacts: params.blueprintArtifacts,
    selected: params.selectedArtifact.data,
  };

  const baseMerged: TournamentMerged = {
    status: "skipped",
    reason: "Tournament skipped.",
    zones: { opening: null, ending: null, title: null },
    preReviewScore,
    postReviewScore: null,
    preProse,
    finalProse: preProse,
    finalTitle: null,
  };

  const zoneArtifacts: Partial<Record<TournamentZone, ArtifactEnvelope<TournamentResult>>> = {};

  // Determine which zones to run
  const opening = locateOpeningSlice(preProse);
  const ending = locateEndingSlice(preProse);
  const title = locateTitleSlice(preProse);

  // Try each zone independently. Failure of one zone must not block others.
  let mergedProse = preProse;
  const finalZones: Record<TournamentZone, TournamentResult | null> = { opening: null, ending: null, title: null };

  const tryZone = async (zone: TournamentZone, currentText: string | null) => {
    if (currentText === null) {
      finalZones[zone] = {
        zone,
        candidates: [],
        rounds: [],
        winnerId: "",
        winnerText: "",
        applied: false,
        skipReason: `${zone} zone not located in prose; skipped.`,
      };
      return;
    }
    try {
      const zoneRun = await runZoneTournament({ zone, currentZoneText: currentText, context, smoke: params.smoke });
      usages.push(...zoneRun.usages);

      // Determine `applied` BEFORE persisting the zone artifact, so the
      // written artifact reflects whether this zone was merged into the
      // candidate prose for downstream validation/re-judge.
      let appliedToMerge = false;
      if (!zoneRun.result.skipReason && zoneRun.result.winnerId) {
        const next = applyZoneToProse({ prose: mergedProse, zone, zoneResult: zoneRun.result });
        if (next !== mergedProse) {
          mergedProse = next;
          appliedToMerge = true;
        }
      }
      zoneRun.result.applied = appliedToMerge;
      finalZones[zone] = zoneRun.result;

      const zoneArtifact = createArtifact<TournamentResult>({
        artifactType: `tournament-${zone}`,
        blueprintHash: params.packetArtifact.blueprintHash,
        blueprintVersion: params.packetArtifact.blueprintVersion,
        chapterNumber: params.packetArtifact.chapterNumber,
        qualityProfile: params.packetArtifact.qualityProfile,
        data: zoneRun.result,
      });
      await writeJson(
        chapterArtifactPath(params.packetArtifact.data.chapterNumber, `tournament-${zone}`),
        zoneArtifact,
      );
      zoneArtifacts[zone] = zoneArtifact;
    } catch (error) {
      console.error(`[tournament] ${zone} failed: ${(error as Error).message}`);
      finalZones[zone] = {
        zone,
        candidates: [],
        rounds: [],
        winnerId: "",
        winnerText: "",
        applied: false,
        skipReason: `Failed: ${(error as Error).message}`,
      };
    }
  };

  await tryZone("opening", opening?.text ?? null);
  await tryZone("ending", ending?.text ?? null);
  await tryZone("title", title?.text ?? null);

  const anyApplied = Object.values(finalZones).some((z) => z?.applied);
  if (!anyApplied) {
    const merged: TournamentMerged = {
      ...baseMerged,
      status: "skipped",
      reason: "No tournament zones were applied (no candidates won or zones unavailable).",
      zones: finalZones,
    };
    const mergedArtifact = createArtifact<TournamentMerged>({
      artifactType: "tournament-merged",
      blueprintHash: params.packetArtifact.blueprintHash,
      blueprintVersion: params.packetArtifact.blueprintVersion,
      chapterNumber: params.packetArtifact.chapterNumber,
      qualityProfile: params.packetArtifact.qualityProfile,
      data: merged,
    });
    await writeJson(chapterArtifactPath(params.packetArtifact.data.chapterNumber, "tournament-merged"), mergedArtifact);
    return {
      selectedArtifact: params.selectedArtifact,
      selectedReviewArtifact: params.selectedReviewArtifact,
      mergedArtifact,
      zoneArtifacts,
      rejudgeArtifact: null,
      usages,
    };
  }

  // Validate the merged prose
  const validatorIssues = runProseValidators(params.packetArtifact.data, mergedProse);
  if (validatorIssues.some((issue) => issue.severity === "error")) {
    const merged: TournamentMerged = {
      ...baseMerged,
      status: "validators-failed",
      reason: `Tournament merge failed validators: ${validatorIssues.filter((i) => i.severity === "error").map((i) => i.code).join(", ")}`,
      zones: finalZones,
    };
    const mergedArtifact = createArtifact<TournamentMerged>({
      artifactType: "tournament-merged",
      blueprintHash: params.packetArtifact.blueprintHash,
      blueprintVersion: params.packetArtifact.blueprintVersion,
      chapterNumber: params.packetArtifact.chapterNumber,
      qualityProfile: params.packetArtifact.qualityProfile,
      data: merged,
    });
    await writeJson(chapterArtifactPath(params.packetArtifact.data.chapterNumber, "tournament-merged"), mergedArtifact);
    return {
      selectedArtifact: params.selectedArtifact,
      selectedReviewArtifact: params.selectedReviewArtifact,
      mergedArtifact,
      zoneArtifacts,
      rejudgeArtifact: null,
      usages,
    };
  }

  // Re-judge the merged prose
  const wordCount = countWordsUtil(mergedProse);
  const rejudgeArtifact = await judgeDraft({
    candidateId: params.selectedArtifact.data.winner,
    packetArtifact: params.packetArtifact,
    approvedSpecArtifact: params.approvedSpecArtifact,
    draftArtifact: createArtifact<ChapterDraft>({
      artifactType: "tournament-rejudge-draft",
      blueprintHash: params.selectedArtifact.blueprintHash,
      blueprintVersion: params.selectedArtifact.blueprintVersion,
      chapterNumber: params.selectedArtifact.chapterNumber,
      qualityProfile: params.selectedArtifact.qualityProfile,
      data: { prose: mergedProse, wordCount },
    }),
    blueprintArtifacts: params.blueprintArtifacts,
    smoke: params.smoke,
    // Tag the on-disk envelope so it identifies as a tournament rejudge,
    // not a draft/revised review. Tournament keeps the default literary
    // judge stage so runtime budget/reasoning matches the estimate, which
    // also names this stage `tournament-rejudge` over the literaryJudge profile.
    artifactType: "tournament-rejudge",
    persistArtifact: false,
  });
  await writeJson(
    chapterArtifactPath(params.packetArtifact.data.chapterNumber, "tournament-rejudge"),
    rejudgeArtifact,
  );
  if (rejudgeArtifact.usage) {
    usages.push({ stage: "tournament-rejudge", usage: rejudgeArtifact.usage });
  }

  const postReviewScore = rejudgeArtifact.data.overallScore;
  const regressed = postReviewScore < preReviewScore - REJUDGE_REGRESSION_TOLERANCE
    || rejudgeArtifact.data.blockingIssues.length > 0
    || rejudgeArtifact.data.issues.some((issue) => issue.severity === "error");

  if (regressed) {
    const merged: TournamentMerged = {
      ...baseMerged,
      status: "rejudge-regressed",
      reason: `Tournament re-judge regressed: pre=${preReviewScore} post=${postReviewScore} blocking=${rejudgeArtifact.data.blockingIssues.length}`,
      zones: finalZones,
      postReviewScore,
    };
    const mergedArtifact = createArtifact<TournamentMerged>({
      artifactType: "tournament-merged",
      blueprintHash: params.packetArtifact.blueprintHash,
      blueprintVersion: params.packetArtifact.blueprintVersion,
      chapterNumber: params.packetArtifact.chapterNumber,
      qualityProfile: params.packetArtifact.qualityProfile,
      data: merged,
    });
    await writeJson(chapterArtifactPath(params.packetArtifact.data.chapterNumber, "tournament-merged"), mergedArtifact);
    return {
      selectedArtifact: params.selectedArtifact,
      selectedReviewArtifact: params.selectedReviewArtifact,
      mergedArtifact,
      zoneArtifacts,
      rejudgeArtifact,
      usages,
    };
  }

  const updatedSelected: ArtifactEnvelope<SelectedChapter> = {
    ...params.selectedArtifact,
    createdAt: new Date().toISOString(),
    data: {
      ...params.selectedArtifact.data,
      prose: mergedProse,
      wordCount,
      review: rejudgeArtifact.data,
    },
  };
  const updatedReview: ArtifactEnvelope<DraftReview> = { ...rejudgeArtifact };
  await writeJson(chapterArtifactPath(params.packetArtifact.data.chapterNumber, "selected"), updatedSelected);
  await writeJson(chapterArtifactPath(params.packetArtifact.data.chapterNumber, "review"), updatedReview);

  const merged: TournamentMerged = {
    ...baseMerged,
    status: "applied",
    reason: `Applied ${Object.values(finalZones).filter((z) => z?.applied).length} tournament zone(s).`,
    zones: finalZones,
    postReviewScore,
    finalProse: mergedProse,
    finalTitle: finalZones.title?.applied ? finalZones.title.winnerText : null,
  };
  const mergedArtifact = createArtifact<TournamentMerged>({
    artifactType: "tournament-merged",
    blueprintHash: params.packetArtifact.blueprintHash,
    blueprintVersion: params.packetArtifact.blueprintVersion,
    chapterNumber: params.packetArtifact.chapterNumber,
    qualityProfile: params.packetArtifact.qualityProfile,
    data: merged,
  });
  await writeJson(chapterArtifactPath(params.packetArtifact.data.chapterNumber, "tournament-merged"), mergedArtifact);

  return {
    selectedArtifact: updatedSelected,
    selectedReviewArtifact: updatedReview,
    mergedArtifact,
    zoneArtifacts,
    rejudgeArtifact,
    usages,
  };
}
