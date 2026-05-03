import { config } from "../config.js";
import { generateStructuredOutput, hasOpenAiCredentials } from "../api/openai.js";
import type { AuthorBrief, ParsedStoryBlueprint } from "../types/index.js";

const authorBriefSchema = {
  type: "object",
  properties: {
    authorialPersona: { type: "string", minLength: 1 },
    craftDirectives: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 6,
      maxItems: 10,
    },
  },
  required: ["authorialPersona", "craftDirectives"],
  additionalProperties: false,
} as const;

function buildDeterministicBrief(blueprint: ParsedStoryBlueprint): AuthorBrief {
  const promise = blueprint.marketPromise;
  const positioning = blueprint.marketPositioning;
  const genre = blueprint.genre;
  const persona = [
    `You are writing in the lineage of ${positioning.comparables.join(", ") || "the canon of " + genre.primaryGenre}.`,
    promise?.coreCommercialHook
      ? `The book's commercial hook is: ${promise.coreCommercialHook}`
      : `The book's core premise is: ${blueprint.storyPromise.corePremise}`,
    promise?.emotionalPromise
      ? `The reader is buying: ${promise.emotionalPromise}`
      : `The reader is buying: ${blueprint.storyPromise.readerPromise}`,
  ].filter(Boolean).join(" ");

  const directives: string[] = [];
  if (promise?.tropeStack?.length) {
    directives.push(`Honor these genre expectations directly: ${promise.tropeStack.join("; ")}.`);
  }
  if (promise?.freshnessAngle) {
    directives.push(`Differentiate from the comp shelf via: ${promise.freshnessAngle}.`);
  }
  if (promise?.pacingContract) {
    directives.push(`Pacing contract: ${promise.pacingContract}`);
  }
  if (blueprint.styleRules.length > 0) {
    directives.push(`Prose rules: ${blueprint.styleRules.slice(0, 4).join("; ")}.`);
  }
  if (blueprint.antiPatterns.length > 0) {
    directives.push(`Never: ${blueprint.antiPatterns.slice(0, 4).join("; ")}.`);
  }
  if (blueprint.motifBank.length > 0) {
    directives.push(`Recurring motifs: ${blueprint.motifBank.slice(0, 4).join("; ")}.`);
  }
  directives.push(`Match the literary register of: ${positioning.comparables.join(", ") || genre.primaryGenre}.`);
  while (directives.length < 6) {
    directives.push("Earn every emotional beat through action and consequence; never explain theme when behavior can carry it.");
  }

  return {
    authorialPersona: persona,
    craftDirectives: directives.slice(0, 10),
    source: "deterministic",
  };
}

export async function compileAuthorBrief(
  blueprint: ParsedStoryBlueprint,
  options: { noModel: boolean },
): Promise<AuthorBrief> {
  const fallback = buildDeterministicBrief(blueprint);
  if (options.noModel || !hasOpenAiCredentials()) {
    return fallback;
  }

  const promise = blueprint.marketPromise;
  const result = await generateStructuredOutput<{ authorialPersona: string; craftDirectives: string[] }>({
    stage: config.stageProfiles.authorBrief,
    instructions: [
      "You are a senior editor compiling the authorial persona for a chapter-by-chapter novel engine.",
      "Combine genre tradition (the comp shelf as craft examples) with the specific commercial promise of THIS book.",
      "Output a one-paragraph authorial-persona statement (3-6 sentences) and 6-10 craft directives.",
      "Each directive must be a specific, actionable craft instruction grounded in the comps + the commercial hook + the freshness angle.",
      "No platitudes. No marketing language. No 'AI thriller voice'.",
    ].join("\n"),
    prompt: [
      `Title: ${blueprint.metadata.title}`,
      `Primary genre: ${blueprint.genre.primaryGenre}`,
      `Subgenres: ${blueprint.genre.subgenres.join(", ") || "None"}`,
      `Tone keywords: ${blueprint.genre.toneKeywords.join(", ") || "None"}`,
      `Reader experience: ${blueprint.genre.readerExperience || "Not specified"}`,
      `Comparables (the comp shelf): ${blueprint.marketPositioning.comparables.join(", ") || "None"}`,
      `Market positioning: ${blueprint.marketPositioning.shelfPositioning || "Not specified"}`,
      promise ? `Core commercial hook: ${promise.coreCommercialHook}` : "Core commercial hook: not provided.",
      promise ? `Trope stack: ${promise.tropeStack.join("; ")}` : "Trope stack: not provided.",
      promise ? `Freshness angle: ${promise.freshnessAngle}` : "Freshness angle: not provided.",
      promise ? `Emotional promise: ${promise.emotionalPromise}` : `Emotional promise: ${blueprint.storyPromise.readerPromise}`,
      `Genre controls: ${JSON.stringify(blueprint.genre.runtimeOverrides)}`,
      `Style rules: ${blueprint.styleRules.join("; ") || "None"}`,
      `Anti-patterns: ${blueprint.antiPatterns.join("; ") || "None"}`,
      `Motif bank: ${blueprint.motifBank.join("; ") || "None"}`,
    ].join("\n\n"),
    schemaName: "author_brief",
    schema: authorBriefSchema,
  });

  return {
    authorialPersona: result.value.authorialPersona,
    craftDirectives: result.value.craftDirectives,
    source: "model",
  };
}
