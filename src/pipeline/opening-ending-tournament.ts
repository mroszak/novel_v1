import { generateText as generateAnthropicText } from "../api/anthropic.js";
import { generateStructuredOutput } from "../api/openai.js";
import { config } from "../config.js";
import type {
  ArtifactEnvelope,
  BlueprintCompilationArtifacts,
  ChapterPacket,
  ChapterSpec,
  DraftReview,
  SelectedChapter,
  StageUsage,
  TournamentCandidate,
  TournamentMerged,
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
import { chapterArtifactPath, createArtifact } from "./stage-utils.js";

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
  paragraphs: number[];
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
  const zoneLines = zone === "opening"
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

const STAGE_FOR_ZONE: Record<TournamentZone, "openingCandidate" | "endingCandidate"> = {
  opening: "openingCandidate",
  ending: "endingCandidate",
};

async function generateCandidate(params: {
  zone: TournamentZone;
  context: ZoneGenerationContext;
  currentZoneText: string;
}): Promise<{ candidate: TournamentCandidate; usage?: StageUsage }> {
  const stageKey = STAGE_FOR_ZONE[params.zone];
  const stage = config.stageProfiles[stageKey];
  const result = await generateAnthropicText({
    stage,
    system: buildZoneSystemPrompt(params.zone, params.context),
    prompt: buildZonePrompt(params.zone, params.context, params.currentZoneText),
  });
  return {
    candidate: {
      id: `${params.zone}-1`,
      text: result.value.trim(),
      rationale: `Anthropic ${stage.stageName} candidate.`,
    },
    usage: result.usage,
  };
}

async function pickWinner(params: {
  zone: TournamentZone;
  original: TournamentCandidate;
  candidate: TournamentCandidate;
  context: ZoneGenerationContext;
  smoke: boolean;
}): Promise<{ winnerId: string; rationale: string; usage?: StageUsage }> {
  if (params.smoke) {
    return {
      winnerId: params.candidate.id,
      rationale: "Smoke pairwise: deterministic preference for new candidate.",
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
      `Candidate ${params.original.id} (current):\n${params.original.text}`,
      `Candidate ${params.candidate.id} (new):\n${params.candidate.text}`,
    ].join("\n\n"),
    schemaName: "tournament_pick",
    schema: tournamentPickSchema,
  });
  const allowed = new Set([params.original.id, params.candidate.id]);
  const winnerId = allowed.has(result.value.winnerId) ? result.value.winnerId : params.original.id;
  return {
    winnerId,
    rationale: result.value.rationale,
    usage: result.usage,
  };
}

function applyZoneToProse(params: {
  prose: string;
  zone: TournamentZone;
  zoneResult: TournamentResult;
}): string {
  if (params.zoneResult.skipReason || !params.zoneResult.winnerId || !params.zoneResult.applied) return params.prose;
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
  usages: Array<{ stage: string; usage: StageUsage }>;
}

async function runZone(params: {
  zone: TournamentZone;
  currentZoneText: string;
  context: ZoneGenerationContext;
  smoke: boolean;
}): Promise<{ result: TournamentResult; usages: Array<{ stage: string; usage: StageUsage }> }> {
  const usages: Array<{ stage: string; usage: StageUsage }> = [];
  const original: TournamentCandidate = {
    id: `${params.zone}-original`,
    text: params.currentZoneText,
    rationale: "Original zone text from the selected chapter.",
  };

  let candidate: TournamentCandidate;
  if (params.smoke) {
    candidate = {
      id: `${params.zone}-1`,
      text: `${params.currentZoneText}\n\nSmoke variation: tighter rhythm, sharper exit.`.trim(),
      rationale: "Smoke candidate.",
    };
  } else {
    const generated = await generateCandidate({
      zone: params.zone,
      context: params.context,
      currentZoneText: params.currentZoneText,
    });
    candidate = generated.candidate;
    if (generated.usage) {
      usages.push({
        stage: `${config.stageProfiles[STAGE_FOR_ZONE[params.zone]].stageName}-1`,
        usage: generated.usage,
      });
    }
  }

  const pick = await pickWinner({
    zone: params.zone,
    original,
    candidate,
    context: params.context,
    smoke: params.smoke,
  });
  if (pick.usage) {
    usages.push({
      stage: `${config.stageProfiles.tournamentSelection.stageName}-${params.zone}-1`,
      usage: pick.usage,
    });
  }

  const candidateWon = pick.winnerId === candidate.id;
  return {
    result: {
      zone: params.zone,
      candidates: [original, candidate],
      rounds: [
        {
          pair: [original.id, candidate.id],
          winner: pick.winnerId,
          rationale: pick.rationale,
        },
      ],
      winnerId: pick.winnerId,
      winnerText: candidateWon ? candidate.text : original.text,
      applied: candidateWon,
      skipReason: candidateWon ? null : "Original zone text won pairwise comparison.",
    },
    usages,
  };
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
    zones: { opening: null, ending: null },
    preReviewScore,
    postReviewScore: null,
    preProse,
    finalProse: preProse,
  };

  const zoneArtifacts: Partial<Record<TournamentZone, ArtifactEnvelope<TournamentResult>>> = {};
  const finalZones: Record<TournamentZone, TournamentResult | null> = { opening: null, ending: null };

  const opening = locateOpeningSlice(preProse);
  const ending = locateEndingSlice(preProse);

  let mergedProse = preProse;

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
      const zoneRun = await runZone({ zone, currentZoneText: currentText, context, smoke: params.smoke });
      usages.push(...zoneRun.usages);
      finalZones[zone] = zoneRun.result;

      if (zoneRun.result.applied) {
        const next = applyZoneToProse({ prose: mergedProse, zone, zoneResult: zoneRun.result });
        if (next !== mergedProse) {
          mergedProse = next;
        } else {
          zoneRun.result.applied = false;
          zoneRun.result.skipReason = "Merge skipped: zone splice did not change prose.";
        }
      }

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
      usages,
    };
  }

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
      usages,
    };
  }

  const wordCount = countWordsUtil(mergedProse);
  const updatedSelected: ArtifactEnvelope<SelectedChapter> = {
    ...params.selectedArtifact,
    createdAt: new Date().toISOString(),
    data: {
      ...params.selectedArtifact.data,
      prose: mergedProse,
      wordCount,
    },
  };
  await writeJson(chapterArtifactPath(params.packetArtifact.data.chapterNumber, "selected"), updatedSelected);

  const merged: TournamentMerged = {
    ...baseMerged,
    status: "applied",
    reason: `Applied ${Object.values(finalZones).filter((z) => z?.applied).length} tournament zone(s).`,
    zones: finalZones,
    finalProse: mergedProse,
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
    selectedReviewArtifact: params.selectedReviewArtifact,
    mergedArtifact,
    zoneArtifacts,
    usages,
  };
}
