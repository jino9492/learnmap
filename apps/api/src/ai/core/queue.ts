import { AsyncLocalStorage } from "node:async_hooks";
import { AiError, ensure } from "./errors.ts";
import type { LlmClient } from "./contracts.ts";

export interface QueueState { waiting: number; active: number }
type Priority = "interactive" | "graph";
interface Context { signal?: AbortSignal; startedAt: number; priority: Priority; state: QueueState; report: (state: QueueState) => void }
const context = new AsyncLocalStorage<Context>();

// Helpers such as translation inherit the priority of the user operation.
export function scopedAiClient(client: LlmClient, priority: Priority, report: Context["report"] = () => {}, signal?: AbortSignal): LlmClient {
  const scope: Context = { priority, startedAt: Date.now(), signal, state: { waiting: 0, active: 0 }, report };
  return { generate: (request) => context.run(scope, () => client.generate(request)) };
}
export function usageTokens(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  for (const key of ["total_tokens", "totalTokenCount"]) if (valid(usage[key])) return Math.ceil(usage[key]);
  if (valid(usage.input_tokens) && valid(usage.output_tokens)) return Math.ceil(usage.input_tokens + usage.output_tokens);
  return undefined;
}
export interface QueueLimits { tokens: number; requests: number; windowMs: number; concurrency: number; capacity: number }
// Fixed test reference: one full, uncached saved graph (92 calls, 325457 tokens).
export const defaultQueueLimits: QueueLimits = { tokens: 325457, requests: 92, windowMs: 600000, concurrency: 4, capacity: 1000 };
export function queueLimitsFromEnv(env: Record<string, string | undefined>): QueueLimits {
  const names = { tokens: "AI_QUEUE_TOKENS", requests: "AI_QUEUE_REQUESTS", windowMs: "AI_QUEUE_WINDOW_MS", concurrency: "AI_QUEUE_CONCURRENCY", capacity: "AI_QUEUE_CAPACITY" };
  const limits = { ...defaultQueueLimits };
  for (const key of Object.keys(names) as (keyof QueueLimits)[]) {
    if (env[names[key]]?.trim()) limits[key] = Number(env[names[key]]);
    ensure(Number.isSafeInteger(limits[key]) && limits[key] > 0, `${names[key]} must be a positive integer.`, "CONFIG");
  }
  ensure(limits.concurrency <= 512 && limits.windowMs <= 86400000 && limits.capacity <= 10000, "AI queue limits exceed supported bounds.", "CONFIG");
  return limits;
}
export function operationContext() { return context.getStore(); }
export function queueLane(task: string): Priority {
  return context.getStore()?.priority ?? (/^(question_generation|choice_question_review|answer_evaluation|evaluation_diagnosis|evaluation_feedback|evidence_digest|path_recommendation|concept_detail_expansion)$/.test(task) ? "interactive" : "graph");
}

interface Lease { finish: (tokens?: number) => void }
interface Entry {
  estimate: number; pacingFloor?: number; orderGroup: number; modelKey?: string; priority: Priority; enqueuedAt: number; deadlineAt?: number; scope?: Context;
  resolve: (lease: Lease) => void; reject: (error: AiError) => void;
}
interface Charge { at: number; tokens: number }

