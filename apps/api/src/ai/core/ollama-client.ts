import type { LlmClient } from "./contracts.ts";
import { AiError, ensure } from "./errors.ts";
import { createJsonClient, record } from "./http.ts";
import type { TransportOptions } from "./http.ts";

export interface OllamaOptions extends TransportOptions {
  model: string;
  baseUrl?: string;
  contextLength?: number;
}

function localEndpoint(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); }
  catch { throw new AiError("CONFIG", "Invalid OLLAMA_BASE_URL."); }
  ensure(
    ["http:", "https:"].includes(url.protocol) &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    !url.username && !url.password && !url.search && !url.hash && url.pathname === "/",
    "OLLAMA_BASE_URL must be a loopback HTTP(S) origin, such as http://127.0.0.1:11434.", "CONFIG",
  );
  return new URL("/api/chat", url).href;
}

function responseText(value: unknown): { text: string; usage: unknown } {
  const body = record(value);
  if (body.error !== undefined) throw new AiError("PROVIDER", "Ollama could not generate a response.");
  ensure(body.done === true && body.done_reason === "stop", "The Ollama response was incomplete.", "FORMAT");
  const message = record(body.message);
  ensure(message.role === "assistant" && typeof message.content === "string" && message.content.trim(), "Missing Ollama output text.", "FORMAT");
  return {
    text: message.content,
    usage: { input_tokens: body.prompt_eval_count, output_tokens: body.eval_count },
  };
}

export function createOllamaClient(options: OllamaOptions): LlmClient {
  ensure(options.model.trim(), "Set OLLAMA_MODEL to an installed local model.", "CONFIG");
  const contextLength = options.contextLength ?? 8192;
  ensure(Number.isInteger(contextLength) && contextLength >= 2048 && contextLength <= 131072, "OLLAMA_CONTEXT_LENGTH must be an integer from 2048 to 131072.", "CONFIG");
  return createJsonClient({
    provider: "ollama",
    url: localEndpoint(options.baseUrl ?? "http://127.0.0.1:11434"),
    headers: {},
    contextRecovery: { initialTokens: contextLength, maxTokens: Math.max(contextLength, 32768), outputTokens: 6000 },
    body(request, expandedContext) {
      return {
        model: options.model, stream: false, format: request.schema.json,
        messages: [
          { role: "system", content: request.instructions },
          { role: "user", content: JSON.stringify(request.data) },
        ],
        options: { num_predict: 6000, num_ctx: expandedContext ?? contextLength },
      };
    },
    output: responseText,
  }, { ...options, timeoutMs: options.timeoutMs ?? 180000 });
}
