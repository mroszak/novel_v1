import {
  CHAPTER_FUNCTIONS,
  QUALITY_PROFILES,
  type ParsedStoryBlueprint,
} from "../types/index.js";

const REQUIRED_SECTIONS = [
  "Metadata",
  "Story Promise and Ending Promise",
  "Market Positioning",
  "Genre Contract",
  "Tonal Contract and Reader Experience",
  "Canon Law and World Rules",
  "Character Architecture",
  "Relationship Dynamics",
  "Belief Arcs and Internal Contradictions",
  "Knowledge Boundaries and Reveal Timing",
  "Act Spine and Chapter-by-Chapter Obligations",
  "Setup/Payoff Map and Ghost-Thread Map",
  "Style Bible and Prose Rules",
  "Motif/Symbol Bank and Imagery Palette",
  "Anti-Patterns and Genre Failure Modes",
  "Chapter Outline",
] as const;

const PLACEHOLDER_PATTERN = /replace with|comparable 1|author name|working title|subgenre 1|protagonist name/i;

function looksLikePlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERN.test(value);
}

export function validateBlueprint(blueprint: ParsedStoryBlueprint): void {
  const errors: string[] = [];
  const knownCharacters = new Set(
    blueprint.characters.map((character) => character.name.trim().toLowerCase()),
  );

  for (const section of REQUIRED_SECTIONS) {
    if (!blueprint.rawSections[section]?.trim()) {
      errors.push(`Missing required section: ${section}`);
    }
  }

  if (!blueprint.metadata.title) {
    errors.push("Metadata.Title is required.");
  }

  if (!blueprint.metadata.author) {
    errors.push("Metadata.Author is required.");
  }

  if (!blueprint.metadata.blueprintVersion) {
    errors.push("Metadata.Blueprint Version is required.");
  }

  if (!QUALITY_PROFILES.includes(blueprint.metadata.defaultQualityProfile)) {
    errors.push(`Metadata.Default Quality Profile must be one of: ${QUALITY_PROFILES.join(", ")}.`);
  }

  if (!Number.isInteger(blueprint.metadata.totalChapters) || blueprint.metadata.totalChapters < 1) {
    errors.push("Metadata.Total Chapter Count must be a positive integer.");
  }

  if (!Number.isInteger(blueprint.metadata.defaultChapterWordCount) || blueprint.metadata.defaultChapterWordCount < 1500) {
    errors.push("Metadata.Default Chapter Word Count must be at least 1500.");
  }

  if (!blueprint.storyPromise.corePremise) {
    errors.push("Story Promise and Ending Promise.Core Premise is required.");
  } else if (looksLikePlaceholder(blueprint.storyPromise.corePremise)) {
    errors.push("Story Promise and Ending Promise.Core Premise still contains placeholder text.");
  }

  if (!blueprint.storyPromise.storyPromise) {
    errors.push("Story Promise and Ending Promise.Story Promise is required.");
  } else if (looksLikePlaceholder(blueprint.storyPromise.storyPromise)) {
    errors.push("Story Promise and Ending Promise.Story Promise still contains placeholder text.");
  }

  if (!blueprint.storyPromise.endingPromise) {
    errors.push("Story Promise and Ending Promise.Ending Promise is required.");
  } else if (looksLikePlaceholder(blueprint.storyPromise.endingPromise)) {
    errors.push("Story Promise and Ending Promise.Ending Promise still contains placeholder text.");
  }

  if (!blueprint.genre.primaryGenre) {
    errors.push("Genre Contract.Primary Genre is required.");
  } else if (looksLikePlaceholder(blueprint.genre.primaryGenre)) {
    errors.push("Genre Contract.Primary Genre still contains placeholder text.");
  }

  if (blueprint.characters.length === 0) {
    errors.push("Character Architecture must define at least one character.");
  }

  if (blueprint.chapterOutline.length === 0) {
    errors.push("Chapter Outline must define at least one chapter.");
  }

  const chapterNumbers = blueprint.chapterOutline.map((chapter) => chapter.chapterNumber);
  const sequentialNumbers = Array.from({ length: chapterNumbers.length }, (_, index) => index + 1);
  if (chapterNumbers.some((number, index) => number !== sequentialNumbers[index])) {
    errors.push("Chapter Outline headings must be sequential `### Chapter N` entries starting at 1.");
  }

  if (
    blueprint.metadata.totalChapters > 0 &&
    blueprint.chapterOutline.length !== blueprint.metadata.totalChapters
  ) {
    errors.push(
      `Metadata.Total Chapter Count (${blueprint.metadata.totalChapters}) does not match Chapter Outline count (${blueprint.chapterOutline.length}).`,
    );
  }

  for (const chapter of blueprint.chapterOutline) {
    if (!chapter.title) {
      errors.push(`Chapter ${chapter.chapterNumber}: Title is required.`);
    } else if (looksLikePlaceholder(chapter.title)) {
      errors.push(`Chapter ${chapter.chapterNumber}: Title still contains placeholder text.`);
    }

    if (!CHAPTER_FUNCTIONS.includes(chapter.function)) {
      errors.push(
        `Chapter ${chapter.chapterNumber}: Function must be one of ${CHAPTER_FUNCTIONS.join(", ")}.`,
      );
    }

    if (!chapter.summary) {
      errors.push(`Chapter ${chapter.chapterNumber}: Summary is required.`);
    } else if (looksLikePlaceholder(chapter.summary)) {
      errors.push(`Chapter ${chapter.chapterNumber}: Summary still contains placeholder text.`);
    }

    if (!chapter.chapterGoal) {
      errors.push(`Chapter ${chapter.chapterNumber}: Chapter Goal is required.`);
    } else if (looksLikePlaceholder(chapter.chapterGoal)) {
      errors.push(`Chapter ${chapter.chapterNumber}: Chapter Goal still contains placeholder text.`);
    }

    if (!chapter.endingHook) {
      errors.push(`Chapter ${chapter.chapterNumber}: Ending Hook is required.`);
    } else if (looksLikePlaceholder(chapter.endingHook)) {
      errors.push(`Chapter ${chapter.chapterNumber}: Ending Hook still contains placeholder text.`);
    }

    if (chapter.targetWordCount < 1500) {
      errors.push(`Chapter ${chapter.chapterNumber}: Target Word Count must be at least 1500.`);
    }

    if (chapter.activeCast.length === 0) {
      errors.push(`Chapter ${chapter.chapterNumber}: Active Cast must include at least one character.`);
    } else {
      for (const activeCastName of chapter.activeCast) {
        if (!knownCharacters.has(activeCastName.trim().toLowerCase())) {
          errors.push(
            `Chapter ${chapter.chapterNumber}: Active Cast references unknown character "${activeCastName}".`,
          );
        }
      }
    }

    if (chapter.mandatoryBeats.length === 0) {
      errors.push(`Chapter ${chapter.chapterNumber}: Mandatory Beats cannot be empty.`);
    } else if (chapter.mandatoryBeats.some(looksLikePlaceholder)) {
      errors.push(`Chapter ${chapter.chapterNumber}: Mandatory Beats still contain placeholder text.`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Blueprint validation failed:\n- ${errors.join("\n- ")}`);
  }
}
