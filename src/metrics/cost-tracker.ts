import path from "node:path";

import { config, type ModelPricingProfile, type StageProfileBase } from "../config.js";
import type {
  ArtifactEnvelope,
  ChapterCostEstimate,
  ChapterCostSummary,
  StageTokenEstimate,
  StageTelemetry,
  StageUsage,
  TokenPreflight,
} from "../types/index.js";
import { writeJson } from "../utils/index.js";

function resolvePricing(model: string): ModelPricingProfile {
  return config.pricing[model] ?? {
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    configured: false,
  };
}

function computeCostUsd(params: {
  model: string;
  inputTokens: number;
  outputTokens: number;
}): number | null {
  const pricing = resolvePricing(params.model);
  if (!pricing.configured) {
    return null;
  }

  const inputCost = (params.inputTokens / 1_000_000) * pricing.inputCostPer1M;
  const outputCost = (params.outputTokens / 1_000_000) * pricing.outputCostPer1M;
  return Number((inputCost + outputCost).toFixed(6));
}

export function estimateStageCost(params: {
  stage: StageProfileBase;
  estimatedInputTokens: number;
}): StageTokenEstimate {
  const pricing = resolvePricing(params.stage.model);
  const estimatedCostUsd = computeCostUsd({
    model: params.stage.model,
    inputTokens: params.estimatedInputTokens,
    outputTokens: params.stage.maxOutputTokens,
  });

  return {
    stage: params.stage.stageName,
    provider: params.stage.provider,
    model: params.stage.model,
    estimatedInputTokens: params.estimatedInputTokens,
    maxOutputTokens: params.stage.maxOutputTokens,
    contextWindowTokens: params.stage.contextWindowTokens,
    withinBudget: params.estimatedInputTokens <= params.stage.inputTokenBudget
      && params.estimatedInputTokens + params.stage.maxOutputTokens <= params.stage.contextWindowTokens,
    estimatedCostUsd,
    pricingConfigured: pricing.configured,
    notes: [],
  };
}

export async function writeCostEstimateArtifact(params: {
  chapterNumber: number;
  qualityProfile: ChapterCostEstimate["qualityProfile"];
  stages: StageTokenEstimate[];
  blueprintHash: string;
  blueprintVersion: string;
}): Promise<string> {
  const pricingConfigured = params.stages.every((stage) => stage.pricingConfigured);
  const totalEstimatedInputTokens = params.stages.reduce((sum, stage) => sum + stage.estimatedInputTokens, 0);
  const totalEstimatedOutputTokens = params.stages.reduce((sum, stage) => sum + stage.maxOutputTokens, 0);
  const estimatedCostUsd = pricingConfigured
    ? Number(params.stages.reduce((sum, stage) => sum + (stage.estimatedCostUsd ?? 0), 0).toFixed(6))
    : null;

  const artifact: ArtifactEnvelope<ChapterCostEstimate> = {
    schemaVersion: config.artifactSchemaVersion,
    artifactType: "chapter-cost-estimate",
    createdAt: new Date().toISOString(),
    blueprintHash: params.blueprintHash,
    blueprintVersion: params.blueprintVersion,
    chapterNumber: params.chapterNumber,
    qualityProfile: params.qualityProfile,
    data: {
      chapterNumber: params.chapterNumber,
      qualityProfile: params.qualityProfile,
      pricingConfigured,
      totalEstimatedInputTokens,
      totalEstimatedOutputTokens,
      estimatedCostUsd,
      stages: params.stages,
    },
  };

  const targetPath = path.join(config.paths.chapterArtifacts, `chapter-${params.chapterNumber}-cost-estimate.json`);
  await writeJson(targetPath, artifact);
  return targetPath;
}

export function addEstimatedCostToUsage(usage: StageUsage): StageUsage {
  const estimatedCostUsd = usage.inputTokens !== null && usage.outputTokens !== null
    ? computeCostUsd({
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    })
    : null;

  return {
    ...usage,
    estimatedCostUsd,
  };
}

export async function writeCostSummaryArtifact(params: {
  chapterNumber: number;
  qualityProfile: ChapterCostSummary["qualityProfile"];
  usages: Array<{ stage: string; usage: StageUsage }>;
  blueprintHash: string;
  blueprintVersion: string;
}): Promise<string> {
  const totalInputTokens = params.usages.reduce((sum, entry) => sum + (entry.usage.inputTokens ?? 0), 0);
  const totalOutputTokens = params.usages.reduce((sum, entry) => sum + (entry.usage.outputTokens ?? 0), 0);
  const totalTokens = params.usages.reduce((sum, entry) => sum + (entry.usage.totalTokens ?? 0), 0);
  const allStageCostsKnown = params.usages.every(
    (entry) => entry.usage.estimatedCostUsd !== undefined && entry.usage.estimatedCostUsd !== null,
  );
  const totalCostUsd = allStageCostsKnown
    ? Number(params.usages.reduce((sum, entry) => sum + (entry.usage.estimatedCostUsd ?? 0), 0).toFixed(6))
    : null;
  const pricingConfigured = params.usages.every(
    (entry) => resolvePricing(entry.usage.model).configured,
  );

  const artifact: ArtifactEnvelope<ChapterCostSummary> = {
    schemaVersion: config.artifactSchemaVersion,
    artifactType: "chapter-cost-summary",
    createdAt: new Date().toISOString(),
    blueprintHash: params.blueprintHash,
    blueprintVersion: params.blueprintVersion,
    chapterNumber: params.chapterNumber,
    qualityProfile: params.qualityProfile,
    data: {
      chapterNumber: params.chapterNumber,
      qualityProfile: params.qualityProfile,
      pricingConfigured,
      estimatedFromUsage: true,
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      totalCostUsd,
      stages: params.usages,
    },
  };

  const targetPath = path.join(config.paths.chapterArtifacts, `chapter-${params.chapterNumber}-cost-summary.json`);
  await writeJson(targetPath, artifact);
  return targetPath;
}

export function buildStageTelemetry(
  stage: StageProfileBase,
  preflight: TokenPreflight,
  usage?: StageUsage,
): StageTelemetry {
  const estimatedCostUsd = computeCostUsd({
    model: stage.model,
    inputTokens: preflight.estimatedInputTokens,
    outputTokens: preflight.reservedOutputTokens,
  });

  const actualCostUsd = usage?.inputTokens !== null && usage?.inputTokens !== undefined
    && usage.outputTokens !== null && usage.outputTokens !== undefined
    ? computeCostUsd({
      model: stage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    })
    : null;

  return {
    stageId: stage.stageName,
    preflight,
    estimatedCostUsd,
    actualCostUsd,
  };
}
