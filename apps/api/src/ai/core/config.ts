import type { GenerationRequest, LlmClient } from "./contracts.ts";
import { createOpenAiClient } from "./client.ts";
import { createGeminiClient } from "./gemini-client.ts";
import { createOllamaClient } from "./ollama-client.ts";
import { AiError, ensure } from "./errors.ts";
import type { TransportOptions } from "./http.ts";
import { validateConcurrency } from "./batches.ts";

export function analysisOptionsFromEnv(env: Record<string, string | undefined>) {
  const provider = env.AI_PROVIDER?.trim().toLowerCase() || "openai";
  const concurrencyValue = env.AI_CONCURRENCY?.trim();
  const concurrency = validateConcurrency(concurrencyValue ? Number(concurrencyValue) : provider === "ollama" ? 1 : 2);
  const batchValue = env.AI_BATCH_CHARACTERS?.trim();
  const batchCharacters = batchValue ? Number(batchValue) : 6000;
  ensure(Number.isInteger(batchCharacters) && batchCharacters >= 1000 && batchCharacters <= 12000, "AI_BATCH_CHARACTERS must be an integer from 1000 to 12000.", "CONFIG");
  const cacheValue = env.AI_ANALYSIS_CACHE?.trim() || "1";
  ensure(["0", "1"].includes(cacheValue), "AI_ANALYSIS_CACHE must be 0 or 1.", "CONFIG");
  return { concurrency, batchCharacters, cacheEnabled: cacheValue === "1" };
}

export function createConfiguredClient(env: Record<string, string | undefined>, options: TransportOptions = {}): LlmClient {
  const provider = env.AI_PROVIDER?.trim().toLowerCase() || "openai";
  const timeoutValue = env.AI_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutValue ? Number(timeoutValue) : options.timeoutMs;
  const attemptsValue = env.AI_MAX_ATTEMPTS?.trim();
  const maxAttempts = attemptsValue ? Number(attemptsValue) : options.maxAttempts;
  ensure(timeoutMs === undefined || (Number.isFinite(timeoutMs) && timeoutMs > 0), "AI_TIMEOUT_MS must be a positive number.", "CONFIG");
  const transport = { ...options, timeoutMs, maxAttempts };
  switch (provider) {
    case "openai":
      return createOpenAiClient({ ...transport, apiKey: env.OPENAI_API_KEY?.trim() ?? "", model: env.OPENAI_MODEL?.trim() ?? "" });
    case "gemini":
      return createGeminiClient({ ...transport, apiKey: env.GEMINI_API_KEY?.trim() ?? "", model: env.GEMINI_MODEL?.trim() ?? "" });
    case "ollama":
      return createTaskRoutedOllamaClient(env, transport);
    default:
      throw new AiError("CONFIG", "AI_PROVIDER must be openai, gemini, or ollama.");
  }
}

const graphTasks = new Set(["concept_extraction", "concept_detail_expansion", "concept_organization", "relation_analysis"]);

function createTaskRoutedOllamaClient(env: Record<string, string | undefined>, transport: TransportOptions): LlmClient {
  const shared = { ...transport, baseUrl: env.OLLAMA_BASE_URL?.trim() || undefined,
    contextLength: env.OLLAMA_CONTEXT_LENGTH?.trim() ? Number(env.OLLAMA_CONTEXT_LENGTH) : undefined };
  const graph = createOllamaClient({ ...shared, model: env.OLLAMA_MODEL?.trim() ?? "" });
  const fastModel = env.OLLAMA_FAST_MODEL?.trim();
  // Preserve existing single-model configurations when no fast model is selected.
  if (!fastModel) return graph;
  const fast = createOllamaClient({ ...shared, model: fastModel, think: false });
  return {
    generate<T>(request: GenerationRequest<T>): Promise<T> {
      return (graphTasks.has(request.name) ? graph : fast).generate(request);
    },
  };
}
