import type { LlmClient } from "./contracts.ts";
import { createOpenAiClient } from "./client.ts";
import { createGeminiClient } from "./gemini-client.ts";
import { createOllamaClient } from "./ollama-client.ts";
import { AiError, ensure } from "./errors.ts";
import type { TransportOptions } from "./http.ts";

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
      return createOllamaClient({ ...transport, model: env.OLLAMA_MODEL?.trim() ?? "", baseUrl: env.OLLAMA_BASE_URL?.trim() || undefined, contextLength: env.OLLAMA_CONTEXT_LENGTH?.trim() ? Number(env.OLLAMA_CONTEXT_LENGTH) : undefined });
    default:
      throw new AiError("CONFIG", "AI_PROVIDER must be openai, gemini, or ollama.");
  }
}
