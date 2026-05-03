import { generateText as generateAnthropicText } from "../api/anthropic.js";
import { config } from "../config.js";
import type {
  ArtifactEnvelope,
  BlueprintCompilationArtifacts,
  ChapterDraft,
  ChapterPacket,
  ChapterSpec,
  DraftReview,
} from "../types/index.js";
import { chapterArtifactPath, countWords, createArtifact } from "./stage-utils.js";
import { buildDraftSystemPrompt, stripHeavyPacketFields } from "./generate-draft.js";
import { createSmokeDraft } from "./smoke-helpers.js";
import { compactJson, writeJson } from "../utils/index.js";

export async function reviseDraft(params: {
  packetArtifact: ArtifactEnvelope<ChapterPacket>;
  approvedSpecArtifact: ArtifactEnvelope<ChapterSpec>;
  draftArtifact: ArtifactEnvelope<ChapterDraft>;
  draftReviewArtifact: ArtifactEnvelope<DraftReview>;
  blueprintArtifacts: BlueprintCompilationArtifacts;
  smoke: boolean;
  additionalSystemInstructions?: string[];
  additionalPromptSections?: string[];
}): Promise<ArtifactEnvelope<ChapterDraft>> {
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

  const artifact = createArtifact<ChapterDraft>({
    artifactType: "revised-draft",
    blueprintHash: packetArtifact.blueprintHash,
    blueprintVersion: packetArtifact.blueprintVersion,
    chapterNumber: packetArtifact.chapterNumber,
    qualityProfile: packetArtifact.qualityProfile,
    data: draft,
    usage,
  });

  await writeJson(chapterArtifactPath(packetArtifact.data.chapterNumber, "revised-draft"), artifact);
  return artifact;
}
