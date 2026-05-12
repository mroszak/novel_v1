import { generateText as generateAnthropicText } from "../api/anthropic.js";
import { config } from "../config.js";
import type {
  ArtifactEnvelope,
  AuthorBrief,
  BlueprintCompilationArtifacts,
  ChapterDraft,
  ChapterFunctionProfile,
  ChapterPacket,
  ChapterSpec,
  GenreContract,
  MarketPositioningSection,
  MarketPromise,
  StoryPromiseSection,
  VoiceTarget,
} from "../types/index.js";
import { mapChapterFunctionToReaderJob } from "./generate-spec.js";
import { createSmokeDraft } from "./smoke-helpers.js";
import { chapterArtifactPath, countWords, createArtifact } from "./stage-utils.js";
import { compactJson, writeJson } from "../utils/index.js";

export function buildDraftSystemPrompt(params: {
  genreContract: GenreContract;
  storyPromise: StoryPromiseSection;
  marketPositioning: MarketPositioningSection;
  chapterFunction: ChapterFunctionProfile;
  styleRules: string[];
  antiPatterns: string[];
  comparables: string[];
  voiceTarget?: VoiceTarget | null;
  authorBrief?: AuthorBrief | null;
  marketPromise?: MarketPromise | null;
}): string {
  const {
    genreContract, storyPromise, chapterFunction, styleRules, antiPatterns,
    comparables, voiceTarget, authorBrief, marketPromise,
  } = params;
  const controls = genreContract.controls;

  const sections: string[] = [
    "You are Opus drafting a full novel chapter in one pass. Write polished manuscript prose, not notes. Output only the chapter prose.",
  ];

  if (authorBrief) {
    sections.push(
      [
        "AUTHORIAL PERSONA:",
        authorBrief.authorialPersona,
        "",
        "CRAFT DIRECTIVES:",
        ...authorBrief.craftDirectives.map((line) => `- ${line}`),
      ].join("\n"),
    );
  }

  sections.push(
    `STORY PROMISE: ${storyPromise.storyPromise}`,
    `READER PROMISE: ${storyPromise.readerPromise}`,
    `CHAPTER FUNCTION: ${chapterFunction.function} (${chapterFunction.pacingDirective})`,
  );

  if (marketPromise) {
    sections.push(
      [
        "COMMERCIAL HOOK:",
        marketPromise.coreCommercialHook,
        "EMOTIONAL PROMISE:",
        marketPromise.emotionalPromise,
      ].join("\n"),
    );
  }

  const readerJob = mapChapterFunctionToReaderJob(chapterFunction.function, marketPromise ?? null);
  if (readerJob) {
    sections.push(
      [
        `READER JOB FOR THIS CHAPTER (function: ${chapterFunction.function}):`,
        readerJob,
        "Land this job. The chapter ending must serve it. Do not let it become decoration.",
      ].join("\n"),
    );
  }

  sections.push(

    [
      "PROSE CRAFT DIRECTIVES:",
      "- Write in close third person anchored to the POV character's sensory and emotional filter. Every observation passes through their specific knowledge, fears, and blind spots.",
      "- Vary sentence length deliberately. Short blunt clauses for impact and pressure. Longer flowing sentences for observation, interiority, and earned stillness.",
      "- Open each scene with the POV character's body in space — position, sensation, immediate environment — before any thought or exposition.",
      "- Dialogue under stress shortens, sharpens, and hides more than it explains. Characters speak around the truth, not at it.",
      "- Earn every emotional beat through action and consequence. Never explain theme when behavior can carry it.",
      `- Prose compression: ${controls.proseCompression}`,
      `- Sensory palette: ${controls.sensoryDensity}`,
      `- Pacing curve: ${controls.pacingCurve}`,
      `- Emotional dwell: ${controls.emotionalDwellExpectation}`,
    ].join("\n"),
  );

  if (styleRules.length > 0) {
    sections.push(`STYLE RULES (follow precisely):\n${styleRules.map((r) => `- ${r}`).join("\n")}`);
  }

  if (antiPatterns.length > 0) {
    sections.push(`HARD CONSTRAINTS (never do these):\n${antiPatterns.map((p) => `- ${p}`).join("\n")}`);
  }

  sections.push(
    [
      "UNIVERSAL CRAFT CONSTRAINTS:",
      "- Land EVERY mandatory beat in the approved spec, in spec order, before spending budget on extra texture or atmosphere. The chapter ending image is non-negotiable; reach it. If you must trim, trim the early luxuriance, not the required ending.",
      "- Budget the chapter against the targetWordBand in the packet. Aim for the middle of the band, not the top. Treat each scene as a budget envelope; if a scene is overrunning, compress it and move on rather than carrying the overrun forward.",
      "- Never use filter words as first resort (felt, seemed, noticed, appeared, watched, realized).",
      '- Never use dead cliches (heart pounded, blood ran cold, couldn\'t believe, let out a breath).',
      "- Never open a scene with weather, a gerund phrase, or throat-clearing exposition.",
      "- Never let two consecutive sentences share the same grammatical structure.",
      "- Never summarize a scene that should be dramatized.",
      "- Voice notes, character habits, and motifs in the packet are BEHAVIOR PATTERNS, not phrases to copy. If a voice note says 'counts before he speaks,' dramatize the silence — never write the literal phrase 'counted before he spoke' or any near-verbatim variant. Render the same behavior with different surface wording across recurrences.",
      "- A four-word span from the prompt context (voice notes, motif descriptions, mandatory beats) must NEVER appear verbatim in your prose. The prompt is scaffolding; the prose is craft.",
      "- A motif image (e.g., a hidden object pressing against ribs) may appear at most TWICE in a chapter, and the second occurrence must vary the wording and the sensory frame from the first. Repeating a motif sentence verbatim is a craft failure even if the motif itself is required.",
      "- When `namedCharacterCap` is set on the packet, keep the count of distinct named blueprint characters at or below the cap. Render any additional human detail through unnamed walk-ons (`the waiter`, `the senator's aide`, `a girl in service black`); they don't count against the cap. Compressing the named cast is a craft choice, not a contract violation.",
    ].join("\n"),
  );

  if (comparables.length > 0) {
    sections.push(`Write at the literary quality level of: ${comparables.join(", ")}. Match their tension architecture and sentence sophistication.`);
  }

  if (voiceTarget && voiceTarget.guidanceLines.length > 0) {
    const sourceLabel = voiceTarget.source === "style-sample"
      ? "from author-supplied STYLE_SAMPLE.md"
      : voiceTarget.source === "derived"
        ? `derived from your published chapter(s) ${voiceTarget.derivedFromChapters.join(", ")}`
        : "blueprint fallback";
    sections.push(
      [
        `VOICE SIGNATURE TARGET (${sourceLabel}). Honor these as authorial voice constraints:`,
        ...voiceTarget.guidanceLines.map((line) => `- ${line}`),
      ].join("\n"),
    );
  }

  sections.push("Match the prose register, sentence complexity, and POV interiority of the previous chapter when one is provided. Voice consistency across chapters is critical.");
  sections.push("Honor the approved spec exactly. Keep the genre contract active. Preserve reveal discipline — never leak withheld information.");

  return sections.join("\n\n");
}

