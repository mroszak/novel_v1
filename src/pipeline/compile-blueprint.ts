import fs from "node:fs/promises";
import path from "node:path";

import { hasOpenAiCredentials } from "../api/openai.js";
import { config } from "../config.js";
import { compileAuthorBrief } from "../blueprint/compile-author-brief.js";
import { compileChapterFunctions } from "../blueprint/compile-chapter-functions.js";
import { compileContinuityManifest } from "../blueprint/compile-continuity-manifest.js";
import { compileGenreContract } from "../blueprint/compile-genre-contract.js";
import { compileLocations } from "../blueprint/compile-locations.js";
import { compileMarketPromise } from "../blueprint/compile-market-promise.js";
import { compileStoryCore } from "../blueprint/compile-story-core.js";
import { extractAndPersistVoiceTarget } from "../blueprint/extract-voice-fingerprint.js";
import { parseBlueprint } from "../blueprint/parse-blueprint.js";
import { validateBlueprint } from "../blueprint/validate-blueprint.js";
import { voiceTargetArtifactPath } from "./stage-utils.js";
import type {
  ArtifactEnvelope,
  AuthorBrief,
  BlueprintCompilationArtifacts,
  ChapterFunctionMap,
  CompiledStoryBlueprint,
  ContinuityManifest,
  GenreContract,
  Locations,
  MarketPromise,
  ParsedStoryBlueprint,
} from "../types/index.js";
import { fileExists, readJson, sha256, writeJson } from "../utils/index.js";

type BlueprintArtifactType =
  | "compiled-blueprint"
  | "genre-contract"
  | "chapter-functions"
  | "market-promise"
  | "continuity-manifest"
  | "locations"
  | "author-brief";

function createArtifact<T>(
  artifactType: BlueprintArtifactType,
  blueprint: ParsedStoryBlueprint,
  data: T,
): ArtifactEnvelope<T> {
  return {
    schemaVersion: config.artifactSchemaVersion,
    artifactType,
    createdAt: new Date().toISOString(),
    blueprintHash: blueprint.blueprintHash,
    blueprintVersion: blueprint.metadata.blueprintVersion,
    data,
  };
}

async function writeCanonicalArtifacts(artifacts: BlueprintCompilationArtifacts): Promise<void> {
  const canonicalTargets = {
    compiledBlueprint: path.join(config.paths.blueprintArtifacts, "compiled-blueprint.json"),
    genreContract: path.join(config.paths.blueprintArtifacts, "genre-contract.json"),
    chapterFunctions: path.join(config.paths.blueprintArtifacts, "chapter-functions.json"),
    marketPromise: path.join(config.paths.blueprintArtifacts, "market-promise.json"),
    continuityManifest: path.join(config.paths.blueprintArtifacts, "continuity-manifest.json"),
    locations: path.join(config.paths.blueprintArtifacts, "locations.json"),
    authorBrief: path.join(config.paths.blueprintArtifacts, "author-brief.json"),
  };

  await writeJson(canonicalTargets.compiledBlueprint, artifacts.compiledBlueprint);
  await writeJson(canonicalTargets.genreContract, artifacts.genreContract);
  await writeJson(canonicalTargets.chapterFunctions, artifacts.chapterFunctions);
  await writeJson(canonicalTargets.marketPromise, artifacts.marketPromise);
  await writeJson(canonicalTargets.continuityManifest, artifacts.continuityManifest);
  await writeJson(canonicalTargets.locations, artifacts.locations);
  await writeJson(canonicalTargets.authorBrief, artifacts.authorBrief);
}

async function writeCachedArtifacts(
  cacheDir: string,
  artifacts: BlueprintCompilationArtifacts,
): Promise<void> {
  await writeJson(path.join(cacheDir, "compiled-blueprint.json"), artifacts.compiledBlueprint);
  await writeJson(path.join(cacheDir, "genre-contract.json"), artifacts.genreContract);
  await writeJson(path.join(cacheDir, "chapter-functions.json"), artifacts.chapterFunctions);
  await writeJson(path.join(cacheDir, "market-promise.json"), artifacts.marketPromise);
  await writeJson(path.join(cacheDir, "continuity-manifest.json"), artifacts.continuityManifest);
  await writeJson(path.join(cacheDir, "locations.json"), artifacts.locations);
  await writeJson(path.join(cacheDir, "author-brief.json"), artifacts.authorBrief);
}

