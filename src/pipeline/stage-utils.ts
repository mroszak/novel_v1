import path from "node:path";

import { config } from "../config.js";
import type {
  ArtifactEnvelope,
  PipelineStatusArtifact,
  PipelineStatusCode,
  QualityProfile,
} from "../types/index.js";
import { readJson, writeJson, writeText } from "../utils/index.js";
export { countWords } from "../utils/index.js";

export class BlockedPipelineError extends Error {
  readonly code: PipelineStatusCode;
  readonly stage: string;
  readonly details: Record<string, unknown>;

  constructor(
    code: PipelineStatusCode,
    stage: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.code = code;
    this.stage = stage;
    this.details = details;
  }
}

type ArtifactExpectation = {
  artifactType?: string;
  blueprintHash?: string;
  blueprintVersion?: string;
  chapterNumber?: number;
  qualityProfile?: QualityProfile;
};

export function chapterArtifactPath(chapterNumber: number, suffix: string): string {
  return path.join(config.paths.chapterArtifacts, `chapter-${chapterNumber}-${suffix}.json`);
}

export function memoryArtifactPath(chapterNumber: number): string {
  return path.join(config.paths.memoryArtifacts, `after-chapter-${chapterNumber}.json`);
}

export function publishedChapterPath(chapterNumber: number): string {
  return path.join(config.paths.chapters, `chapter-${chapterNumber}.md`);
}

export function statusArtifactPath(chapterNumber: number): string {
  return chapterArtifactPath(chapterNumber, "status");
}

export function voiceTargetArtifactPath(): string {
  return path.join(config.paths.blueprintArtifacts, "voice-target.json");
}

export function styleSamplePath(): string {
  return path.join(config.rootDir, "STYLE_SAMPLE.md");
}

export function createArtifact<T>(params: {
  artifactType: string;
  blueprintHash: string;
  blueprintVersion: string;
  chapterNumber?: number;
  qualityProfile?: QualityProfile;
  data: T;
  usage?: ArtifactEnvelope<T>["usage"];
}): ArtifactEnvelope<T> {
  return {
    schemaVersion: config.artifactSchemaVersion,
    artifactType: params.artifactType,
    createdAt: new Date().toISOString(),
    blueprintHash: params.blueprintHash,
    blueprintVersion: params.blueprintVersion,
    chapterNumber: params.chapterNumber,
    qualityProfile: params.qualityProfile,
    usage: params.usage,
    data: params.data,
  };
}

function validateArtifact<T>(
  artifact: ArtifactEnvelope<T>,
  label: string,
  expected: ArtifactExpectation,
): void {
  if (artifact.schemaVersion !== config.artifactSchemaVersion) {
    throw new Error(
      `${label} at ${artifact.artifactType} uses schema ${artifact.schemaVersion}, expected ${config.artifactSchemaVersion}. Re-run from an earlier stage.`,
    );
  }

  const validations: Array<[keyof ArtifactExpectation, unknown]> = [
    ["artifactType", artifact.artifactType],
    ["blueprintHash", artifact.blueprintHash],
    ["blueprintVersion", artifact.blueprintVersion],
    ["chapterNumber", artifact.chapterNumber],
    ["qualityProfile", artifact.qualityProfile],
  ];

  for (const [field, actualValue] of validations) {
    const expectedValue = expected[field];
    if (expectedValue !== undefined && actualValue !== expectedValue) {
      throw new Error(
        `${label} metadata mismatch for ${field}. Expected ${String(expectedValue)}, received ${String(actualValue)}. Re-run from an earlier stage.`,
      );
    }
  }
}

export async function loadArtifact<T>(
  targetPath: string,
  label: string,
  expected: ArtifactExpectation = {},
): Promise<ArtifactEnvelope<T>> {
  let artifact: ArtifactEnvelope<T>;
  try {
    artifact = await readJson<ArtifactEnvelope<T>>(targetPath);
  } catch {
    throw new Error(`${label} not found at ${targetPath}. Generate the earlier stage first.`);
  }

  validateArtifact(artifact, label, expected);
  return artifact;
}

export async function writeStatusArtifact(params: {
  chapterNumber: number;
  blueprintHash: string;
  blueprintVersion: string;
  qualityProfile: QualityProfile;
  status: PipelineStatusCode;
  stage: string;
  message: string;
  details?: Record<string, unknown>;
}): Promise<string> {
  const artifact = createArtifact<PipelineStatusArtifact>({
    artifactType: "chapter-status",
    blueprintHash: params.blueprintHash,
    blueprintVersion: params.blueprintVersion,
    chapterNumber: params.chapterNumber,
    qualityProfile: params.qualityProfile,
    data: {
      status: params.status,
      stage: params.stage,
      message: params.message,
      details: params.details ?? {},
    },
  });

  const targetPath = statusArtifactPath(params.chapterNumber);
  await writeJson(targetPath, artifact);
  return targetPath;
}

export async function publishChapter(chapterNumber: number, prose: string): Promise<string> {
  const targetPath = publishedChapterPath(chapterNumber);
  await writeText(targetPath, prose);
  return targetPath;
}
