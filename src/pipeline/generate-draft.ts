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
      "- When the chapter packet provides a `locations` table, use each entry's `name` (or one of its `aliases`) as the canonical name for that recurring space. Do not invent variant names for the same place across the chapter.",
    ].join("\n"),
  );

  sections.push(
    [
      "CHAPTER-1 LESSONS — HARD RULES (treat as contracts; violation is a craft failure):",
      "",
      "- H1. Every scene must turn the story. By the end, someone must know more, hide more, fear more, misread something, make a choice, lose control, or shift loyalty. Atmosphere alone is not a turn.",
      "- H2. Earn a remembered name with a future hook. Name a character only when the name will do work the reader needs later — recurrence, recognition, recall, or a hook the plot will collect. For everyone else, render through role + one vivid detail (a press attendant in service black, a steward at the cloakroom, a journalist she half-recognized, a senator holding his glass in both hands the way a man holds a child he has just lifted up). Naming a walk-on is a cost the chapter must be willing to pay; if the name has no future job, drop it.",
      "- H3. Anchor any clue whose physical state changes within this chapter. Tie it to a simple fixed marker (a screw, nick, seam, gauge, light, sound, position). Before-state and after-state must be visually unmistakable in the prose. When `physicalClueAnchors` is set on the spec, follow it. Cross-chapter plants belong in `revealControl`, not here. CLARITY FLOOR: at the moment the change becomes visible, include at least one short plain sentence stating the change in unornamented terms ('The thread had moved.' / 'The water was wrong.' / 'The seal had cracked.'). Lyrical compression, metaphor, and rhetorical doubling are welcome alongside the plain sentence, but they must not replace it. The plain sentence anchors the lyricism; without it, the reader has to translate a metaphor to know what physically changed.",
      "- H4. Each chapter ending must create an irreversible shift in knowledge, danger, guilt, loyalty, or control. The reader and at least one character must be unable to return to the prior state of certainty.",
      "",
      "CHAPTER-1 LESSONS — DEFAULTS (break only with reason):",
      "",
      "- D1. Give every POV a distinct noticing engine. When `noticingEngine` is set on a character card, that character must perceive the scene through it (job, fear, training, class, guilt, or habit). No two POV sections in a chapter should sound like the same narrator wearing different hats.",
      "- D2. Keep suspense procedural. Characters first process danger through role, habit, etiquette, denial, or training before they understand the full threat. Do not let them narrate the theme or explain the danger on contact. When a POV character's voice card lists `mistakenBeliefs`, the prose should let those beliefs drive their reading of the scene (classification, dismissal, comforting interpretation), not contradict them prematurely. When an expert POV (architect, engineer, doctor, pilot, navigator, captain, scientist, technician, surgeon, mechanic) observes danger and does not act within the chapter, make the reason for delay legible to the reader in one brief beat — a remembered prior conversation, a glance at the in-room obstacle (a host mid-toast, a roomful of investors, a private leverage already being held), a word said and withdrawn, or an interior thought tied to a specific on-page person or object. A reader should be able to answer 'why didn't they just tell someone?' from material already on the page. Tragic hesitation is earned; plot-convenient silence is a craft failure.",
      "- D3. Technical details must do at least one job: create tension, clarify space, reveal character, set up consequence, or produce later irony. If a detail only sounds cool, cut it.",
      "- D4. Use big cinematic imagery only at structural thresholds: arrival, reveal, disaster, realization, irreversible ending. Between thresholds, keep prose concrete and functional.",
      "- D5. Motifs may repeat only when they escalate, reverse, or gain new context. Do not repeat the same image at the same emotional intensity.",
      "- D6. Maintain the core contrast: social performance and luxury above, machinery and procedure underneath. Both surfaces should be present in any scene that occupies the contested space.",
      "- D7. Charismatic characters may be genuinely graceful or useful early; their grace may be instinct, performance, or both. This ambiguity has a shelf life — defer to the chapter function profile and pacing contract for when the ambiguity must close.",
      "- D8. Keep dialogue mixed and human: formal speech, work speech, evasions, interruptions, jokes, corrections, plain reactions. Not every line should be quotable. When a scene risks reading too polished, ground it with ordinary behavior — a practical concern, fatigue, awkwardness, a small kindness, a routine task. Use `humanGrain` from the scene plan when it is non-null; do not invent forced business when it is null.",
      "- D9. Do not over-explain what an image, action, silence, or gesture already proves. Withholding should be structural, not narrated.",
      "- D10. When `revealControl` carries multiple mysteries (`show` / `hint` / `reveal` / `withhold`), do not spotlight all of them equally. Treat the most plot-bearing one as the primary mystery the reader actively tracks, others as secondary mysteries to notice, and the rest as atmospheric — felt, not explained.",
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
): Omit<ChapterPacket, "rollingMemory" | "handoffMemory" | "compactContext" | "voiceTarget" | "previousChapterExcerpt"> {
  const {
    rollingMemory: _,
    handoffMemory: _h,
    compactContext: _c,
    voiceTarget: _v,
    previousChapterExcerpt: _pe,
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
