import type {
  ChapterDelta,
  HandoffMemory,
  MemoryUpdateProposal,
} from "../types/index.js";

export function buildHandoff(
  proposal: MemoryUpdateProposal,
  delta: ChapterDelta,
): HandoffMemory {
  const characterStates = [...proposal.nextChapterOpeningHandoff.characterStates]
    .sort((a, b) => a.character.localeCompare(b.character));

  const physicalState = characterStates.length > 0
    ? characterStates.map((s) => `${s.character}: ${s.physicalState}`)
    : proposal.nextChapterOpeningHandoff.physicalState.length > 0
      ? proposal.nextChapterOpeningHandoff.physicalState
      : ["Carry forward the physical aftermath without resetting the scene state."];

  const emotionalState = characterStates.length > 0
    ? characterStates.map((s) => `${s.character}: ${s.emotionalState}`)
    : proposal.nextChapterOpeningHandoff.emotionalState.length > 0
      ? proposal.nextChapterOpeningHandoff.emotionalState
      : ["No emotional reset."];

  return {
    openingSituation: proposal.nextChapterOpeningHandoff.openingSituation || delta.nextChapterOpeningHandoff,
    physicalState,
    emotionalState,
    causalState: proposal.nextChapterOpeningHandoff.causalState.length > 0
      ? proposal.nextChapterOpeningHandoff.causalState
      : [`Open from ${delta.nextChapterOpeningHandoff}.`],
    mandatoryCallbacks: proposal.nextChapterOpeningHandoff.mandatoryCallbacks.length > 0
      ? proposal.nextChapterOpeningHandoff.mandatoryCallbacks
      : delta.plotThreadProgression.filter((thread) => !thread.resolved).map((thread) => thread.thread),
    characterStates,
  };
}
