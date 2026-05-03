import Anthropic from "@anthropic-ai/sdk";

import type { AnthropicStageProfile } from "../config.js";
import type { ModelResult, StageUsage } from "../types/index.js";
import { requireEnv } from "../config.js";
import {
  assertStageBudget,
  estimateAnthropicPromptTokens,
} from "../metrics/token-budget.js";
import { addEstimatedCostToUsage } from "../metrics/cost-tracker.js";
import { BlockedPipelineError } from "../pipeline/stage-utils.js";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: requireEnv("ANTHROPIC_API_KEY"),
    });
  }
  return client;
}

export function hasAnthropicCredentials(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

function normalizeUsage(message: any, model: string): StageUsage {
  const inputTokens = message?.usage?.input_tokens ?? null;
  const outputTokens = message?.usage?.output_tokens ?? null;
  const totalTokens = inputTokens !== null && outputTokens !== null
    ? inputTokens + outputTokens
    : null;

  return addEstimatedCostToUsage({
    provider: "anthropic",
    model,
    inputTokens,
    outputTokens,
    reasoningTokens: null,
    totalTokens,
    responseId: typeof message?.id === "string" ? message.id : null,
  });
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

type ThinkingEffort = "low" | "medium" | "high" | "xhigh" | "max";

function thinkingBudgetToEffort(budgetTokens: number): ThinkingEffort {
  if (budgetTokens <= 1000) return "low";
  if (budgetTokens <= 3000) return "medium";
  if (budgetTokens <= 7000) return "high";
  if (budgetTokens <= 12000) return "xhigh";
  return "max";
}

function toProviderFailure(stage: AnthropicStageProfile, error: unknown): BlockedPipelineError {
  const status = extractStatus(error);
  const message = error instanceof Error ? error.message : String(error);
  return new BlockedPipelineError(
    "BLOCKED_PROVIDER_FAILURE",
    stage.stageName,
    `Anthropic stage ${stage.stageName} failed for model ${stage.model}: ${message}`,
    {
      provider: "anthropic",
      model: stage.model,
      status,
    },
  );
}

export async function estimateInputTokens(params: {
  stage: AnthropicStageProfile;
  system: string;
  prompt: string;
}): Promise<number> {
  const fallback = estimateAnthropicPromptTokens(params);
  if (!hasAnthropicCredentials()) {
    return fallback;
  }

  try {
    const client = getClient();
    const result = await client.messages.countTokens({
      model: params.stage.model,
      system: params.system,
      messages: [{ role: "user", content: params.prompt }],
    } as any);

    return (result as any).input_tokens ?? (result as any).count ?? fallback;
  } catch {
    return fallback;
  }
}

export async function generateText(params: {
  stage: AnthropicStageProfile;
  system: string;
  prompt: string;
}): Promise<ModelResult<string>> {
  const estimatedInputTokens = await estimateInputTokens(params);
  assertStageBudget({
    stage: params.stage,
    estimatedInputTokens,
  });

  const client = getClient();
  try {
    return await withRetry(async () => {
      let prose = "";
      const stream = client.messages
        .stream({
          model: params.stage.model,
          max_tokens: params.stage.maxOutputTokens,
          system: params.system,
          thinking: {
            type: "adaptive",
          },
          output_config: {
            effort: thinkingBudgetToEffort(params.stage.thinkingBudgetTokens),
          },
          messages: [
            {
              role: "user",
              content: params.prompt,
            },
          ],
        } as any)
        .on("text", (textDelta: string) => {
          prose += textDelta;
        });

      const finalMessage = await stream.finalMessage();

      if (!prose.trim()) {
        prose = (finalMessage.content ?? [])
          .filter((block: any) => block.type === "text")
          .map((block: any) => block.text)
          .join("");
      }

      return {
        value: prose.trim(),
        usage: normalizeUsage(finalMessage, params.stage.model),
      };
    });
  } catch (error) {
    if (error instanceof BlockedPipelineError) {
      throw error;
    }

    throw toProviderFailure(params.stage, error);
  }
}
