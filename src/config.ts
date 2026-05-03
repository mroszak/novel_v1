import path from "node:path";

export interface StageProfileBase {
  stageName: string;
  provider: "openai" | "anthropic";
  model: string;
  inputTokenBudget: number;
  maxOutputTokens: number;
  contextWindowTokens: number;
}

export interface OpenAiStageProfile extends StageProfileBase {
  provider: "openai";
  reasoningEffort: "none" | "low" | "medium" | "high";
  verbosity: "low" | "medium" | "high";
}

export interface AnthropicStageProfile extends StageProfileBase {
  provider: "anthropic";
  thinkingBudgetTokens: number;
}

export interface ModelPricingProfile {
  inputCostPer1M: number;
  outputCostPer1M: number;
  configured: boolean;
}

function optionalEnv(keys: string | string[], fallback: string): string {
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    const value = process.env[key]?.trim();
    if (value && value.length > 0) {
      return value;
    }
  }
  return fallback;
}

function optionalNumberEnv(key: string, fallback: number): number {
  const value = process.env[key]?.trim();
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseConfiguredNumberEnv(keys: string | string[]): number | null {
  let value: string | undefined;
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    const candidate = process.env[key]?.trim();
    if (candidate) {
      value = candidate;
      break;
    }
  }

  if (!value) {
    return null;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

export function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

const rootDir = path.resolve(process.env.NOVEL_CREATOR_ROOT ?? process.cwd());
const artifactSchemaVersion = "engine.v2";
const blueprintRuntimeCacheVersion = "blueprint-runtime.v1";
const openAiPrimaryModel = optionalEnv(["OPENAI_MODEL_GPT55", "OPENAI_MODEL_GPT54"], "gpt-5.5");
const anthropicPrimaryModel = optionalEnv(["ANTHROPIC_MODEL_OPUS47", "ANTHROPIC_MODEL_OPUS46"], "claude-opus-4-7");

function pricingFromEnv(inputKey: string | string[], outputKey: string | string[]): ModelPricingProfile {
  const input = parseConfiguredNumberEnv(inputKey);
  const output = parseConfiguredNumberEnv(outputKey);

  return {
    inputCostPer1M: input ?? 0,
    outputCostPer1M: output ?? 0,
    configured: input !== null && output !== null,
  };
}

export const config = {
  rootDir,
  artifactSchemaVersion,
  blueprintRuntimeCacheVersion,
  defaults: {
    previousChapterExcerptWords: 1800,
    chapterWordBandLeeway: 500,
    olderHistoryEntries: 12,
    revealLedgerEntries: 12,
    knowledgeWarningEntries: 10,
    smokeChapterNumber: 1,
  },
  models: {
    openAiPrimary: openAiPrimaryModel,
    anthropicPrimary: anthropicPrimaryModel,
  },
  pricing: {
    [openAiPrimaryModel]: pricingFromEnv(
      ["OPENAI_GPT55_INPUT_COST_PER_1M", "OPENAI_GPT54_INPUT_COST_PER_1M"],
      ["OPENAI_GPT55_OUTPUT_COST_PER_1M", "OPENAI_GPT54_OUTPUT_COST_PER_1M"],
    ),
    [anthropicPrimaryModel]: pricingFromEnv(
      ["ANTHROPIC_OPUS47_INPUT_COST_PER_1M", "ANTHROPIC_OPUS46_INPUT_COST_PER_1M"],
      ["ANTHROPIC_OPUS47_OUTPUT_COST_PER_1M", "ANTHROPIC_OPUS46_OUTPUT_COST_PER_1M"],
    ),
  } as Record<string, ModelPricingProfile>,
  qualitySettings: {
    judgePassThreshold: 86,
    pairwiseTolerance: 3,
    maxFixAttempts: 1,
    maxLiteraryRetryAttempts: 0,
    alwaysRunSpecCritique: false,
    skipRevisionThreshold: 88,
  },
  paths: {
    blueprint: path.resolve(rootDir, "STORY_BLUEPRINT.md"),
    artifacts: path.resolve(rootDir, "artifacts"),
    blueprintArtifacts: path.resolve(rootDir, "artifacts", "blueprint"),
    blueprintCache: path.resolve(rootDir, "artifacts", "cache", "blueprints"),
    chapterArtifacts: path.resolve(rootDir, "artifacts", "chapters"),
    memoryArtifacts: path.resolve(rootDir, "artifacts", "memory"),
    smokeArtifacts: path.resolve(rootDir, "artifacts", "smoke"),
    chapters: path.resolve(rootDir, "chapters"),
  },
  stageProfiles: {
    blueprintInterpretation: {
      stageName: "blueprint-interpretation",
      provider: "openai",
      model: openAiPrimaryModel,
      reasoningEffort: "low",
      verbosity: "low",
      inputTokenBudget: 18000,
      maxOutputTokens: 3000,
      contextWindowTokens: 32000,
    } satisfies OpenAiStageProfile,
    genreCompilation: {
      stageName: "genre-compilation",
      provider: "openai",
      model: openAiPrimaryModel,
      reasoningEffort: "medium",
      verbosity: "low",
      inputTokenBudget: 20000,
      maxOutputTokens: 3000,
      contextWindowTokens: 32000,
    } satisfies OpenAiStageProfile,
    authorBrief: {
      stageName: "author-brief",
      provider: "openai",
      model: openAiPrimaryModel,
      reasoningEffort: "medium",
      verbosity: "low",
      inputTokenBudget: 16000,
      maxOutputTokens: 2000,
      contextWindowTokens: 28000,
    } satisfies OpenAiStageProfile,
    specGeneration: {
      stageName: "spec-generation",
      provider: "openai",
      model: openAiPrimaryModel,
      reasoningEffort: "high",
      verbosity: "medium",
      inputTokenBudget: 26000,
      maxOutputTokens: 20000,
      contextWindowTokens: 60000,
    } satisfies OpenAiStageProfile,
    selfRedTeam: {
      stageName: "self-red-team",
      provider: "openai",
      model: openAiPrimaryModel,
      reasoningEffort: "high",
      verbosity: "low",
      inputTokenBudget: 32000,
      maxOutputTokens: 8000,
      contextWindowTokens: 50000,
    } satisfies OpenAiStageProfile,
    specRevision: {
      stageName: "spec-revision",
      provider: "openai",
      model: openAiPrimaryModel,
      reasoningEffort: "high",
      verbosity: "medium",
      inputTokenBudget: 36000,
      maxOutputTokens: 20000,
      contextWindowTokens: 70000,
    } satisfies OpenAiStageProfile,
    specCritique: {
      stageName: "spec-critique",
      provider: "anthropic",
      model: anthropicPrimaryModel,
      inputTokenBudget: 26000,
      maxOutputTokens: 6000,
      contextWindowTokens: 50000,
      thinkingBudgetTokens: 2000,
    } satisfies AnthropicStageProfile,
    drafting: {
      stageName: "drafting",
      provider: "anthropic",
      model: anthropicPrimaryModel,
      inputTokenBudget: 50000,
      maxOutputTokens: 16000,
      contextWindowTokens: 90000,
      thinkingBudgetTokens: 10000,
    } satisfies AnthropicStageProfile,
    literaryJudge: {
      stageName: "literary-judge",
      provider: "openai",
      model: openAiPrimaryModel,
      reasoningEffort: "medium",
      verbosity: "low",
      inputTokenBudget: 42000,
      maxOutputTokens: 10000,
      contextWindowTokens: 70000,
    } satisfies OpenAiStageProfile,
    revision: {
      stageName: "revision",
      provider: "anthropic",
      model: anthropicPrimaryModel,
      inputTokenBudget: 52000,
      maxOutputTokens: 16000,
      contextWindowTokens: 90000,
      thinkingBudgetTokens: 8000,
    } satisfies AnthropicStageProfile,
    pairwiseSelection: {
      stageName: "pairwise-selection",
      provider: "openai",
      model: openAiPrimaryModel,
      reasoningEffort: "medium",
      verbosity: "low",
      inputTokenBudget: 46000,
      maxOutputTokens: 5000,
      contextWindowTokens: 64000,
    } satisfies OpenAiStageProfile,
    chapterDelta: {
      stageName: "chapter-delta",
      provider: "openai",
      model: openAiPrimaryModel,
      reasoningEffort: "high",
      verbosity: "low",
      inputTokenBudget: 42000,
      maxOutputTokens: 24000,
      contextWindowTokens: 80000,
    } satisfies OpenAiStageProfile,
    memoryUpdate: {
      stageName: "memory-update",
      provider: "openai",
      model: openAiPrimaryModel,
      reasoningEffort: "high",
      verbosity: "low",
      inputTokenBudget: 42000,
      maxOutputTokens: 18000,
      contextWindowTokens: 65000,
    } satisfies OpenAiStageProfile,
    finalAudit: {
      stageName: "final-audit",
      provider: "openai",
      model: openAiPrimaryModel,
      reasoningEffort: "high",
      verbosity: "low",
      inputTokenBudget: 42000,
      maxOutputTokens: 18000,
      contextWindowTokens: 75000,
    } satisfies OpenAiStageProfile,
    continuityFix: {
      stageName: "continuity-fix",
      provider: "anthropic",
      model: anthropicPrimaryModel,
      inputTokenBudget: 52000,
      maxOutputTokens: 16000,
      contextWindowTokens: 90000,
      thinkingBudgetTokens: 3500,
    } satisfies AnthropicStageProfile,
    voiceGritPlan: {
      stageName: "voice-grit-plan",
      provider: "anthropic",
      model: anthropicPrimaryModel,
      inputTokenBudget: 50000,
      maxOutputTokens: 4000,
      contextWindowTokens: 80000,
      thinkingBudgetTokens: 1500,
    } satisfies AnthropicStageProfile,
    voiceGritRejudge: {
      stageName: "voice-grit-rejudge",
      provider: "openai",
      model: openAiPrimaryModel,
      reasoningEffort: "medium",
      verbosity: "low",
      inputTokenBudget: 42000,
      maxOutputTokens: 4000,
      contextWindowTokens: 70000,
    } satisfies OpenAiStageProfile,
    voiceCalibration: {
      stageName: "voice-calibration",
      provider: "openai",
      model: openAiPrimaryModel,
      reasoningEffort: "low",
      verbosity: "low",
      inputTokenBudget: 36000,
      maxOutputTokens: 3000,
      contextWindowTokens: 60000,
    } satisfies OpenAiStageProfile,
    openingCandidate: {
      stageName: "opening-candidate",
      provider: "anthropic",
      model: anthropicPrimaryModel,
      inputTokenBudget: 42000,
      maxOutputTokens: 2400,
      contextWindowTokens: 70000,
      thinkingBudgetTokens: 1200,
    } satisfies AnthropicStageProfile,
    endingCandidate: {
      stageName: "ending-candidate",
      provider: "anthropic",
      model: anthropicPrimaryModel,
      inputTokenBudget: 42000,
      maxOutputTokens: 2000,
      contextWindowTokens: 70000,
      thinkingBudgetTokens: 1200,
    } satisfies AnthropicStageProfile,
    tournamentSelection: {
      stageName: "tournament-selection",
      provider: "openai",
      model: openAiPrimaryModel,
      reasoningEffort: "medium",
      verbosity: "low",
      inputTokenBudget: 30000,
      maxOutputTokens: 2000,
      contextWindowTokens: 50000,
    } satisfies OpenAiStageProfile,
  },
};
