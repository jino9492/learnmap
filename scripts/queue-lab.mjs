import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createAiQueues, queueLane, scopedAiClient } from "../apps/api/src/ai/core/queue.ts";

const { values } = parseArgs({ options: {
  current: { type: "boolean" }, graph: { type: "string", default: "12" },
  interactive: { type: "string", default: "24" }, "latency-ms": { type: "string", default: "600" },
  tokens: { type: "string", default: "1200" },
} });
function number(key, min, max) {
  const value = Number(values[key]);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw Error(`${key}: ${min}~${max} 정수를 입력하세요.`);
  return value;
}
const counts = { graph: number("graph", 0, 5000), interactive: number("interactive", 0, 5000) };
const latency = number("latency-ms", 1, 60000);
const tokens = number("tokens", 1, 1000000);
const env = values.current ? process.env : {
  AI_GRAPH_QUEUE_CONCURRENCY: "2", AI_INTERACTIVE_QUEUE_CONCURRENCY: "6",
  AI_GRAPH_QUEUE_REQUESTS: "6", AI_INTERACTIVE_QUEUE_REQUESTS: "18",
  AI_GRAPH_QUEUE_TOKENS: "60000", AI_INTERACTIVE_QUEUE_TOKENS: "120000",
  AI_GRAPH_QUEUE_WINDOW_MS: "2000", AI_INTERACTIVE_QUEUE_WINDOW_MS: "2000",
};
const queues = createAiQueues(env);
console.log(values.current ? "현재 서버 설정 · 모의 AI" : "2초 창 실험 · 모의 AI");
console.table(Object.fromEntries(Object.entries(queues).map(([name, q]) => [name, q.limits])));
const started = performance.now();
const report = () => {
  const summary = Object.entries(queues).map(([name, q]) => {
    const s = q.snapshot();
    return `${name} 실행 ${s.active} / 대기 ${s.waiting} / 사용 ${s.usedTokens} / 예약 ${s.reservedTokens}`;
  });
  console.log(`${((performance.now() - started) / 1000).toFixed(1)}s  ${summary.join("  |  ")}`);
};
const interval = setInterval(report, 500);
async function runLane(name, count) {
  const q = queues[name];
  const deadline = Date.now() + 120000;
  const waits = [];
  const failures = {};
  let peak = 0;
  const client = scopedAiClient({ async generate(req) {
    const queued = performance.now();
    const lease = await queues[queueLane(req.name)].acquire(tokens + 6000, req.name, deadline);
    waits.push(performance.now() - queued);
    peak = Math.max(peak, q.snapshot().active);
    try { await delay(latency); } finally { lease.finish(tokens); }
  } }, name);
  await Promise.all(Array.from({ length: count }, async () => {
    try { await client.generate({ name: name === "graph" ? "relation_analysis" : "question_generation" }); }
    catch (error) {
      const code = error.reason ?? error.code;
      if (!code) throw error;
      failures[code] = (failures[code] ?? 0) + 1;
    }
  }));
  waits.sort((a, b) => a - b);
  return { queue: name, submitted: count, completed: waits.length, peak,
    waitP95ms: Math.round(waits[Math.ceil(waits.length * 0.95) - 1] ?? 0),
    failures: JSON.stringify(failures) };
}
try {
  const results = await Promise.all(Object.entries(counts).map(([name, count]) => runLane(name, count)));
  report();
  console.table(results);
} finally {
  clearInterval(interval);
  for (const q of Object.values(queues)) q.close();
}
