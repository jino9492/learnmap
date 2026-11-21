import type { GenerationRequest, LlmClient } from "./contracts.ts";
import { AiError, ensure } from "./errors.ts";
import { isRecord } from "./schema.ts";
import { randomUUID } from "node:crypto";
import { logAiEvent } from "./logging.ts";
import { aiQueues, queueLane, operationContext, coolDownModel, usageTokens, type UsageRequestQueue } from "./queue.ts";

export interface UsageEvent {
  provider: string;
  model?: string;
  task: string;
  attempt: number;
  usage?: unknown;
  error?: string;
  providerStatus?: string;
  providerCode?: string;
  providerLimits?: Record<string, string>;
  retryInMs?: number;
  elapsedMs?: number;
  timeoutMs?: number;
  phase?: "headers" | "body" | "validation";
  requestCharacters?: number;
  reservedTokens?: number;
  queueWaitMs?: number;
  inputTokens?: number;
  contextTokens?: number;
}

export interface TransportOptions {
  scheduler?: UsageRequestQueue;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  onEvent?: (event: UsageEvent) => void;
  maxAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface ProviderAdapter {
  provider: string;
  model?: string;
  url: string;
  headers: Record<string, string>;
  body(request: GenerationRequest<unknown>, contextTokens?: number, repair?: boolean): unknown;
  estimateTokens?(body: string, task: string): { reservation: number; pacingFloor: number } | undefined;
  contextRecovery?: { initialTokens: number; maxTokens: number; outputTokens: number };
  output(value: unknown): { text: string; usage: unknown };
}

export function record(value: unknown): Record<string, unknown> {
  ensure(isRecord(value), "Invalid provider response.", "FORMAT");
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
  providerCode?: string;
  providerLimits?: Record<string, string>;
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
    if (!isRecord(error)) return {};
    const status = error.status;
    const code = error.code;
    return {
      ...(typeof status === "string" && /^[A-Z_]{1,64}$/.test(status) ? { providerStatus: status } : {}),
      ...(typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? { providerCode: code } : {}),
    };
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
      ensure(request.deadlineAt === undefined || Number.isFinite(request.deadlineAt), "Invalid request deadline.", "CONFIG");
      ensure(request.maxAttempts === undefined || (Number.isInteger(request.maxAttempts) && request.maxAttempts >= 1 && request.maxAttempts <= 8), "Invalid request attempt limit.", "CONFIG");
      const attemptLimit = Math.min(maxAttempts, request.maxAttempts ?? maxAttempts);
      const lane = queueLane(request.name);
      const scheduler = options.scheduler ?? aiQueues[lane];
      const operation = operationContext();
      const deadline = lane === "interactive"
        ? Math.min(request.deadlineAt ?? Infinity, (operation?.startedAt ?? Date.now()) + Math.max(120000, timeoutMs))
        : request.deadlineAt;
      const modelKey = adapter.provider + "/" + (adapter.model ?? "");
      const requestId = randomUUID();
      const report = (event: UsageEvent) => {
        logAiEvent({ kind: "request", requestId, outcome: event.error ? (event.retryInMs !== undefined ? "retrying" : "failed") : "completed", ...event });
        options.onEvent?.(event);
      };
      let body = JSON.stringify(adapter.body(request));
      let contextTokens = adapter.contextRecovery?.initialTokens;
      let recoveredContext = false;
      let failures = 0;
      let rateLimits = 0;
      let retryAtTail = false;
      for (let attempt = 1; failures < attemptLimit; attempt++) {
        const attemptDeadline = rateLimits ? undefined : deadline;
        if (operation?.signal?.aborted) throw new AiError("CANCELLED", "AI 작업을 취소했습니다.");
        const estimate = adapter.estimateTokens?.(body, request.name);
        const reservedTokens = estimate?.reservation ?? Buffer.byteLength(body, "utf8") + 6000;
        const queuedAt = Date.now();
        const lease = await scheduler.acquire(reservedTokens, request.name, attemptDeadline, modelKey, estimate?.pacingFloor, retryAtTail);
        retryAtTail = false;
        let chargedTokens: number | undefined;
        const remainingMs = attemptDeadline === undefined ? timeoutMs : Math.min(timeoutMs, attemptDeadline - Date.now());
        if (remainingMs <= 0) { lease.finish(0); throw new AiError("TIMEOUT", "The analysis deadline was reached."); }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), remainingMs);
        const startedAt = Date.now();
        let phase: "headers" | "body" | "validation" = "headers";
        const event = { provider: adapter.provider, model: adapter.model, task: request.name, attempt, timeoutMs: remainingMs, requestCharacters: body.length, reservedTokens, queueWaitMs: startedAt - queuedAt };
        logAiEvent({ kind: "request", requestId, outcome: "started", ...event });
        const diagnostics = () => ({ elapsedMs: Date.now() - startedAt, phase });
        try {
          const response = await (options.fetcher ?? fetch)(adapter.url, {
            method: "POST", signal: operation?.signal ? AbortSignal.any([operation.signal, controller.signal]) : controller.signal, redirect: "error",
            headers: { ...adapter.headers, "Content-Type": "application/json" }, body,
          });
          phase = "body";
          if (!response.ok) {
            const provider = await providerDiagnostics(response);
            const rateLimited = response.status === 429;
            const quotaExhausted = rateLimited && [
              "insufficient_quota", "billing_hard_limit_reached", "organization_spend_limit_exceeded",
            ].includes(provider.providerCode ?? "");
            const delay = retryDelay(response, rateLimited ? rateLimits + 1 : failures + 1);
            if (rateLimited && !quotaExhausted) {
              provider.providerLimits = Object.fromEntries([
                "retry-after", "x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens",
                "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens",
                "x-ratelimit-remaining-project-tokens", "x-ratelimit-reset-project-tokens",
              ].flatMap(key => {
                const value = response.headers.get(key);
                return value && /^[0-9a-z:,. +\-]{1,64}$/i.test(value) ? [[key, value]] : [];
              }));
              coolDownModel(modelKey, delay, adapter.provider === "openai");
              report({ ...event, ...diagnostics(), ...provider, error: "HTTP_429", retryInMs: delay });
              rateLimits++;
              retryAtTail = true;
              continue;
            }
            failures++;
            if (response.status === 503) coolDownModel(modelKey, delay);
            const recovery = adapter.contextRecovery;
            if (response.status === 400 && recovery && !recoveredContext && provider.inputTokens !== undefined && provider.contextTokens !== undefined && failures < attemptLimit) {
              const required = Math.max(provider.inputTokens + recovery.outputTokens, (contextTokens ?? recovery.initialTokens) + 1);
              const expanded = 2 ** Math.ceil(Math.log2(required));
              if (expanded <= recovery.maxTokens) {
                recoveredContext = true;
                contextTokens = expanded;
                report({ ...event, ...diagnostics(), ...provider, error: `HTTP_${response.status}`, retryInMs: 0 });
                body = JSON.stringify(adapter.body(request, expanded));
                continue;
              }
            }
            if (response.status >= 500 && failures < attemptLimit && delay <= 60000 && (attemptDeadline === undefined || Date.now() + delay < attemptDeadline)) {
              report({ ...event, ...diagnostics(), ...provider, error: `HTTP_${response.status}`, retryInMs: delay });
              clearTimeout(timer);
              lease.finish(chargedTokens);
              await sleep(delay);
              continue;
            }
            report({ ...event, ...diagnostics(), ...provider, error: `HTTP_${response.status}` });
            if (quotaExhausted) {
              const message = provider.providerCode === "organization_spend_limit_exceeded"
                ? "OpenAI 조직의 API 지출 한도에 도달했습니다. 조직의 결제 및 지출 한도를 확인해 주세요."
                : "OpenAI API의 결제 또는 할당량 한도에 도달했습니다. 결제 및 사용 한도를 확인해 주세요.";
              throw new AiError("PROVIDER", message, "QUOTA_EXHAUSTED");
            }
            const guidance = provider.inputTokens !== undefined && provider.contextTokens !== undefined
              ? ` Input uses ${provider.inputTokens} tokens but the active context is ${provider.contextTokens}. Increase OLLAMA_CONTEXT_LENGTH or reduce AI_BATCH_CHARACTERS.`
              : response.status === 503 ? " The provider is temporarily unavailable; retry later or select another model."
              : response.status === 429 ? " Check the provider's request/token quota and retry later." : "";
            const reason = provider.inputTokens !== undefined ? "CONTEXT_LIMIT"
              : response.status === 429 ? "RATE_LIMIT"
              : [401, 403].includes(response.status) ? "AUTH"
              : response.status === 404 ? "MODEL_NOT_FOUND"
              : response.status >= 500 ? "UNAVAILABLE" : undefined;
            throw new AiError("PROVIDER", `LLM request failed (HTTP ${response.status}${provider.providerStatus ? `, ${provider.providerStatus}` : ""}).${guidance}`, reason);
          }
          const responseBody = await response.text();
          phase = "validation";
          let raw: unknown;
          try { raw = JSON.parse(responseBody); }
          catch { throw new AiError("FORMAT", "The provider returned invalid JSON."); }
          if (adapter.provider === "openai" && isRecord(raw)) chargedTokens = usageTokens(raw.usage);
          const result = adapter.output(raw);
          chargedTokens = usageTokens(result.usage);
          let parsed: unknown;
          try { parsed = JSON.parse(result.text); }
          catch { throw new AiError("FORMAT", "The model returned invalid JSON."); }
          const validated = request.schema.parse(parsed);
          report({ ...event, ...diagnostics(), usage: result.usage });
          return validated;
        } catch (error) {
          if (operation?.signal?.aborted) throw new AiError("CANCELLED", "AI 작업을 취소했습니다.");
          const failure = error instanceof AiError ? error : new AiError(
            controller.signal.aborted ? "TIMEOUT" : "CONNECTION",
            controller.signal.aborted ? `LLM request timed out after ${remainingMs} ms while waiting for response ${phase}. Adjust AI_TIMEOUT_MS or reduce AI_BATCH_CHARACTERS.` : "Could not read the LLM response.",
          );
          const formatRetry = failure.code === "FORMAT";
          const delay = formatRetry ? 0 : 2000 + Math.floor(Math.random() * 1000);
          if (failure.code === "PROVIDER" || failure.code === "REFUSAL") throw failure;
          failures++;
          const canRetry = (formatRetry || failure.code === "TIMEOUT" || failure.code === "CONNECTION") && failures < Math.min(attemptLimit, 2)
            && (attemptDeadline === undefined || Date.now() + delay < attemptDeadline);
          report({ ...event, ...diagnostics(), error: failure.code, ...(canRetry ? { retryInMs: delay } : {}) });
          if (canRetry) {
            clearTimeout(timer);
            if (formatRetry) body = JSON.stringify(adapter.body({ ...request,
              instructions: `${request.instructions}\nThe previous response did not match the required JSON schema. Return a complete JSON object satisfying every field, type, enum and length constraint, without markdown or extra fields.`,
            }, contextTokens, true));
            lease.finish(chargedTokens);
            await sleep(delay);
            continue;
          }
          throw failure;
        } finally { clearTimeout(timer); lease.finish(chargedTokens); }
      }
      throw new AiError("CONNECTION", "LLM request failed.");
    },
  };
}