export function stripHeavyPacketFields(
  packet: ChapterPacket,
): Omit<ChapterPacket, "rollingMemory" | "handoffMemory" | "compactContext" | "voiceTarget"> {
  const {
    rollingMemory: _,
    handoffMemory: _h,
    compactContext: _c,
    voiceTarget: _v,
    ...core
  } = packet;
  return core;
}

export async function generateDraft(params: {
  packetArtifact: ArtifactEnvelope<ChapterPacket>;
  approvedSpecArtifact: ArtifactEnvelope<ChapterSpec>;
  blueprintArtifacts: BlueprintCompilationArtifacts;
  smoke: boolean;
}): Promise<ArtifactEnvelope<ChapterDraft>> {
  const { packetArtifact, approvedSpecArtifact, blueprintArtifacts, smoke } = params;
  const storyCore = blueprintArtifacts.compiledBlueprint.data;

  let draft: ChapterDraft;
  let usage: ArtifactEnvelope<ChapterDraft>["usage"];

  if (smoke) {
    draft = createSmokeDraft(packetArtifact.data, approvedSpecArtifact.data, false);
    usage = undefined;
  } else {
    const systemPrompt = buildDraftSystemPrompt({
      genreContract: blueprintArtifacts.genreContract.data,
      storyPromise: storyCore.storyPromise,
      marketPositioning: storyCore.marketPositioning,
      chapterFunction: packetArtifact.data.chapterFunction,
      styleRules: storyCore.styleRules,
      antiPatterns: storyCore.antiPatterns,
      comparables: storyCore.marketPositioning.comparables,
      voiceTarget: packetArtifact.data.voiceTarget,
      authorBrief: packetArtifact.data.authorBrief,
      marketPromise: packetArtifact.data.marketPromise,
    });

    const result = await generateAnthropicText({
      stage: config.stageProfiles.drafting,
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
        "<motifs>",
        storyCore.motifBank.join("\n"),
        "</motifs>",
        "<continuity_memory>",
        compactJson(packetArtifact.data.rollingMemory),
        "</continuity_memory>",
        "<continuity_active_slice>",
        compactJson(packetArtifact.data.continuityActiveSlice),
        "</continuity_active_slice>",
        "<handoff_memory>",
        compactJson(packetArtifact.data.handoffMemory),
        "</handoff_memory>",
        "<previous_chapter>",
        packetArtifact.data.compactContext.previousChapterFull ?? "No previous chapter.",
        "</previous_chapter>",
      ].join("\n"),
    });

    draft = {
      prose: result.value,
      wordCount: countWords(result.value),
    };
    usage = result.usage;
  }

  const artifact = createArtifact<ChapterDraft>({
    artifactType: "chapter-draft",
    blueprintHash: packetArtifact.blueprintHash,
    blueprintVersion: packetArtifact.blueprintVersion,
    chapterNumber: packetArtifact.chapterNumber,
    data: draft,
    usage,
  });

  await writeJson(chapterArtifactPath(packetArtifact.data.chapterNumber, "draft"), artifact);
  return artifact;
}
