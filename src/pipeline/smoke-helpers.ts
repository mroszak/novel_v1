import type {
  ChapterDelta,
  ChapterDraft,
  ChapterPacket,
  ChapterSpec,
  DraftReview,
  FinalAuditReport,
  HandoffMemory,
  MemoryUpdateProposal,
  PairwiseSelection,
  PolishPlan,
  ReaderSimulation,
  ReviewScoreBreakdown,
  RollingMemory,
  SelectedChapter,
  SelfRedTeamReport,
  TournamentResult,
  TournamentZone,
  ValidatorReport,
} from "../types/index.js";
import { READER_PERSONA_IDS } from "../types/index.js";
import { config } from "../config.js";
import { calculateOverallScore, derivePassesThreshold } from "./judge-draft.js";
import { countWords } from "./stage-utils.js";

const smokeNearPassRevisionLine = "The first revision improved clarity but still left the ending a beat too diffuse.";
const smokeRetryPassLine = "The literary retry tightened the opening, hardened the diction, and cut on the strongest hook.";

function sentence(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function createSmokeSpec(packet: ChapterPacket): ChapterSpec {
  return {
    title: packet.title,
    purpose: packet.purpose,
    openingImage: `Open with ${packet.activeCast[0]?.name ?? "the protagonist"} under immediate pressure tied to ${packet.purpose}.`,
    scenePlan: [
      {
        sceneNumber: 1,
        location: "Immediate story environment",
        objective: "Establish pressure and carry the opening handoff",
        summary: `Show the chapter promise through ${packet.mandatoryBeats[0] ?? "a concrete destabilizing beat"}.`,
        turn: "The initial problem sharpens instead of easing.",
        revealHandling: `Show ${packet.revealBudget.show[0] ?? "the visible pressure"}, hint ${packet.revealBudget.hint[0] ?? "hidden strain"}, and withhold ${packet.revealBudget.withhold[0] ?? "the deeper truth"}.`,
        exitCondition: "The protagonist is forced into a sharper next move.",
        emotionalArc: "From controlled watchfulness to sharpening unease.",
        sensoryAnchor: "Immediate physical environment — texture, temperature, ambient sound.",
        dialogueStrategy: "Characters perform normalcy while subtext carries the real pressure.",
      },
      {
        sceneNumber: 2,
        location: "Escalated pressure point",
        objective: "Advance the chapter-specific obligation",
        summary: `Deliver ${packet.mandatoryBeats[1] ?? "the main escalation"} while honoring callbacks.`,
        turn: "A costly complication reframes the problem.",
        revealHandling: `Allow ${packet.revealBudget.reveal[0] ?? "one controlled reveal"} without leaking later information.`,
        exitCondition: `Land the ending hook target: ${packet.endingHookTarget}.`,
        emotionalArc: "From mounting pressure to a turn that reshapes understanding.",
        sensoryAnchor: "The environment itself becomes threatening — sound, light, or structure shifts.",
        dialogueStrategy: "Dialogue shortens under stress and begins hiding more than it reveals.",
      },
    ],
    mandatoryBeatCoverage: packet.mandatoryBeats.map((beat) => ({
      beat,
      deliveryPlan: `Integrate ${beat} through scene action and consequence.`,
    })),
    callbackPlan: packet.callbackObligations,
    revealControl: packet.revealBudget,
    continuityWatchouts: packet.continuityNotes,
    proseGuidance: [...packet.voiceGuidance, ...packet.pacingGuidance],
    endingBeat: packet.endingHookTarget,
  };
}

export function createSmokeSelfRedTeam(spec: ChapterSpec): SelfRedTeamReport {
  return {
    criticalIssues: [],
    weaknesses: spec.scenePlan.length < 2 ? ["Spec is too small for a full chapter."] : [],
    missingBeats: [],
    confidenceScore: 0.82,
    needsOpusEscalation: false,
    revisionActions: ["Tighten causal turns and keep the ending hook sharp."],
  };
}

export function createSmokeDraft(
  packet: ChapterPacket,
  spec: ChapterSpec,
  revised = false,
  literaryRetryAttempt = 0,
): ChapterDraft {
  const activeCast = packet.activeCast.map((character) => character.name).join(", ");
  const segments = [
    `${packet.title}`,
    "",
    `${packet.activeCast[0]?.name ?? "The protagonist"} entered the chapter already carrying the pressure forward. ${spec.openingImage}`,
    `The active cast in motion was ${activeCast}. The chapter pursued its central narrative obligation with controlled escalation.`,
    `First came ${packet.mandatoryBeats[0] ?? "the first required beat"}, rendered in concrete action instead of explanation.`,
    `Then ${packet.mandatoryBeats[1] ?? "the next pressure beat"} pushed the chapter into cost and consequence.`,
    revised
      ? (literaryRetryAttempt > 0 ? smokeRetryPassLine : smokeNearPassRevisionLine)
      : `The draft kept the movement clean, the reveal control disciplined, and the emotional turn legible.`,
    `The chapter closed on ${packet.endingHookTarget.toLowerCase()}, carrying forward ${packet.callbackObligations[0] ?? "the unresolved pressure"}.`,
  ];

  const n0 = packet.activeCast[0]?.name ?? "The protagonist";
  const n1 = packet.activeCast[1]?.name ?? "the secondary figure";
  const purpose = packet.purpose.toLowerCase();
  const hook = packet.endingHookTarget.toLowerCase();
  const fn = packet.chapterFunction.function;
  const beat0 = packet.mandatoryBeats[0] ?? "the central obligation";
  const beat1 = packet.mandatoryBeats[1] ?? "the secondary pressure";
  const withhold = packet.revealBudget.withhold[0] ?? "the deeper withheld truth";
  const callback = packet.callbackObligations[0] ?? purpose;

  const fillerPool = [
    `${n0} held position at the center of the exchange, reading the room through peripheral attention and controlled breathing. The weight of the chapter's central obligation settled into the architecture of every interaction, concrete and particular rather than abstract. No one moved toward the exit, because the exit demanded a concession that the moment had not yet earned.`,
    `${n1} shifted in response, and the shift communicated more than any direct statement could manage. The physical world remained stubbornly present — temperature, texture, the quality of light through the space — offering neither comfort nor easy exits. What was unsaid occupied the room like furniture, solid and unavoidable, demanding that each subsequent sentence navigate around it.`,
    `The scene honored its mandatory obligations without collapsing into summary. Every exchange reinforced the ending hook while preserving the withheld truth for later revelation. The causality stayed clean and traceable: action led to consequence, consequence demanded response, and the response loaded the next available turn with more weight than the previous one had carried.`,
    `Continuity pressure remained active through the chapter's unresolved callbacks. The prose stayed aligned with ${fn} logic, giving consequence room to land before the next turn arrived. The pacing refused to accelerate past the moments that required the reader's full attention, trusting stillness to carry as much narrative force as motion.`,
    `Time moved at the speed of consequence inside the scene. Each small action rippled into the next, tightening the causal chain until retreat was no longer available to anyone present. The architecture of the confrontation had its own momentum now, independent of any individual participant's willingness to sustain it.`,
    `${n0} catalogued the exits without turning, mapping the geometry of the space through peripheral awareness alone. Three viable paths, each with a specific cost. The calculation was automatic, instinctive — the kind of spatial intelligence that preceded conscious thought and operated on a timescale faster than language could follow.`,
    `The pacing honored the escalation pattern that the scene demanded, letting minor turns give way to the central reversal without losing the reader's spatial grounding or emotional orientation. Rhythm varied between compression and release: short blunt sentences for impact, longer constructions for the breathing room between blows.`,
    `Subtext carried weight through silence and deflection in every exchange. What was said mattered less than what was being carefully avoided, and what was being avoided pointed directly toward the chapter's final turn. The characters spoke around the truth rather than at it, each evasion tightening the spiral another quarter-turn.`,
    `Physical details anchored the emotional register throughout the scene with clinical precision. Cold surfaces, mechanical hum, filtered air — the environment was not decoration but diagnosis, reflecting the interior state of the confrontation in textures that the reader could feel without being told what to feel.`,
    `Each callback obligation earned itself through scene-level causality rather than exposition. No thread was resolved without cost, and no revelation arrived without adequate preparation. The prose trusted its own architecture to support the weight of the story's accumulated obligations without external scaffolding.`,
    `${n1} made a choice that could not be unmade, and the narrative registered it without commentary, trusting the weight of the action to speak entirely through its downstream consequences. The moment passed without fanfare — no dramatic pause, no swelling music — just the quiet click of a decision locking into place.`,
    `The rhythm shifted perceptibly when the conversation turned to what both participants were pretending not to discuss. Sentences shortened to their minimum viable length. Pauses lengthened until the silence itself became a form of speech. The room temperature dropped by a degree that only the characters could feel.`,
    `${n0} returned to the question that had started everything, but the question wore a different shape now because context had changed its meaning irreversibly. The answer that would have worked an hour ago had been foreclosed, and the only responses remaining demanded more honesty than either participant had budgeted for.`,
    `Every character carried their own specific gravity into the scene, generating the particular friction that made this confrontation irreplaceable. Their desires, fears, and contradictions were not labels affixed from the outside but engines running beneath the surface, producing the heat and pressure that kept the scene in motion.`,
    `The prose stayed anchored in the body of the POV character: what they perceived, what they felt, what they deliberately chose not to examine too closely. The world was filtered through a specific consciousness with specific blind spots, not narrated from an omniscient distance that would have flattened the tension.`,
    `${n0} understood something that could not be put back into its container. The knowledge sat in the body first — chest tight, jaw set, breath shallow — before the mind caught up with what instinct already recognized. Understanding arrived not as revelation but as confirmation of something the bones had known for several scenes.`,
    `The scene trusted its own silence at the critical juncture, refusing to fill the gap with narration. Not every beat required speech, and the absence of words created its own unique pressure — a pressure that would carry forward into the next movement of the story without being named or explained.`,
    `${n1} crossed a threshold that had been approaching for several scenes, though the crossing itself was quiet — no announcement, no grand declaration, just the nearly inaudible sound of a position becoming irreversible. The narrative structure registered the shift with precision even as the characters pretended nothing had changed.`,
    `Outside the immediate exchange, the world continued its own indifferent rotation. Traffic hummed at its own frequency, entirely uninterested in what happened behind these particular walls. The city did not pause for private turning points, and that indifference pressed against the glass like a reminder that the stakes here were local, specific, and therefore heavier than cosmic ones.`,
    `The chapter's forward motion derived from accumulation rather than detonation. No single moment carried the full weight; instead, the burden distributed itself across a dozen small turns, each one loading the next until the structure bent under its own gathered momentum and the next scene became not just possible but inevitable.`,
    `What ${n1} chose not to say occupied more narrative space than what was spoken aloud, because the omissions were architectural rather than decorative. Each deliberate silence shaped the next available action the way a retaining wall shapes water, not by opposing force directly but by channeling it into the only remaining path.`,
    `${n0} measured the distance between the question asked and the answer that eventually arrived, counting three full breaths in the interval. Inside that gap, the entire shape of the relationship rearranged itself without either participant acknowledging the tectonic shift happening beneath the surface of polite, controlled conversation.`,
    `Every sensory detail paid rent in the economy of attention the scene demanded. The cold metal of the handrail, the hum of fluorescent lighting, the particular quality of institutional air — each anchored the reader in the same physical reality pressing against the characters, grounding abstraction in the undeniable specificity of the body.`,
    `The prose refused to editorialize on what the scene had already shown through behavior and consequence. No internal monologue told the reader what to feel; instead, the accumulation of concrete detail built the emotional case from the ground up, one specific image at a time, trusting the reader's intelligence to draw the necessary conclusions.`,
    `${n0} traced the causal chain backward through the last five exchanges, looking for the exact moment when the conversation had stopped being about what it pretended to be about. The pivot point was invisible from the outside — unremarkable, even — but from this side of it, every subsequent word had been a different kind of sentence entirely.`,
    `The scene's emotional temperature operated on a gradient rather than a switch. There was no single dramatic turn; instead, the register shifted by fractions of a degree across each paragraph, the way a room cools when someone opens a window in an adjacent hallway — gradually, then all at once.`,
    `${n1} occupied the space with the particular stillness of someone who understood that any movement would be interpreted as a statement. Standing still was also a statement, but it was a quieter one, and in this specific negotiation, volume was a resource being carefully rationed by both parties.`,
    `The prose kept its metaphors tethered to the physical world of the scene rather than reaching for abstractions that would have pulled the reader out of the room. Every comparison pointed downward into concrete sensation — weight, temperature, texture, the specific quality of resistance that comes from pushing against something that will not move.`,
    `${n0} registered the change in air pressure that preceded ${n1}'s next statement — not literally, not physically, but in the way the silence acquired a particular density that announced itself as the prelude to something that could not be taken back once it entered the shared atmosphere of the room.`,
    `The ending approach of the scene gathered speed not through acceleration but through the systematic elimination of alternatives. One by one, the available paths closed, the possible responses narrowed, and the only remaining trajectory was the one neither participant had wanted but both had been building toward since the opening beat.`,
    `Every paragraph in the scene earned its continuation by advancing at least one element of the chapter's narrative machinery: a pressure tightened, a boundary tested, a piece of knowledge shifted from one column to another, a relationship recalibrated by a fraction that would compound over subsequent scenes into something irreversible.`,
    `The final beat landed with the restraint that the preceding buildup had earned. No emphasis was needed because the architecture of the scene had already done the work of making this moment inevitable. The prose simply reported what happened, trusted the structure, and let the silence that followed carry the full weight of implication.`,
  ];

  let fillerIdx = 0;
  while (countWords(segments.join("\n\n")) < packet.targetWordBand.min) {
    segments.push(fillerPool[fillerIdx % fillerPool.length]!);
    fillerIdx++;
  }

  const prose = segments.join("\n\n");

  return {
    prose,
    wordCount: countWords(prose),
  };
}

export function createSmokeReview(
  candidateId: "draft" | "revision",
  draft: ChapterDraft,
  passThreshold: number,
  weights: Record<string, number> = {},
): DraftReview {
  let base = candidateId === "revision" ? 87 : 82;
  if (candidateId === "revision" && draft.prose.includes(smokeNearPassRevisionLine)) {
    base = 84;
  } else if (candidateId === "revision" && draft.prose.includes(smokeRetryPassLine)) {
    base = 89;
  }
  const scoreBreakdown: ReviewScoreBreakdown = {
    beatCoverage: base,
    tension: base - 2,
    forwardMotion: base,
    characterTruth: base - 1,
    voiceConsistency: base - 1,
    specificity: base - 1,
    thematicEmbodiment: base - 2,
    openingPower: base,
    endingHookStrength: base,
    revealControl: base - 1,
    freshness: base - 2,
    repetitionPenalty: 10,
    proseQuality: base - 1,
    dialogueAuthenticity: base - 2,
    sensoryImmersion: base - 1,
  };
  const overallScore = calculateOverallScore(scoreBreakdown, weights);
  const review: DraftReview = {
    candidateId,
    overallScore,
    passesThreshold: false,
    scoreBreakdown,
    strengths: ["Clear causality", "Controlled reveal handling", "A sharp chapter-ending turn"],
    weaknesses: draft.wordCount < 120 ? ["Smoke prose is intentionally compact."] : [],
    blockingIssues: [],
    revisionActions: candidateId === "draft"
      ? ["Deepen subtext and sharpen the final turn."]
      : ["Minor polish only."],
    issues: [],
    summary: candidateId === "draft"
      ? "The smoke draft is structurally sound but leaves room for sharper prose."
      : "The smoke revision is slightly stronger on pressure and finish.",
  };
  review.passesThreshold = derivePassesThreshold(review, passThreshold);
  return review;
}

export function createSmokeSelection(draftReview: DraftReview, revisedReview: DraftReview, pairwiseTolerance: number): PairwiseSelection {
  const scoreDelta = revisedReview.overallScore - draftReview.overallScore;
  const withinTolerance = Math.abs(scoreDelta) <= pairwiseTolerance;
  return {
    presentedOrder: ["revision", "draft"],
    rawWinner: scoreDelta >= 0 ? "revision" : "draft",
    finalWinner: withinTolerance ? "draft" : scoreDelta >= 0 ? "revision" : "draft",
    scoreDelta,
    withinTolerance,
    rationale: withinTolerance
      ? "Scores are close, so the original draft stays by default."
      : "The revised smoke draft delivers a stronger ending turn.",
    preservedOriginal: withinTolerance,
  };
}

export function createSmokeSelectedChapter(
  draft: ChapterDraft,
  draftReview: DraftReview,
  revision: ChapterDraft,
  revisedReview: DraftReview,
  pairwiseTolerance: number,
): SelectedChapter {
  const selection = createSmokeSelection(draftReview, revisedReview, pairwiseTolerance);
  const winner = selection.finalWinner;
  const chosenDraft = winner === "draft" ? draft : revision;
  const chosenReview = winner === "draft" ? draftReview : revisedReview;

  return {
    winner,
    prose: chosenDraft.prose,
    wordCount: chosenDraft.wordCount,
    review: chosenReview,
    selection,
  };
}

export function createSmokeDelta(packet: ChapterPacket, selected: SelectedChapter): ChapterDelta {
  return {
    entityMentions: packet.activeCast.map((character) => ({
      name: character.name,
      role: character.role,
      introducedThisChapter: false,
      stateChanges: [`Appears inside the chapter's active pressure around ${packet.purpose}.`],
    })),
    sceneLedgerDelta: [
      {
        sceneNumber: 1,
        location: "Immediate story environment",
        summary: sentence(selected.prose.split("\n\n")[1] ?? selected.prose),
        causalTurn: "The chapter moves from setup to pressure.",
      },
      {
        sceneNumber: 2,
        location: "Escalated pressure point",
        summary: sentence(selected.prose.split("\n\n").slice(-2).join(" ")),
        causalTurn: "The ending hook shifts the story into the next chapter.",
      },
    ],
    knowledgeChanges: packet.activeCast.slice(0, 2).map((character) => ({
      holder: character.name,
      gainedKnowledge: `Learns a chapter-specific pressure related to ${packet.purpose}.`,
      suspects: [],
      hides: [],
      source: packet.title,
    })),
    irreversibleChanges: [`The story state now includes ${packet.endingHookTarget}.`],
    plotThreadProgression: packet.callbackObligations.map((thread) => ({
      thread,
      previousStatus: "active",
      newStatus: "advanced",
      update: `Advanced in ${packet.title}.`,
      resolved: false,
    })),
    revealPayoffMovement: [
      ...packet.revealBudget.hint.map((hint) => ({
        thread: hint,
        movementType: "hint" as const,
        description: hint,
        status: "seeded",
        chapterNumber: packet.chapterNumber,
      })),
      ...packet.revealBudget.reveal.map((reveal) => ({
        thread: reveal,
        movementType: "reveal" as const,
        description: reveal,
        status: "delivered",
        chapterNumber: packet.chapterNumber,
      })),
    ],
    activePressures: [`Pressure generated by ${packet.endingHookTarget}.`],
    unresolvedThreads: packet.callbackObligations.length > 0
      ? packet.callbackObligations
      : [packet.endingHookTarget],
    nextChapterOpeningHandoff: `Open immediately from the consequences of ${packet.endingHookTarget}.`,
    activeVoiceSignals: packet.activeCast.map((character) => ({
      character: character.name,
      voiceNotes: character.voiceNotes.slice(0, 2),
    })),
    storySpineUpdate: `The chapter advances the spine through ${packet.purpose}.`,
    characterEmotionalStates: packet.activeCast.map((character) => ({
      character: character.name,
      currentBelief: `Believes the pressure around ${packet.purpose} is real and requires action.`,
      currentDoubt: `Doubts whether their current approach to ${packet.purpose} will hold.`,
      emotionalRegister: "Watchful and pressured.",
      arcDistance: "Early — still operating from starting assumptions.",
    })),
  };
}

export function createSmokeHandoff(packet: ChapterPacket): HandoffMemory {
  return {
    openingSituation: `Continue from the immediate aftermath of ${packet.endingHookTarget}.`,
    physicalState: ["Characters remain inside the same active consequence chain."],
    emotionalState: ["Pressure remains elevated.", "No emotional reset is allowed."],
    causalState: [`The next chapter must honor ${packet.callbackObligations[0] ?? packet.endingHookTarget}.`],
    mandatoryCallbacks: packet.callbackObligations,
    characterStates: [],
  };
}

export function createSmokeMemory(
  packet: ChapterPacket,
  delta: ChapterDelta,
  previousMemory: RollingMemory | null,
): MemoryUpdateProposal {
  return {
    storySpine: previousMemory
      ? `${previousMemory.storySpine} Then ${delta.storySpineUpdate}`
      : delta.storySpineUpdate,
    unresolvedThreads: delta.unresolvedThreads,
    activePressures: delta.activePressures,
    knowledgeMatrix: packet.activeCast.map((character) => ({
      character: character.name,
      knows: delta.knowledgeChanges
        .filter((change) => change.holder === character.name)
        .map((change) => change.gainedKnowledge),
      suspects: [],
      hides: [],
      mustNotKnowYet: character.knowledgeBoundary ? [character.knowledgeBoundary] : [],
    })),
    activeCharacterVoiceCards: packet.activeCast.map((character) => ({
      character: character.name,
      activeTraits: character.voiceNotes.slice(0, 2),
      stressPattern: `Pressure increases around ${packet.purpose}.`,
      dialogueHabits: character.voiceNotes.slice(0, 2),
      tabooNotes: character.knowledgeBoundary ? [character.knowledgeBoundary] : [],
      updatedFromChapter: packet.chapterNumber,
    })),
    nextChapterOpeningHandoff: createSmokeHandoff(packet),
    compressedHistory: previousMemory
      ? [...previousMemory.compressedHistory, previousMemory.lastChapterSummary].slice(-config.defaults.olderHistoryEntries)
      : [],
    lastChapterSummary: `Chapter ${packet.chapterNumber} moved the story through ${packet.purpose}.`,
    emotionalStates: delta.characterEmotionalStates,
  };
}

export function createSmokeValidatorReport(): ValidatorReport {
  return {
    passed: true,
    issues: [],
    errorCount: 0,
    warningCount: 0,
  };
}

export function createSmokeAudit(validatorReport: ValidatorReport): FinalAuditReport {
  return {
    status: validatorReport.errorCount > 0 ? "issues_found" : "clean",
    summary: validatorReport.errorCount > 0
      ? "Smoke audit found deterministic validator failures."
      : "Smoke audit is clean.",
    factualConfidence: 0.92,
    requiresFix: validatorReport.errorCount > 0,
    issues: validatorReport.errorCount > 0
      ? [{
        severity: "error",
        title: "Deterministic validator failure",
        description: "A deterministic validator failed during smoke mode.",
        fixInstruction: "Resolve the validator failure and rerun the audit.",
      }]
      : [],
  };
}

export function createSmokePolishPlan(): PolishPlan {
  return {
    patches: [],
    notes: ["Smoke polish plan: no patches proposed; downstream consumes selected unchanged."],
  };
}

export function createSmokeReaderSimulation(selected: SelectedChapter): ReaderSimulation {
  const personas = READER_PERSONA_IDS.map((id) => ({
    persona: id,
    skimRisk: 30,
    confusionRisk: 25,
    turnPull: id === "airport" ? 78 : id === "book-club" ? 74 : 80,
    shareScore: id === "book-club" ? 76 : 72,
    notes: `Smoke ${id} review: pacing and pressure feel intentional.`,
  }));
  const firstParagraph = selected.prose.split(/\n\n+/)[1]?.trim().slice(0, 220)
    ?? selected.prose.slice(0, 220);
  const turnPullValues = personas.map((p) => p.turnPull);
  const shareValues = personas.map((p) => p.shareScore);
  const avg = (values: number[]) => Number((values.reduce((s, v) => s + v, 0) / values.length).toFixed(2));
  return {
    personas,
    flaggedPassages: [{ excerpt: firstParagraph, reason: "Smoke flag.", persona: "airport" }],
    averageTurnPull: avg(turnPullValues),
    averageShareScore: avg(shareValues),
    summary: "Smoke reader simulation: chapter holds momentum.",
  };
}

export function createSmokeTournamentResult(zone: TournamentZone): TournamentResult {
  return {
    zone,
    candidates: [],
    rounds: [],
    winnerId: "",
    winnerText: "",
    applied: false,
    skipReason: `Smoke tournament: ${zone} zone not run in smoke mode.`,
  };
}
