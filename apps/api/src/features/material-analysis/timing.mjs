export async function measureAnalysisStage(stage, run, report) {
  const startedAt = performance.now();
  let outcome = "failed";
  try {
    const result = await run();
    outcome = "completed";
    return result;
  } finally {
    report({ kind: "timing", stage, outcome, elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100 });
  }
}
