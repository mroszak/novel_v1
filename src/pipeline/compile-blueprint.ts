import path from "node:path";

import { hasOpenAiCredentials } from "../api/openai.js";
import { config } from "../config.js";
import { compileChapterFunctions } from "../blueprint/compile-chapter-functions.js";
import { compileContinuityManifest } from "../blueprint/compile-continuity-manifest.js";
import { compileGenreContract } from "../blueprint/compile-genre-contract.js";
import { compileMarketPromise } from "../blueprint/compile-market-promise.js";
import { compileStoryCore } from "../blueprint/compile-story-core.js";
import { parseBlueprint } from "../blueprint/parse-blueprint.js";
import { validateBlueprint } from "../blueprint/validate-blueprint.js";
import type {
  ArtifactEnvelope,
  BlueprintCompilationArtifacts,
  ChapterFunctionMap,
  CompiledStoryBlueprint,
  ContinuityManifest,
  GenreContract,
  MarketPromise,
  ParsedStoryBlueprint,
} from "../types/index.js";
import { fileExists, readJson, sha256, writeJson } from "../utils/index.js";

type BlueprintArtifactType =
  | "compiled-blueprint"
  | "genre-contract"
  | "chapter-functions"
  | "market-promise"
  | "continuity-manifest";

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
  };

  await writeJson(canonicalTargets.compiledBlueprint, artifacts.compiledBlueprint);
  await writeJson(canonicalTargets.genreContract, artifacts.genreContract);
  await writeJson(canonicalTargets.chapterFunctions, artifacts.chapterFunctions);
  await writeJson(canonicalTargets.marketPromise, artifacts.marketPromise);
  await writeJson(canonicalTargets.continuityManifest, artifacts.continuityManifest);
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

  const allExist = await Promise.all([
    fileExists(compiledBlueprintPath),
    fileExists(genreContractPath),
    fileExists(chapterFunctionsPath),
    fileExists(marketPromisePath),
    fileExists(continuityManifestPath),
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
  };

  return matchesCachedArtifact(artifacts.compiledBlueprint, "compiled-blueprint", blueprint)
    && matchesCachedArtifact(artifacts.genreContract, "genre-contract", blueprint)
    && matchesCachedArtifact(artifacts.chapterFunctions, "chapter-functions", blueprint)
    && matchesCachedArtifact(artifacts.marketPromise, "market-promise", blueprint)
    && matchesCachedArtifact(artifacts.continuityManifest, "continuity-manifest", blueprint)
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

  const artifacts: BlueprintCompilationArtifacts = {
    compiledBlueprint,
    genreContract,
    chapterFunctions,
    marketPromise,
    continuityManifest,
  };

  await writeCachedArtifacts(cacheDir, artifacts);
  await writeCanonicalArtifacts(artifacts);

  return {
    parsed,
    artifacts,
  };
}
