import type { GenerationRequest } from "./contracts.ts";
import { AiError } from "./errors.ts";

// A conservative character budget, not an assertion about a model's tokenizer.
// Include instructions and the dynamic schema, not just the source text.
export const REQUEST_CHARACTERS = 12000;

export function requestCharacters(request: GenerationRequest<unknown>): number {
  return JSON.stringify({ instructions: request.instructions, data: request.data, schema: request.schema.json }).length + 512;
}

export function partitionRequests<T>(items: T[], build: (items: T[]) => GenerationRequest<unknown>, limit = REQUEST_CHARACTERS): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  for (const item of items) {
    const next = [...batch, item];
    if (batch.length && requestCharacters(build(next)) > limit) {
      batches.push(batch);
      batch = [];
    }
    batch.push(item);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function canSplitFailure(error: unknown): boolean {
  return error instanceof AiError && (error.reason === "CONTEXT_LIMIT" || ["TIMEOUT", "FORMAT"].includes(error.code));
}

// Successful siblings are kept and never rerun while subdividing a failed batch.
// Auth, quota, refusals and semantic failures cannot be fixed by more requests.
export async function runPartition<T, R>(items: T[], run: (items: T[]) => Promise<R>, recover?: (items: T[], error: unknown) => R, depth = 0): Promise<R[]> {
  try { return [await run(items)]; }
  catch (error) {
    if (!canSplitFailure(error) || items.length < 2 || depth >= 8) {
      if (recover) return [recover(items, error)];
      throw error;
    }
    const middle = Math.ceil(items.length / 2);
    const left = await runPartition(items.slice(0, middle), run, recover, depth + 1);
    const right = await runPartition(items.slice(middle), run, recover, depth + 1);
    return [...left, ...right];
  }
}