export class UsageRequestQueue {
  readonly limits: QueueLimits;
  private pending: Entry[] = [];
  private orderGroup = 0;
  private active = 0;
  private reserved = 0;
  private charges: Charge[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private nextStart = 0;
  private nextRequestStart = 0;
  private burstMs: number;
  private paced: boolean;
  constructor(limits: Partial<QueueLimits> = {}, paced = false, burstMs?: number) {
    this.paced = paced;
    this.limits = { ...defaultQueueLimits, ...limits };
    this.burstMs = burstMs ?? Math.min(3000, this.limits.windowMs / 20);
    for (const value of Object.values(this.limits)) ensure(Number.isSafeInteger(value) && value > 0, "Invalid AI queue limit.", "CONFIG");
  }
  snapshot() {
    this.prune();
    const usedTokens = this.charges.reduce((sum, charge) => sum + charge.tokens, 0);
    const pressure = Math.max(usedTokens / this.limits.tokens, this.charges.length / this.limits.requests);
    const concurrency = this.paced ? this.limits.concurrency : Math.max(1, Math.ceil(this.limits.concurrency * (1 - Math.min(1, pressure))));
    return { active: this.active, waiting: this.pending.length, usedTokens, reservedTokens: this.reserved,
      usedRequests: this.charges.length, concurrency, limits: this.limits };
  }
  acquire(estimate: number, task: string, deadlineAt?: number, modelKey?: string, pacingFloor?: number, retryAtTail = false): Promise<Lease> {
    if (this.closed) return Promise.reject(new AiError("CONNECTION", "AI queue has stopped."));
    if (this.pending.length + this.active >= this.limits.capacity) return Promise.reject(new AiError("PROVIDER", "AI 요청이 많이 밀려 있습니다. 잠시 후 다시 시도해 주세요.", "QUEUE_FULL"));
    if (!Number.isFinite(estimate) || estimate <= 0 || estimate > this.limits.tokens) return Promise.reject(new AiError("INPUT", "요청 1건의 예상 토큰이 AI_QUEUE_TOKENS 상한보다 큽니다. 자료 크기를 줄이거나 상한을 조정해 주세요."));
    const scope = context.getStore();
    const priority = queueLane(task);
    return new Promise((resolve, reject) => {
      const signal = scope?.signal;
      // A retry forms a FIFO boundary so priority cannot skip requests already waiting.
      const orderGroup = retryAtTail ? ++this.orderGroup : this.orderGroup;
      if (retryAtTail) this.orderGroup++;
      const entry: Entry = { estimate: Math.ceil(estimate), priority, modelKey, pacingFloor, orderGroup, enqueuedAt: Date.now(), deadlineAt, scope,
        resolve: lease => { cleanup(); resolve(lease); }, reject: error => { cleanup(); reject(error); } };
      const cancel = () => {
        const index = this.pending.indexOf(entry);
        if (index >= 0) {
          this.pending.splice(index, 1);
          this.update(scope, -1, 0);
        }
        entry.reject(new AiError("CANCELLED", "AI 작업을 취소했습니다."));
        this.drain();
      };
      const cleanup = () => signal?.removeEventListener("abort", cancel);
      if (signal?.aborted) { cancel(); return; }
      signal?.addEventListener("abort", cancel, { once: true });
      this.pending.push(entry);
      this.update(scope, 1, 0);
      this.drain();
    });
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const entry of this.pending.splice(0)) {
      this.update(entry.scope, -1, 0);
      entry.reject(new AiError("CONNECTION", "AI queue has stopped."));
    }
  }
  private update(scope: Context | undefined, waiting: number, active: number) {
    if (!scope) return;
    scope.state.waiting += waiting;
    scope.state.active += active;
    scope.report({ ...scope.state });
  }
  private prune() { this.charges = this.charges.filter((charge) => charge.at + this.limits.windowMs > Date.now()); }
  private drain() {
    clearTimeout(this.timer);
    if (this.closed) return;
    const now = Date.now();
    for (const entry of [...this.pending]) {
      if (entry.deadlineAt !== undefined && entry.deadlineAt <= now) {
        this.pending.splice(this.pending.indexOf(entry), 1);
        this.update(entry.scope, -1, 0);
        entry.reject(new AiError("TIMEOUT", "AI 요청 대기 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요."));
      }
    }
    // After 30 seconds a graph request gets equal priority (FIFO ties).
    this.pending.sort((a, b) => a.orderGroup - b.orderGroup || Number(b.priority === "interactive" || now - b.enqueuedAt >= 30000)
      - Number(a.priority === "interactive" || now - a.enqueuedAt >= 30000) || a.enqueuedAt - b.enqueuedAt);
    while (this.pending.length) {
      const state = this.snapshot();
      if (this.active >= state.concurrency || this.charges.length + this.active >= this.limits.requests) break;
      if (Math.max(this.nextStart, this.nextRequestStart) > now + this.burstMs) break;
      const available = this.limits.tokens - state.usedTokens - this.reserved;
      const index = this.pending.findIndex(entry => {
        if (entry.modelKey && modelAvailableAt(entry.modelKey, now) > now) return false;
        return entry.estimate <= available;
      });
      if (index < 0) break;
      // Give older large requests the next replenished budget after bounded bypass.
      const head = this.pending[0];
      if (index > 0 && head.estimate > available && now - head.enqueuedAt >= 30000) break;
      const [entry] = this.pending.splice(index, 1);
      const recovery = entry.modelKey && modelRecovery.get(entry.modelKey);
      if (recovery && recovery.until > now) recovery.next = now + recovery.spacing;
      const requestInterval = Math.ceil(this.limits.windowMs / this.limits.requests);
      const pacingInterval = (tokens: number) => Math.max(requestInterval, Math.ceil(this.limits.windowMs * tokens / this.limits.tokens));
      if (this.paced) {
        this.nextStart = Math.max(now, this.nextStart) + pacingInterval(entry.estimate);
        this.nextRequestStart = Math.max(now, this.nextRequestStart) + requestInterval;
      }
      this.active++;
      this.reserved += entry.estimate;
      this.update(entry.scope, -1, 1);
      let finished = false;
      entry.resolve({ finish: (tokens) => {
        if (finished) return;
        finished = true;
        this.active--;
        this.reserved -= entry.estimate;
        // Failed/missing-usage attempts keep the conservative reservation.
        const actual = tokens !== undefined && Number.isFinite(tokens) && tokens >= 0 ? Math.ceil(tokens) : undefined;
        const finishedAt = Date.now();
        this.charges.push({ at: finishedAt, tokens: actual ?? entry.estimate });
        if (this.paced && entry.pacingFloor !== undefined && actual !== undefined) {
          const delta = pacingInterval(Math.max(actual, entry.pacingFloor)) - pacingInterval(entry.estimate);
          // Refund only outstanding pacing debt. Idle time never banks a future burst.
          this.nextStart = Math.max(finishedAt, this.nextStart + delta);
        }
        this.update(entry.scope, 0, -1);
        this.drain();
      } });
    }
    if (this.pending.length) {
      const wakeups = this.pending.flatMap((entry) => entry.deadlineAt === undefined ? [] : [entry.deadlineAt]);
      const resume = Math.max(this.nextStart, this.nextRequestStart) - this.burstMs;
      if (resume > now) wakeups.push(resume);
      for (const entry of this.pending) {
        const until = entry.modelKey && modelAvailableAt(entry.modelKey, now);
        if (until && until > now) wakeups.push(until);
      }
      wakeups.push(...this.charges.map((charge) => charge.at + this.limits.windowMs));
      if (wakeups.length) this.timer = setTimeout(() => this.drain(), Math.min(2147483647, Math.max(1, Math.min(...wakeups) - Date.now())));
    }
  }
}
const modelCooldowns = new Map<string, number>();
const modelRecovery = new Map<string, { until: number; next: number; spacing: number }>();

