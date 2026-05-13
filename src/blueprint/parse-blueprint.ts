import type {
  ChapterFunction,
  ChapterOutline,
  ChapterRetentionFunction,
  CharacterCard,
  ContinuityManifest,
  LocationEntry,
  Locations,
  MarketPromise,
  MotifStage,
  MotifState,
  ParsedStoryBlueprint,
  PersistentObject,
  RelationshipState,
  RevealEntry,
  RevealMode,
  SpatialNode,
  TimelineAnchor,
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

function parseSurnameAlias(raw: string): boolean | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "yes") return true;
  return undefined;
}

function parseCharacters(section: string): CharacterCard[] {
  const subsections = splitSections(section, 3);

  return Array.from(subsections.entries()).map(([heading, body]) => {
    const fields = parseStructuredFields(body);
    const surnameAlias = parseSurnameAlias(asString(fields["Surname Alias"]));
    const noticingEngine = asString(fields["Noticing Engine"]);
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
      ...(noticingEngine ? { noticingEngine } : {}),
      ...(surnameAlias ? { surnameAlias } : {}),
      rawBody: body.trim(),
    };
  });
}

const RETENTION_FUNCTIONS = new Set<ChapterRetentionFunction>([
  "opening",
  "early-escalation",
  "midpoint",
  "late-escalation",
  "climax",
  "aftermath",
]);

const REVEAL_MODES = new Set<RevealMode>(["show", "hint", "reveal", "payoff"]);

const MOTIF_STAGES = new Set<MotifStage>([
  "introduced",
  "recurring",
  "inverted",
  "paid-off",
]);

function pipeFields(line: string): string[] {
  return line.split("|").map((part) => part.trim());
}

function parseMarketPromise(section: string): MarketPromise | null {
  if (!section.trim()) return null;
  const fields = parseStructuredFields(section);

  const retentionRaw = asList(fields["Chapter-Level Retention Strategy"]);
  const chapterRetentionStrategy: MarketPromise["chapterRetentionStrategy"] = retentionRaw
    .map((line) => {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) return null;
      const fnRaw = line.slice(0, colonIdx).trim().toLowerCase() as ChapterRetentionFunction;
      const job = line.slice(colonIdx + 1).trim();
      if (!RETENTION_FUNCTIONS.has(fnRaw) || !job) return null;
      return { chapterFunction: fnRaw, readerJob: job };
    })
    .filter((entry): entry is { chapterFunction: ChapterRetentionFunction; readerJob: string } => entry !== null);

  const promise: MarketPromise = {
    readerAvatar: asString(fields["Reader Avatar"]),
    shelfComps: asList(fields["Shelf / Comps"]),
    coreCommercialHook: asString(fields["Core Commercial Hook"]),
    tropeStack: asList(fields["Trope Stack"]),
    freshnessAngle: asString(fields["Freshness Angle"]),
    pacingContract: asString(fields["Pacing Contract"]),
    emotionalPromise: asString(fields["Emotional Promise"]),
    coverBlurbKeywords: asList(fields["Cover/Blurb Keywords"]),
    seriesPotential: asString(fields["Series Potential"]),
    chapterRetentionStrategy,
  };

  const hasContent = promise.readerAvatar
    || promise.coreCommercialHook
    || promise.shelfComps.length > 0
    || promise.tropeStack.length > 0
    || promise.freshnessAngle
    || promise.pacingContract
    || promise.emotionalPromise
    || promise.coverBlurbKeywords.length > 0
    || promise.seriesPotential
    || promise.chapterRetentionStrategy.length > 0;

  return hasContent ? promise : null;
}

