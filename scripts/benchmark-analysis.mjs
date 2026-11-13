import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { extractConcepts, analyzeRelations } from "../apps/api/src/ai/index.ts";
import { createAnalysisCache } from "../apps/api/src/features/material-analysis/cache.mjs";

// Fixed artificial latency measures orchestration overhead, not real model performance.
const material = {
  id: "benchmark", title: "한국어 및 영어 개념 분석 실험",
  sources: Array.from({ length: 8 }, (_, index) => ({ location: `page:${index + 1}`, text: `${index % 2 ? "A learning concept." : "학습 개념을 설명합니다."} `.padEnd(1100, "x") })),
};
let calls = 0;
const client = { async generate(request) {
  calls++;
  await delay(30);
  if (request.name === "concept_extraction") {
    const source = request.data.sources[0];
    return { concepts: [1, 2, 3].map((id) => ({ id: `c${id}`, name: `개념 ${id}`, description: "출처를 바탕으로 한 설명입니다.", sourceLocation: source.location, evidence: source.excerpts[0].id })) };
  }
  return { relations: request.data.concepts.slice(1).map((concept, index) => ({ source: request.data.concepts[index].id, target: concept.id, type: "PREREQUISITE", reason: "앞선 개념을 이해해야 합니다." })) };
} };

async function pipeline(concurrency, cache) {
  const stage = (name, input, run) => cache ? cache.run([name, input], run) : run();
  const concepts = await stage("concepts", material, () => extractConcepts(client, material, undefined, { concurrency, batchCharacters: 1200 }));
  const relations = await stage("relations", concepts, () => analyzeRelations(client, material, concepts, undefined, { concurrency }));
  return { concepts, relations };
}

let reference;
async function measure(name, run, repetitions = 5) {
  const times = [];
  const requests = [];
  for (let round = 0; round < repetitions; round++) {
    const before = calls;
    const startedAt = performance.now();
    const result = await run();
    times.push(performance.now() - startedAt);
    requests.push(calls - before);
    if (!reference) reference = result;
    else assert.deepEqual(result, reference);
  }
  times.sort((a, b) => a - b);
  return { scenario: name, repetitions, medianMs: +times[Math.floor(times.length / 2)].toFixed(2), maxMs: +times.at(-1).toFixed(2), requests };
}

const sequential = await measure("sequential", () => pipeline(1));
const parallel = await measure("concurrency-2", () => pipeline(2));
const cache = createAnalysisCache();
await pipeline(2, cache);
const cached = await measure("warm-cache", () => pipeline(2, cache));
const sharedCache = createAnalysisCache();
const beforeShared = calls;
const [first, second] = await Promise.all([pipeline(2, sharedCache), pipeline(2, sharedCache)]);
assert.deepEqual(first, reference);
assert.deepEqual(second, reference);
process.stdout.write(`${JSON.stringify({ artificialRequestDelayMs: 30, sources: 8, concepts: reference.concepts.length, results: [sequential, parallel, cached], parallelSpeedup: +(sequential.medianMs / parallel.medianMs).toFixed(2), duplicateConcurrentRequests: calls - beforeShared, identicalOutputs: true }, null, 2)}\n`);
