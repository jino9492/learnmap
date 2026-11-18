import { AsyncLocalStorage } from "node:async_hooks";
import { AiError, ensure } from "./errors.ts";
import type { LlmClient } from "./contracts.ts";

export interface QueueState { waiting: number; active: number }
type Priority = "interactive" | "graph";
interface Context { priority: Priority; state: QueueState; report: (state: QueueState) => void }
const context = new AsyncLocalStorage<Context>();

// Helpers such as translation inherit the priority of the user operation.
export function scopedAiClient(client: LlmClient, priority: Priority, report: Context["report"] = () => {}): LlmClient {
  const scope: Context = { priority, state: { waiting: 0, active: 0 }, report };
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
  ensure(limits.concurrency <= 16 && limits.windowMs <= 86400000 && limits.capacity <= 10000, "AI queue limits exceed supported bounds.", "CONFIG");
  return limits;
}
interface Lease { finish: (tokens?: number) => void }
interface Entry {
  estimate: number; priority: Priority; enqueuedAt: number; deadlineAt?: number; scope?: Context;
  resolve: (lease: Lease) => void; reject: (error: AiError) => void;
}
interface Charge { at: number; tokens: number }

export class UsageRequestQueue {
  readonly limits: QueueLimits;
  private pending: Entry[] = [];
  private active = 0;
  private reserved = 0;
  private charges: Charge[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(limits: Partial<QueueLimits> = {}) {
    this.limits = { ...defaultQueueLimits, ...limits };
    for (const value of Object.values(this.limits)) ensure(Number.isSafeInteger(value) && value > 0, "Invalid AI queue limit.", "CONFIG");
  }
  snapshot() {
    this.prune();
    const usedTokens = this.charges.reduce((sum, charge) => sum + charge.tokens, 0);
    const pressure = Math.max(usedTokens / this.limits.tokens, this.charges.length / this.limits.requests);
    const concurrency = Math.max(1, Math.ceil(this.limits.concurrency * (1 - Math.min(1, pressure))));
    return { active: this.active, waiting: this.pending.length, usedTokens, reservedTokens: this.reserved,
      usedRequests: this.charges.length, concurrency, limits: this.limits };
  }
  acquire(estimate: number, task: string, deadlineAt?: number): Promise<Lease> {
    if (this.closed) return Promise.reject(new AiError("CONNECTION", "AI queue has stopped."));
    if (this.pending.length + this.active >= this.limits.capacity) return Promise.reject(new AiError("PROVIDER", "AI request queue is full. Retry later.", "UNAVAILABLE"));
    if (!Number.isFinite(estimate) || estimate <= 0 || estimate > this.limits.tokens) return Promise.reject(new AiError("INPUT", "요청 1건의 예상 토큰이 AI_QUEUE_TOKENS 상한보다 큽니다. 자료 크기를 줄이거나 상한을 조정해 주세요."));
    const scope = context.getStore();
    const priority = scope?.priority ?? (/^(question_generation|choice_question_review|answer_evaluation|evaluation_feedback|evidence_digest|path_recommendation|concept_detail_expansion)$/.test(task) ? "interactive" : "graph");
    return new Promise((resolve, reject) => {
      this.pending.push({ estimate: Math.ceil(estimate), priority, enqueuedAt: Date.now(), deadlineAt, scope, resolve, reject });
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
        entry.reject(new AiError("TIMEOUT", "The analysis deadline was reached while waiting in the AI request queue."));
      }
    }
    // After 30 seconds a graph request gets equal priority (FIFO ties).
    this.pending.sort((a, b) => Number(b.priority === "interactive" || now - b.enqueuedAt >= 30000)
      - Number(a.priority === "interactive" || now - a.enqueuedAt >= 30000) || a.enqueuedAt - b.enqueuedAt);
    while (this.pending.length) {
      const state = this.snapshot();
      if (this.active >= state.concurrency || this.charges.length + this.active >= this.limits.requests) break;
      const entry = this.pending[0];
      if (state.usedTokens + this.reserved + entry.estimate > this.limits.tokens) break;
      this.pending.shift();
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
        this.charges.push({ at: Date.now(), tokens: tokens !== undefined && Number.isFinite(tokens) && tokens >= 0 ? Math.ceil(tokens) : entry.estimate });
        this.update(entry.scope, 0, -1);
        this.drain();
      } });
    }
    if (this.pending.length) {
      const wakeups = this.pending.flatMap((entry) => entry.deadlineAt === undefined ? [] : [entry.deadlineAt]);
      wakeups.push(...this.charges.map((charge) => charge.at + this.limits.windowMs));
      if (wakeups.length) this.timer = setTimeout(() => this.drain(), Math.max(1, Math.min(...wakeups) - Date.now()));
    }
  }
}
export const aiRequestQueue = new UsageRequestQueue(queueLimitsFromEnv(process.env));
