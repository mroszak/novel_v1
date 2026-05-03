import type { AnthropicStageProfile, OpenAiStageProfile, StageProfileBase } from "../config.js";
import type { TokenPreflight } from "../types/index.js";

export function estimateTextTokens(text: string): number {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return 0;
  }

  return Math.ceil(normalized.length / 4);
}

export function estimateValueTokens(value: unknown): number {
  return estimateTextTokens(JSON.stringify(value));
}

export function estimateWordTokens(wordCount: number): number {
  return Math.ceil(wordCount * 1.35);
}

export function compactTextToTokenBudget(text: string, maxTokens: number): string {
  if (estimateTextTokens(text) <= maxTokens) {
    return text;
  }

  const approxChars = Math.max(0, maxTokens * 4);
  return `${text.slice(0, approxChars).trimEnd()}\n...[compacted]`;
}

export function compactListToTokenBudget(items: string[], maxTokens: number): string[] {
  const compacted: string[] = [];
  let usedTokens = 0;

  for (const item of items) {
    const itemTokens = estimateTextTokens(item);
    if (usedTokens + itemTokens > maxTokens) {
      break;
    }
    compacted.push(item);
    usedTokens += itemTokens;
  }

  return compacted;
}

export function assertStageBudget(params: {
  stage: StageProfileBase;
  estimatedInputTokens: number;
}): void {
  const { stage, estimatedInputTokens } = params;
  if (estimatedInputTokens > stage.inputTokenBudget) {
    throw new Error(
      `BLOCKED_BUDGET: ${stage.stageName} input estimate ${estimatedInputTokens} exceeds stage input budget ${stage.inputTokenBudget}.`,
    );
  }

  if (estimatedInputTokens + stage.maxOutputTokens > stage.contextWindowTokens) {
    throw new Error(
      `BLOCKED_BUDGET: ${stage.stageName} input+output estimate ${estimatedInputTokens + stage.maxOutputTokens} exceeds context window ${stage.contextWindowTokens}.`,
    );
  }
}

export function estimateOpenAiPromptTokens(params: {
  stage: OpenAiStageProfile;
  instructions: string;
  prompt: string;
  schema?: Record<string, unknown>;
}): number {
  return estimateTextTokens(params.instructions)
    + estimateTextTokens(params.prompt)
    + estimateValueTokens(params.schema ?? null)
    + 32;
}

export function estimateAnthropicPromptTokens(params: {
  stage: AnthropicStageProfile;
  system: string;
  prompt: string;
}): number {
  return estimateTextTokens(params.system) + estimateTextTokens(params.prompt) + 32;
}

export function buildTokenPreflight(
  stage: StageProfileBase,
  inputSections: Array<string | null | undefined>,
): TokenPreflight {
  const estimatedInputTokens = inputSections.reduce(
    (sum, section) => sum + estimateTextTokens(section ?? ""),
    0,
  );
  const reservedOutputTokens = stage.maxOutputTokens;
  const estimatedTotalTokens = estimatedInputTokens + reservedOutputTokens;

  return {
    stageId: stage.stageName,
    provider: stage.provider,
    model: stage.model,
    estimatedInputTokens,
    reservedOutputTokens,
    estimatedTotalTokens,
    contextWindowTokens: stage.contextWindowTokens,
    withinBudget: estimatedInputTokens <= stage.inputTokenBudget
      && estimatedTotalTokens <= stage.contextWindowTokens,
    notes: [],
  };
}

export function assertWithinBudget(preflight: TokenPreflight): void {
  if (preflight.withinBudget) {
    return;
  }

  throw new Error(
    `BLOCKED_BUDGET: ${preflight.stageId} estimate ${preflight.estimatedTotalTokens} exceeds ${preflight.contextWindowTokens}.`,
  );
}