function parseContinuityManifest(section: string): ContinuityManifest | null {
  if (!section.trim()) return null;
  const subsections = splitSections(section, 3);

  const persistentObjects: PersistentObject[] = extractBullets(subsections.get("Persistent Objects") ?? "")
    .map((line) => {
      const parts = pipeFields(line);
      if (parts.length < 4) return null;
      const lastSeen = Number.parseInt(parts[3] ?? "", 10);
      return {
        name: parts[0] ?? "",
        state: parts[1] ?? "",
        possessor: parts[2] ?? "",
        lastSeenChapter: Number.isFinite(lastSeen) ? lastSeen : 0,
      };
    })
    .filter((entry): entry is PersistentObject => entry !== null && Boolean(entry.name));

  const spatialRegistry: SpatialNode[] = extractBullets(subsections.get("Spatial Registry") ?? "")
    .map((line) => {
      const parts = pipeFields(line);
      if (parts.length < 4) return null;
      return {
        name: parts[0] ?? "",
        description: parts[1] ?? "",
        access: parts[2] ?? "",
        condition: parts[3] ?? "",
      };
    })
    .filter((entry): entry is SpatialNode => entry !== null && Boolean(entry.name));

  const timelineAnchors: TimelineAnchor[] = extractBullets(subsections.get("Timeline Anchors") ?? "")
    .map((line) => {
      const parts = pipeFields(line);
      if (parts.length < 3) return null;
      return {
        label: parts[0] ?? "",
        description: parts[1] ?? "",
        offset: parts[2] ?? "",
      };
    })
    .filter((entry): entry is TimelineAnchor => entry !== null && Boolean(entry.label));

  const revealSchedule: RevealEntry[] = extractBullets(subsections.get("Reveal Schedule") ?? "")
    .map((line) => {
      const parts = pipeFields(line);
      if (parts.length < 4) return null;
      const chapter = Number.parseInt(parts[2] ?? "", 10);
      const mode = (parts[3] ?? "").toLowerCase() as RevealMode;
      if (!REVEAL_MODES.has(mode)) return null;
      return {
        thread: parts[0] ?? "",
        learner: parts[1] ?? "",
        chapter: Number.isFinite(chapter) ? chapter : 0,
        mode,
      };
    })
    .filter((entry): entry is RevealEntry => entry !== null && Boolean(entry.thread));

  const relationshipStates: RelationshipState[] = extractBullets(subsections.get("Relationship States") ?? "")
    .map((line) => {
      const parts = pipeFields(line);
      if (parts.length < 5) return null;
      return {
        pair: parts[0] ?? "",
        trust: parts[1] ?? "",
        distance: parts[2] ?? "",
        dependency: parts[3] ?? "",
        rivalry: parts[4] ?? "",
      };
    })
    .filter((entry): entry is RelationshipState => entry !== null && Boolean(entry.pair));

  const motifStates: MotifState[] = extractBullets(subsections.get("Motif States") ?? "")
    .map((line) => {
      const parts = pipeFields(line);
      if (parts.length < 4) return null;
      const lastChapter = Number.parseInt(parts[2] ?? "", 10);
      const stage = (parts[3] ?? "").toLowerCase() as MotifStage;
      if (!MOTIF_STAGES.has(stage)) return null;
      return {
        motif: parts[0] ?? "",
        intensity: parts[1] ?? "",
        lastChapter: Number.isFinite(lastChapter) ? lastChapter : 0,
        stage,
      };
    })
    .filter((entry): entry is MotifState => entry !== null && Boolean(entry.motif));

  const manifest: ContinuityManifest = {
    persistentObjects,
    spatialRegistry,
    timelineAnchors,
    revealSchedule,
    relationshipStates,
    motifStates,
  };

  const hasContent = persistentObjects.length > 0
    || spatialRegistry.length > 0
    || timelineAnchors.length > 0
    || revealSchedule.length > 0
    || relationshipStates.length > 0
    || motifStates.length > 0;

  return hasContent ? manifest : null;
}

function parseLocations(section: string): Locations | null {
  if (!section.trim()) return null;

  const entries: LocationEntry[] = extractBullets(section)
    .map((line) => {
      const parts = pipeFields(line);
      if (parts.length < 3) return null;
      const name = parts[0] ?? "";
      const type = parts[1] ?? "";
      const description = parts[2] ?? "";
      const aliasField = parts[3] ?? "";
      const aliases = aliasField
        .split(",")
        .map((alias) => alias.trim())
        .filter(Boolean);
      if (!name) return null;
      return { name, type, description, aliases };
    })
    .filter((entry): entry is LocationEntry => entry !== null);

  return entries.length > 0 ? { entries } : null;
}

function parseOptionalPositiveInteger(raw: string): number | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseChapterOutline(section: string, defaultWordCount: number): ChapterOutline[] {
  const subsections = splitSections(section, 3);

  return Array.from(subsections.entries()).map(([heading, body]) => {
    const chapterMatch = heading.match(/chapter\s+(\d+)/i);
    const fields = parseStructuredFields(body);
    const chapterNumber = Number.parseInt(chapterMatch?.[1] ?? "", 10);
    const namedCharacterCap = parseOptionalPositiveInteger(asString(fields["Named Character Cap"]));

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
      secondaryCameoBeats: asList(fields["Secondary Cameo Beats"]),
      callbackObligations: asList(fields["Callback Obligations"]),
      show: asList(fields.Show),
      hint: asList(fields.Hint),
      reveal: asList(fields.Reveal),
      withhold: asList(fields.Withhold),
      riskFlags: asList(fields["Risk Flags"]),
      notes: asList(fields.Notes),
      ...(namedCharacterCap !== undefined ? { namedCharacterCap } : {}),
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
    marketPromise: parseMarketPromise(getSection(sections, "Market Promise")),
    genre: {
      primaryGenre: asString(genreFields["Primary Genre"]),
      subgenres: asList(genreFields.Subgenres),
      toneKeywords: asList(genreFields["Tone Keywords"]),
      readerExperience: asString(genreFields["Reader Experience"]),
      runtimeOverrides: parseKeyValueList(asList(genreFields["Runtime Overrides"])),
    },
    continuityManifest: parseContinuityManifest(getSection(sections, "Continuity Manifest")),
    locations: parseLocations(getSection(sections, "Locations")),
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