function modelAvailableAt(key: string, now: number) {
  const recovery = modelRecovery.get(key);
  return Math.max(modelCooldowns.get(key) ?? 0, recovery && recovery.until > now ? recovery.next : 0);
}

export function coolDownModel(key: string, ms: number, spreadRestarts = false) {
  const now = Date.now();
  const resume = Math.max(modelCooldowns.get(key) ?? 0, now + ms);
  modelCooldowns.set(key, resume);
  if (spreadRestarts) {
    const prior = modelRecovery.get(key);
    // Space starts across both queues after rate limiting. Concurrent 429s
    // from requests already in flight should not double the interval each time.
    const spacing = prior && prior.until > now
      ? Math.min(2000, prior.next <= now ? prior.spacing * 2 : prior.spacing)
      : 500;
    modelRecovery.set(key, { until: resume + 60000, next: resume, spacing });
  }
}

type Env = Record<string, string | undefined>;

export function measuredCloudProfile(env: Env) {
  return env.AI_QUEUE_PROFILE?.trim() === "learnmap-cloud"
    && (env.AI_PROVIDER?.trim().toLowerCase() || "openai") === "openai"
    && env.OPENAI_MODEL?.trim() === "gpt-6.1-sol" && env.OPENAI_FAST_MODEL?.trim() === "gpt-6-luna";
}

