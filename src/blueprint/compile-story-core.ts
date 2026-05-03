import type { CompiledStoryBlueprint, ParsedStoryBlueprint } from "../types/index.js";
import { summarizeText } from "../utils/index.js";

const DIGEST_SECTIONS = [
  "Tonal Contract and Reader Experience",
  "Relationship Dynamics",
  "Belief Arcs and Internal Contradictions",
  "Knowledge Boundaries and Reveal Timing",
  "Act Spine and Chapter-by-Chapter Obligations",
  "Setup/Payoff Map and Ghost-Thread Map",
] as const;

export function compileStoryCore(blueprint: ParsedStoryBlueprint): CompiledStoryBlueprint {
  const sectionDigests = Object.fromEntries(
    DIGEST_SECTIONS.map((section) => [
      section,
      summarizeText(blueprint.rawSections[section] ?? "", 500),
    ]),
  );

  return {
    metadata: blueprint.metadata,
    storyPromise: blueprint.storyPromise,
    marketPositioning: blueprint.marketPositioning,
    genre: blueprint.genre,
    canonLaw: blueprint.canonLaw,
    antiPatterns: blueprint.antiPatterns,
    styleRules: blueprint.styleRules,
    motifBank: blueprint.motifBank,
    characters: blueprint.characters,
    chapterOutline: blueprint.chapterOutline,
    sectionDigests,
  };
}
