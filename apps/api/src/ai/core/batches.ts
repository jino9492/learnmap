import { ensure } from "./errors.ts";

export interface BatchOptions {
  concurrency?: number;
}

export function validateConcurrency(value = 1): number {
  ensure(Number.isInteger(value) && value >= 1 && value <= 4, "AI_CONCURRENCY must be an integer from 1 to 4.", "CONFIG");
  return value;
}

export async function mapBatches<T, R>(items: T[], concurrency: number | undefined, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const limit = validateConcurrency(concurrency);
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let failed = false;
  async function worker() {
    while (!failed && cursor < items.length) {
      const index = cursor++;
      try { results[index] = await run(items[index], index); }
      catch (error) { failed = true; throw error; }
    }
  }
  // Drain active requests before returning a failure so they cannot outlive the stage.
  const workers = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker));
  for (const worker of workers) if (worker.status === "rejected") throw worker.reason;
  return results;
}