export function createAiQueues(env: Env) {
  const measured = measuredCloudProfile(env);
  const local = env.AI_PROVIDER?.trim().toLowerCase() === "ollama";
  // Split the lower observed model quota (4M TPM, 10k RPM) with 20% headroom,
  // even if graph helpers and user operations share the same provider quota.
  function lane(name: Priority) {
    const graph = name === "graph";
    const share = graph ? 0.4 : 0.6;
    const defaults: QueueLimits = {
      tokens: measured ? 3200000 * share : defaultQueueLimits.tokens * share,
      requests: measured ? 8000 * share : defaultQueueLimits.requests * share,
      concurrency: measured ? (graph ? 64 : 192) : local ? 1 : 2,
      capacity: graph ? 400 : 600, windowMs: measured ? 60000 : 600000,
    };
    const config: Env = {};
    for (const [field, value] of Object.entries(defaults)) {
      const suffix = field === "windowMs" ? "WINDOW_MS" : field.toUpperCase();
      const legacy = env["AI_QUEUE_" + suffix]?.trim();
      let fallback = Math.floor(value);
      if (legacy) {
        const total = Number(legacy);
        ensure(Number.isSafeInteger(total) && total > 0, "Invalid AI_QUEUE_" + suffix, "CONFIG");
        if (field === "windowMs") fallback = total;
        else {
          ensure(total >= 2, "Shared AI_QUEUE_" + suffix + " needs at least two units for two queues.", "CONFIG");
          const graphShare = Math.max(1, Math.floor(total * 0.4));
          fallback = graph ? graphShare : total - graphShare;
        }
      }
      config["AI_QUEUE_" + suffix] = env["AI_" + name.toUpperCase() + "_QUEUE_" + suffix]?.trim() || String(fallback);
    }
    const limits = queueLimitsFromEnv(config);
    if (!measured || !graph) return new UsageRequestQueue(limits, measured);
    const burstMs = env.AI_GRAPH_QUEUE_BURST_MS?.trim() ? Number(env.AI_GRAPH_QUEUE_BURST_MS) : 6000;
    ensure(Number.isInteger(burstMs) && burstMs >= 0 && burstMs <= 6000, "AI_GRAPH_QUEUE_BURST_MS must be an integer from 0 to 6000.", "CONFIG");
    return new UsageRequestQueue(limits, true, Math.min(burstMs, limits.windowMs / 10));
  }
  // A legacy one-slot deployment intentionally serializes both workloads.
  if (["CONCURRENCY", "TOKENS", "REQUESTS", "CAPACITY"].some(key => Number(env["AI_QUEUE_" + key]) === 1)) {
    const shared = new UsageRequestQueue(queueLimitsFromEnv(env));
    return { graph: shared, interactive: shared };
  }
  const graph = lane("graph");
  const interactive = lane("interactive");
  if (measured) {
    for (const [field, maximum] of [["tokens", 3200000], ["requests", 8000]] as const) {
      const perMinute = (q: UsageRequestQueue) => q.limits[field] * 60000 / q.limits.windowMs;
      ensure(perMinute(graph) + perMinute(interactive) <= maximum, "Combined AI queues exceed the measured " + field + " budget.", "CONFIG");
    }
  }
  return { graph, interactive };
}
export const aiQueues = createAiQueues(process.env);