// Find the highest published chapter number on disk (chapter-N.md). Returns 0
// when no chapters are published. Used to seed the voice-target fingerprint
// at compile-blueprint time so chapter 1's voice-grit pass has a target.
async function findMaxPublishedChapter(): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(config.paths.chapters);
  } catch {
    return 0;
  }
  let max = 0;
  for (const name of entries) {
    const match = /^chapter-(\d+)\.md$/.exec(name);
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

// First-chapter voice-grit needs `voice-target.json` to exist BEFORE drafting
// (post-publish extraction is too late for chapter 1). When the artifact is
// absent, seed it deterministically: extract from any published chapters that
// happen to exist, otherwise fall back to the seed effectTics catalog inside
// extractAndPersistVoiceTarget. Existing voice-targets are left untouched so
// the live post-publish extraction continues to overwrite them per chapter.
async function ensureVoiceTargetSeeded(params: {
  blueprint: ParsedStoryBlueprint;
  compiledBlueprintData: CompiledStoryBlueprint;
}): Promise<void> {
  if (await fileExists(voiceTargetArtifactPath())) {
    return;
  }
  await extractAndPersistVoiceTarget({
    publishedThroughChapter: await findMaxPublishedChapter(),
    blueprint: params.compiledBlueprintData,
    blueprintHash: params.blueprint.blueprintHash,
    blueprintVersion: params.blueprint.metadata.blueprintVersion,
  });
}

function resolveGenreCompilationMode(noGenreAi: boolean): string {
  if (noGenreAi) {
    return "disabled";
  }

  return hasOpenAiCredentials()
    ? `openai:${config.stageProfiles.genreCompilation.model}`
    : "no-credentials";
}

function resolveBlueprintCacheDir(
  blueprint: ParsedStoryBlueprint,
  options: { noGenreAi: boolean },
): string {
  const cacheKey = sha256(JSON.stringify({
    blueprintHash: blueprint.blueprintHash,
    artifactSchemaVersion: config.artifactSchemaVersion,
    runtimeVersion: config.blueprintRuntimeCacheVersion,
    genreCompilationMode: resolveGenreCompilationMode(options.noGenreAi),
  }));

  return path.join(config.paths.blueprintCache, cacheKey);
}

function matchesCachedArtifact<T>(
  artifact: ArtifactEnvelope<T>,
  expectedType: BlueprintArtifactType,
  blueprint: ParsedStoryBlueprint,
): boolean {
  return artifact.schemaVersion === config.artifactSchemaVersion
    && artifact.artifactType === expectedType
    && artifact.blueprintHash === blueprint.blueprintHash
    && artifact.blueprintVersion === blueprint.metadata.blueprintVersion;
}

async function loadCachedArtifacts(
  cacheDir: string,
  blueprint: ParsedStoryBlueprint,
): Promise<BlueprintCompilationArtifacts | null> {
  const compiledBlueprintPath = path.join(cacheDir, "compiled-blueprint.json");
  const genreContractPath = path.join(cacheDir, "genre-contract.json");
  const chapterFunctionsPath = path.join(cacheDir, "chapter-functions.json");
  const marketPromisePath = path.join(cacheDir, "market-promise.json");
  const continuityManifestPath = path.join(cacheDir, "continuity-manifest.json");
  const locationsPath = path.join(cacheDir, "locations.json");
  const authorBriefPath = path.join(cacheDir, "author-brief.json");

  const allExist = await Promise.all([
    fileExists(compiledBlueprintPath),
    fileExists(genreContractPath),
    fileExists(chapterFunctionsPath),
    fileExists(marketPromisePath),
    fileExists(continuityManifestPath),
    fileExists(locationsPath),
    fileExists(authorBriefPath),
  ]);

  if (!allExist.every(Boolean)) {
    return null;
  }

  const artifacts = {
    compiledBlueprint: await readJson<ArtifactEnvelope<CompiledStoryBlueprint>>(compiledBlueprintPath),
    genreContract: await readJson<ArtifactEnvelope<GenreContract>>(genreContractPath),
    chapterFunctions: await readJson<ArtifactEnvelope<ChapterFunctionMap>>(chapterFunctionsPath),
    marketPromise: await readJson<ArtifactEnvelope<MarketPromise | null>>(marketPromisePath),
    continuityManifest: await readJson<ArtifactEnvelope<ContinuityManifest | null>>(continuityManifestPath),
    locations: await readJson<ArtifactEnvelope<Locations | null>>(locationsPath),
    authorBrief: await readJson<ArtifactEnvelope<AuthorBrief>>(authorBriefPath),
  };

  return matchesCachedArtifact(artifacts.compiledBlueprint, "compiled-blueprint", blueprint)
    && matchesCachedArtifact(artifacts.genreContract, "genre-contract", blueprint)
    && matchesCachedArtifact(artifacts.chapterFunctions, "chapter-functions", blueprint)
    && matchesCachedArtifact(artifacts.marketPromise, "market-promise", blueprint)
    && matchesCachedArtifact(artifacts.continuityManifest, "continuity-manifest", blueprint)
    && matchesCachedArtifact(artifacts.locations, "locations", blueprint)
    && matchesCachedArtifact(artifacts.authorBrief, "author-brief", blueprint)
    ? artifacts
    : null;
}

export async function compileBlueprintRuntime(options: {
  blueprintPath: string;
  noGenreAi: boolean;
}): Promise<{
  parsed: ParsedStoryBlueprint;
  artifacts: BlueprintCompilationArtifacts;
}> {
  const parsed = await parseBlueprint(options.blueprintPath);
  validateBlueprint(parsed);
  const cacheDir = resolveBlueprintCacheDir(parsed, options);

  const cachedArtifacts = await loadCachedArtifacts(cacheDir, parsed);
  if (cachedArtifacts) {
    await writeCanonicalArtifacts(cachedArtifacts);
    await ensureVoiceTargetSeeded({
      blueprint: parsed,
      compiledBlueprintData: cachedArtifacts.compiledBlueprint.data,
    });
    return {
      parsed,
      artifacts: cachedArtifacts,
    };
  }

  const compiledBlueprint = createArtifact(
    "compiled-blueprint",
    parsed,
    compileStoryCore(parsed),
  );
  const genreContract = createArtifact(
    "genre-contract",
    parsed,
    await compileGenreContract(parsed, { noGenreAi: options.noGenreAi }),
  );
  const chapterFunctions = createArtifact(
    "chapter-functions",
    parsed,
    compileChapterFunctions(parsed),
  );
  const marketPromise = createArtifact(
    "market-promise",
    parsed,
    compileMarketPromise(parsed),
  );
  const continuityManifest = createArtifact(
    "continuity-manifest",
    parsed,
    compileContinuityManifest(parsed),
  );
  const locations = createArtifact(
    "locations",
    parsed,
    compileLocations(parsed),
  );
  const authorBrief = createArtifact(
    "author-brief",
    parsed,
    await compileAuthorBrief(parsed, { noModel: options.noGenreAi }),
  );

  const artifacts: BlueprintCompilationArtifacts = {
    compiledBlueprint,
    genreContract,
    chapterFunctions,
    marketPromise,
    continuityManifest,
    locations,
    authorBrief,
  };

  await writeCachedArtifacts(cacheDir, artifacts);
  await writeCanonicalArtifacts(artifacts);
  await ensureVoiceTargetSeeded({
    blueprint: parsed,
    compiledBlueprintData: compiledBlueprint.data,
  });

  return {
    parsed,
    artifacts,
  };
}
