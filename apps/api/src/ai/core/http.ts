import type { GenerationRequest, LlmClient } from "./contracts.ts";
import { AiError, ensure } from "./errors.ts";

export interface UsageEvent {
  provider: string;
  task: string;
  attempt: number;
  usage?: unknown;
  error?: string;
  providerStatus?: string;
  retryInMs?: number;
  elapsedMs?: number;
  timeoutMs?: number;
  phase?: "headers" | "body" | "validation";
  requestCharacters?: number;
  inputTokens?: number;
  contextTokens?: number;
}

export interface TransportOptions {
  timeoutMs?: number;
  fetcher?: typeof fetch;
  onEvent?: (event: UsageEvent) => void;
  maxAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface ProviderAdapter {
  provider: string;
  url: string;
  headers: Record<string, string>;
  body(request: GenerationRequest<unknown>): unknown;
  output(value: unknown): { text: string; usage: unknown };
}

export function record(value: unknown): Record<string, unknown> {
  ensure(typeof value === "object" && value !== null && !Array.isArray(value), "Invalid provider response.", "FORMAT");
  return value;
}

function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  if (header !== null) {
    const seconds = Number(header);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(delay) && delay > 0) return delay;
  }
  return Math.min(30000, 2000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 1000);
}

interface ProviderDiagnostics {
  providerStatus?: string;
  inputTokens?: number;
  contextTokens?: number;
}

async function providerDiagnostics(response: Response): Promise<ProviderDiagnostics> {
  try {
    const raw: unknown = await response.json();
    if (typeof raw !== "object" || raw === null || !("error" in raw)) return {};
    const error = raw.error;
    if (typeof error === "string") {
      const match = /request \((\d{1,10}) tokens\) exceeds the available context size \((\d{1,10}) tokens\)/.exec(error);
      return match ? { inputTokens: Number(match[1]), contextTokens: Number(match[2]) } : {};
    }
    if (typeof error !== "object" || error === null || !("status" in error)) return {};
    const status = error.status;
    return typeof status === "string" && /^[A-Z_]{1,64}$/.test(status) ? { providerStatus: status } : {};
  } catch { return {}; }
}

export function createJsonClient(adapter: ProviderAdapter, options: TransportOptions): LlmClient {
  const timeoutMs = options.timeoutMs ?? 60000;
  ensure(Number.isFinite(timeoutMs) && timeoutMs > 0, "Invalid timeout.", "CONFIG");
  const maxAttempts = options.maxAttempts ?? 4;
  ensure(Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 8, "AI_MAX_ATTEMPTS must be an integer from 1 to 8.", "CONFIG");
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  return {
    async generate<T>(request: GenerationRequest<T>): Promise<T> {
      const body = JSON.stringify(adapter.body(request));
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const startedAt = Date.now();
        let phase: "headers" | "body" | "validation" = "headers";
        const event = { provider: adapter.provider, task: request.name, attempt, timeoutMs, requestCharacters: body.length };
        const diagnostics = () => ({ elapsedMs: Date.now() - startedAt, phase });
        try {
          const response = await (options.fetcher ?? fetch)(adapter.url, {
            method: "POST", signal: controller.signal, redirect: "error",
            headers: { ...adapter.headers, "Content-Type": "application/json" }, body,
          });
          phase = "body";
          if (!response.ok) {
            const retryable = response.status === 429 || response.status >= 500;
            const delay = retryDelay(response, attempt);
            const provider = await providerDiagnostics(response);
            if (retryable && attempt < maxAttempts && delay <= 60000) {
              options.onEvent?.({ ...event, ...diagnostics(), ...provider, error: `HTTP_${response.status}`, retryInMs: delay });
              clearTimeout(timer);
              await sleep(delay);
              continue;
            }
            options.onEvent?.({ ...event, ...diagnostics(), ...provider, error: `HTTP_${response.status}` });
            const guidance = provider.inputTokens !== undefined && provider.contextTokens !== undefined
              ? ` Input uses ${provider.inputTokens} tokens but the active context is ${provider.contextTokens}. Increase OLLAMA_CONTEXT_LENGTH or reduce AI_BATCH_CHARACTERS.`
              : response.status === 503 ? " The provider is temporarily unavailable; retry later or select another model."
              : response.status === 429 ? " Check the provider's request/token quota and retry later." : "";
            throw new AiError("PROVIDER", `LLM request failed (HTTP ${response.status}${provider.providerStatus ? `, ${provider.providerStatus}` : ""}).${guidance}`);
          }
          const responseBody = await response.text();
          phase = "validation";
          let raw: unknown;
          try { raw = JSON.parse(responseBody); }
          catch { throw new AiError("FORMAT", "The provider returned invalid JSON."); }
          const result = adapter.output(raw);
          options.onEvent?.({ ...event, ...diagnostics(), usage: result.usage });
          let parsed: unknown;
          try { parsed = JSON.parse(result.text); }
          catch { throw new AiError("FORMAT", "The model returned invalid JSON."); }
          return request.schema.parse(parsed);
        } catch (error) {
          const failure = error instanceof AiError ? error : new AiError(
            controller.signal.aborted ? "TIMEOUT" : "CONNECTION",
            controller.signal.aborted ? `LLM request timed out after ${timeoutMs} ms while waiting for response ${phase}. Adjust AI_TIMEOUT_MS or reduce AI_BATCH_CHARACTERS.` : "Could not read the LLM response.",
          );
          const canRetry = (failure.code === "TIMEOUT" || failure.code === "CONNECTION") && attempt < Math.min(maxAttempts, 2);
          const delay = 2000 + Math.floor(Math.random() * 1000);
          options.onEvent?.({ ...event, ...diagnostics(), error: failure.code, ...(canRetry ? { retryInMs: delay } : {}) });
          if (canRetry) {
            clearTimeout(timer);
            await sleep(delay);
            continue;
          }
          throw failure;
        } finally { clearTimeout(timer); }
      }
      throw new AiError("CONNECTION", "LLM request failed.");
    },
  };
}
