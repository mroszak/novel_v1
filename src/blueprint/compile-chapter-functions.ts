import type {
  ChapterFunction,
  ChapterFunctionMap,
  ChapterFunctionProfile,
  ParsedStoryBlueprint,
} from "../types/index.js";

const FUNCTION_PRESETS: Record<ChapterFunction, ChapterFunctionProfile> = {
  opening: {
    function: "opening",
    riskLevel: "high",
    pacingDirective: "Establish story pressure fast while withholding deeper architecture.",
    judgeWeights: {
      openingPower: 1.35,
      tension: 1.1,
      voiceConsistency: 1.15,
      endingHookStrength: 1.1,
    },
  },
  escalation: {
    function: "escalation",
    riskLevel: "medium",
    pacingDirective: "Escalate pressure through consequence, not noise.",
    judgeWeights: {
      tension: 1.25,
      forwardMotion: 1.2,
      characterTruth: 1.0,
      endingHookStrength: 1.0,
    },
  },
  reveal: {
    function: "reveal",
    riskLevel: "high",
    pacingDirective: "Deliver new truth with irreversible emotional consequence.",
    judgeWeights: {
      revealControl: 1.35,
      specificity: 1.1,
      characterTruth: 1.1,
      endingHookStrength: 1.05,
    },
  },
  aftermath: {
    function: "aftermath",
    riskLevel: "medium",
    pacingDirective: "Let consequence land before plotting the next turn.",
    judgeWeights: {
      thematicEmbodiment: 1.2,
      characterTruth: 1.2,
      tension: 0.9,
      voiceConsistency: 1.1,
    },
  },
  midpoint: {
    function: "midpoint",
    riskLevel: "high",
    pacingDirective: "Shift the story's axis with a visible new cost.",
    judgeWeights: {
      forwardMotion: 1.2,
      revealControl: 1.15,
      endingHookStrength: 1.1,
      thematicEmbodiment: 1.0,
    },
  },
  reversal: {
    function: "reversal",
    riskLevel: "high",
    pacingDirective: "Turn existing assumptions against the cast with clarity and force.",
    judgeWeights: {
      tension: 1.3,
      revealControl: 1.2,
      characterTruth: 1.05,
      endingHookStrength: 1.1,
    },
  },
  climax: {
    function: "climax",
    riskLevel: "high",
    pacingDirective: "Cash out the story's central pressure in irreversible action.",
    judgeWeights: {
      forwardMotion: 1.35,
      thematicEmbodiment: 1.15,
      characterTruth: 1.15,
      endingHookStrength: 0.9,
    },
  },
  resolution: {
    function: "resolution",
    riskLevel: "medium",
    pacingDirective: "Resolve the main pressure while preserving the ending promise.",
    judgeWeights: {
      thematicEmbodiment: 1.3,
      characterTruth: 1.1,
      freshness: 1.0,
      endingHookStrength: 0.75,
    },
  },
};

export function compileChapterFunctions(blueprint: ParsedStoryBlueprint): ChapterFunctionMap {
  return {
    chapterProfiles: blueprint.chapterOutline.map((chapter) => ({
      chapterNumber: chapter.chapterNumber,
      title: chapter.title,
      function: chapter.function,
      profile: FUNCTION_PRESETS[chapter.function],
    })),
  };
}
