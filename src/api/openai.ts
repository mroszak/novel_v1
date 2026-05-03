import OpenAI from "openai";

import type { ModelResult, StageUsage } from "../types/index.js";
import type { OpenAiStageProfile } from "../config.js";
import { requireEnv } from "../config.js";
import {
  assertStageBudget,
  estimateOpenAiPromptTokens,
} from "../metrics/token-budget.js";
import { addEstimatedCostToUsage } from "../metrics/cost-tracker.js";
import { BlockedPipelineError } from "../pipeline/stage-utils.js";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: requireEnv("OPENAI_API_KEY"),
    });
  }
  return client;
}

export function hasOpenAiCredentials(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function normalizeUsage(response: any, model: string): StageUsage {
  const usage = response?.usage ?? {};
  const inputTokens = usage.input_tokens ?? null;
  const outputTokens = usage.output_tokens ?? null;
  const reasoningTokens = usage.output_tokens_details?.reasoning_tokens ?? null;
  const totalTokens = usage.total_tokens ?? (
    inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null
  );

  return addEstimatedCostToUsage({
    provider: "openai",
    model,
    inputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    responseId: typeof response?.id === "string" ? response.id : null,
  });
}

function isIncompleteResponse(response: any): { incomplete: boolean; reason: string | null } {
  const status = response?.status;
  if (status === "incomplete") {
    const reason = response?.incomplete_details?.reason ?? "unknown";
    return { incomplete: true, reason };
  }

  const outputText = response?.output_text;
  if (typeof outputText === "string" && outputText.trim() === "") {
    const usage = response?.usage ?? {};
    const outputTokens = usage.output_tokens ?? 0;
    const reasoningTokens = usage.output_tokens_details?.reasoning_tokens ?? 0;
    if (outputTokens > 0 && reasoningTokens >= outputTokens * 0.9) {
      return { incomplete: true, reason: "reasoning_tokens_exhausted_output_budget" };
    }
    return { incomplete: true, reason: "empty_output_text" };
  }

  return { incomplete: false, reason: null };
}

function incompleteRemediation(reason: string): string {
  switch (reason) {
    case "max_output_tokens":
    case "reasoning_tokens_exhausted_output_budget":
      return "Increase maxOutputTokens for this stage.";
    case "content_filter":
      return "Response was blocked by a content filter. Review prompt content.";
    default:
      return "Inspect incomplete_details for root cause.";
  }
}

function buildIncompleteError(
  stage: OpenAiStageProfile,
  reason: string,
  response: any,
): BlockedPipelineError {
  const usage = response?.usage ?? {};
  const outputTokens = usage.output_tokens ?? 0;
  const reasoningTokens = usage.output_tokens_details?.reasoning_tokens ?? 0;
  return new BlockedPipelineError(
    "BLOCKED_PROVIDER_FAILURE",
    stage.stageName,
    `OpenAI stage ${stage.stageName} returned incomplete response (${reason}). `
    + `Model ${stage.model} used ${reasoningTokens} reasoning / ${outputTokens} output tokens `
    + `against max_output_tokens=${stage.maxOutputTokens}. ${incompleteRemediation(reason)}`,
    {
      provider: "openai",
      model: stage.model,
      reason,
      outputTokens,
      reasoningTokens,
      maxOutputTokens: stage.maxOutputTokens,
    },
  );
}

async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error)) {
        throw error;
      }
      if (attempt === 2) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function extractStatus(error: unknown): number | null {
  return typeof error === "object" && error !== null && "status" in error
    && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : null;
}

function isRetryableError(error: unknown): boolean {
  const status = extractStatus(error);
  if (status !== null) {
    if ([400, 401, 403, 404, 422].includes(status)) {
      return false;
    }
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }

  const name = error instanceof Error ? error.name : "";
  return /connection|timeout|rate.?limit/i.test(name);
}

function toProviderFailure(stage: OpenAiStageProfile, error: unknown): BlockedPipelineError {
  const status = extractStatus(error);
  const message = error instanceof Error ? error.message : String(error);
  return new BlockedPipelineError(
    "BLOCKED_PROVIDER_FAILURE",
    stage.stageName,
    `OpenAI stage ${stage.stageName} failed for model ${stage.model}: ${message}`,
    {
      provider: "openai",
      model: stage.model,
      status,
    },
  );
}

export async function generateStructuredOutput<T>(params: {
  stage: OpenAiStageProfile;
  instructions: string;
  prompt: string;
  schemaName: string;
  schema: Record<string, unknown>;
}): Promise<ModelResult<T>> {
  const client = getClient();
  const estimatedInputTokens = estimateOpenAiPromptTokens({
    stage: params.stage,
    instructions: params.instructions,
    prompt: params.prompt,
    schema: params.schema,
  });
  assertStageBudget({
    stage: params.stage,
    estimatedInputTokens,
  });

  try {
    const response = await withRetry(() => client.responses.create({
      model: params.stage.model,
      instructions: params.instructions,
      input: params.prompt,
      max_output_tokens: params.stage.maxOutputTokens,
      reasoning: {
        effort: params.stage.reasoningEffort,
        summary: "auto",
      },
      text: {
        verbosity: params.stage.verbosity,
        format: {
          type: "json_schema",
          name: params.schemaName,
          strict: true,
          schema: params.schema,
        },
      },
    } as any));

    const { incomplete, reason } = isIncompleteResponse(response);
    if (incomplete && reason) {
      throw buildIncompleteError(params.stage, reason, response);
    }

    const responseData = response as any;
    const parsed = responseData.output_parsed ?? JSON.parse(response.output_text);
    return {
      value: parsed as T,
      usage: normalizeUsage(response, params.stage.model),
    };
  } catch (error) {
    if (error instanceof BlockedPipelineError) {
      throw error;
    }

    if (error instanceof SyntaxError) {
      throw new BlockedPipelineError(
        "BLOCKED_PROVIDER_FAILURE",
        params.stage.stageName,
        `OpenAI stage ${params.stage.stageName} returned unparseable structured output for model ${params.stage.model}.`,
        {
          provider: "openai",
          model: params.stage.model,
        },
      );
    }

    throw toProviderFailure(params.stage, error);
  }
}

export async function generateText(params: {
  stage: OpenAiStageProfile;
  instructions: string;
  prompt: string;
}): Promise<ModelResult<string>> {
  const client = getClient();
  const estimatedInputTokens = estimateOpenAiPromptTokens({
    stage: params.stage,
    instructions: params.instructions,
    prompt: params.prompt,
  });
  assertStageBudget({
    stage: params.stage,
    estimatedInputTokens,
  });

  try {
    const response = await withRetry(() => client.responses.create({
      model: params.stage.model,
      instructions: params.instructions,
      input: params.prompt,
      max_output_tokens: params.stage.maxOutputTokens,
      reasoning: {
        effort: params.stage.reasoningEffort,
        summary: "auto",
      },
      text: {
        verbosity: params.stage.verbosity,
      },
    } as any));

    const { incomplete, reason } = isIncompleteResponse(response);
    if (incomplete && reason) {
      throw buildIncompleteError(params.stage, reason, response);
    }

    return {
      value: response.output_text.trim(),
      usage: normalizeUsage(response, params.stage.model),
    };
  } catch (error) {
    if (error instanceof BlockedPipelineError) {
      throw error;
    }

    throw toProviderFailure(params.stage, error);
  }
}

export function estimateRequestInputTokens(params: {
  stage: OpenAiStageProfile;
  instructions: string;
  prompt: string;
  schema?: Record<string, unknown>;
}): number {
  return estimateOpenAiPromptTokens(params);
}
