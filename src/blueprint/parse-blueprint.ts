import type {
  ChapterFunction,
  ChapterOutline,
  CharacterCard,
  ParsedStoryBlueprint,
} from "../types/index.js";
import {
  asList,
  asString,
  parseInteger,
  parseKeyValueList,
  parseStructuredFields,
  readText,
  sha256,
  splitSections,
  stripFrontmatter,
} from "../utils/index.js";

function extractBullets(block: string): string[] {
  return block
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*[-*]\s+(.+)$/)?.[1]?.trim() ?? "")
    .filter(Boolean);
}

function getSection(sections: Map<string, string>, title: string): string {
  return sections.get(title)?.trim() ?? "";
}

function parseCharacters(section: string): CharacterCard[] {
  const subsections = splitSections(section, 3);

  return Array.from(subsections.entries()).map(([heading, body]) => {
    const fields = parseStructuredFields(body);
    return {
      name: asString(fields.Name, heading),
      role: asString(fields.Role),
      desire: asString(fields.Desire),
      fear: asString(fields.Fear),
      contradiction: asString(fields.Contradiction),
      publicFace: asString(fields["Public Face"]),
      privateTruth: asString(fields["Private Truth"]),
      voiceNotes: asList(fields["Voice Notes"]),
      knowledgeBoundary: asString(fields["Knowledge Boundary"]),
      rawBody: body.trim(),
    };
  });
}

function parseChapterOutline(section: string, defaultWordCount: number): ChapterOutline[] {
  const subsections = splitSections(section, 3);

  return Array.from(subsections.entries()).map(([heading, body]) => {
    const chapterMatch = heading.match(/chapter\s+(\d+)/i);
    const fields = parseStructuredFields(body);
    const chapterNumber = Number.parseInt(chapterMatch?.[1] ?? "", 10);

    return {
      chapterNumber,
      title: asString(fields.Title, heading),
      function: asString(fields.Function).toLowerCase() as ChapterFunction,
      pov: asString(fields.POV),
      summary: asString(fields.Summary),
      chapterGoal: asString(fields["Chapter Goal"]),
      targetWordCount: parseInteger(fields["Target Word Count"], defaultWordCount),
      endingHook: asString(fields["Ending Hook"]),
      activeCast: asList(fields["Active Cast"]),
      mandatoryBeats: asList(fields["Mandatory Beats"]),
      callbackObligations: asList(fields["Callback Obligations"]),
      show: asList(fields.Show),
      hint: asList(fields.Hint),
      reveal: asList(fields.Reveal),
      withhold: asList(fields.Withhold),
      riskFlags: asList(fields["Risk Flags"]),
      notes: asList(fields.Notes),
    };
  });
}

export async function parseBlueprint(blueprintPath: string): Promise<ParsedStoryBlueprint> {
  const rawMarkdown = await readText(blueprintPath);
  const blueprintHash = sha256(rawMarkdown);
  const { frontmatter, body } = stripFrontmatter(rawMarkdown);
  const sections = splitSections(body, 2);

  const metadataFields = parseStructuredFields(getSection(sections, "Metadata"));
  const genreFields = parseStructuredFields(getSection(sections, "Genre Contract"));
  const storyPromiseFields = parseStructuredFields(getSection(sections, "Story Promise and Ending Promise"));
  const marketFields = parseStructuredFields(getSection(sections, "Market Positioning"));
  const styleFields = parseStructuredFields(getSection(sections, "Style Bible and Prose Rules"));
  const motifFields = parseStructuredFields(getSection(sections, "Motif/Symbol Bank and Imagery Palette"));
  const antiPatternFields = parseStructuredFields(getSection(sections, "Anti-Patterns and Genre Failure Modes"));

  const defaultWordCount = parseInteger(
    metadataFields["Default Chapter Word Count"],
    Number.parseInt(frontmatter.defaultChapterWordCount ?? "", 10) || 4000,
  );

  return {
    schemaVersion: "slice1.v1",
    blueprintHash,
    rawMarkdown,
    frontmatter,
    metadata: {
      title: asString(metadataFields.Title, frontmatter.title ?? ""),
      author: asString(metadataFields.Author, frontmatter.author ?? ""),
      blueprintVersion: asString(metadataFields["Blueprint Version"], frontmatter.version ?? "0.1.0"),
      totalChapters: parseInteger(
        metadataFields["Total Chapter Count"],
        Number.parseInt(frontmatter.totalChapters ?? "", 10) || 0,
      ),
      defaultChapterWordCount: defaultWordCount,
      defaultQualityProfile: (asString(
        metadataFields["Default Quality Profile"],
        "standard",
      ).toLowerCase() || "standard") as ParsedStoryBlueprint["metadata"]["defaultQualityProfile"],
    },
    storyPromise: {
      corePremise: asString(storyPromiseFields["Core Premise"]),
      storyPromise: asString(storyPromiseFields["Story Promise"]),
      readerPromise: asString(storyPromiseFields["Reader Promise"]),
      endingPromise: asString(storyPromiseFields["Ending Promise"]),
    },
    marketPositioning: {
      marketCategory: asString(marketFields["Market Category"]),
      audience: asString(marketFields.Audience),
      shelfPositioning: asString(marketFields["Shelf Positioning"]),
      comparables: asList(marketFields.Comparables),
    },
    genre: {
      primaryGenre: asString(genreFields["Primary Genre"]),
      subgenres: asList(genreFields.Subgenres),
      toneKeywords: asList(genreFields["Tone Keywords"]),
      readerExperience: asString(genreFields["Reader Experience"]),
      runtimeOverrides: parseKeyValueList(asList(genreFields["Runtime Overrides"])),
    },
    canonLaw: extractBullets(getSection(sections, "Canon Law and World Rules")),
    antiPatterns: (() => {
      const structured = asList(antiPatternFields["Banned Moves"]);
      return structured.length > 0 ? structured : extractBullets(getSection(sections, "Anti-Patterns and Genre Failure Modes"));
    })(),
    styleRules: (() => {
      const structured = asList(styleFields.Rules);
      return structured.length > 0 ? structured : extractBullets(getSection(sections, "Style Bible and Prose Rules"));
    })(),
    motifBank: (() => {
      const structured = asList(motifFields.Motifs);
      return structured.length > 0 ? structured : extractBullets(getSection(sections, "Motif/Symbol Bank and Imagery Palette"));
    })(),
    characters: parseCharacters(getSection(sections, "Character Architecture")),
    chapterOutline: parseChapterOutline(getSection(sections, "Chapter Outline"), defaultWordCount),
    rawSections: Object.fromEntries(sections.entries()),
  };
}
