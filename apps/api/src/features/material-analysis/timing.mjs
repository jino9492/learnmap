import { randomUUID } from "node:crypto";
import { logAiEvent } from "../../ai/core/logging.ts";

export async function measureAnalysisStage(stage, run, report) {
  const stageId = randomUUID();
  logAiEvent({ kind: "timing", stageId, stage, outcome: "started" });
  const startedAt = performance.now();
  let outcome = "failed";
  try {
    const result = await run();
    outcome = "completed";
    return result;
  } finally {
    const event = { kind: "timing", stage, outcome, elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100 };
    logAiEvent({ ...event, stageId });
    report(event);
  }
}
