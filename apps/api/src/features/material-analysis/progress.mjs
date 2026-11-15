// Percentages describe completed pipeline work, not elapsed time.
export function analysisProgress(job) {
  const stages = [
    ["queued", "대기 중", 0, 0],
    ["extracting_text", "자료 읽기", 0, 5],
    ["extracting_concepts", "개념 추출", 5, job.mode === "conceptual" ? 40 : 55, "concepts"],
    ["organizing_concepts", "핵심 개념 정리", 40, 55, "organization"],
    ["analyzing_relations", "개념 관계 분석·검증", 55, 80, "relations"],
    ["localizing", "한국어 설명 정리", 80, 90, "localization"],
    ["linking_subject", "다른 자료와 연결·검증", 90, 98, "relations"],
    ["saving", "학습 지도 저장", 99, 99],
    ["ready", "완료", 100, 100],
  ];
  const events = job.events ?? [];
  // A failed job retains the last known progress instead of appearing complete.
  const failedStage = events.findLast((event) => event.kind === "timing" && event.outcome === "failed" && event.stage !== "analysis")?.stage;
  let status = job.status === "failed"
    ? ({ text: "extracting_text", concepts: "extracting_concepts", organization: "organizing_concepts", relations: "analyzing_relations", localization: "localizing", subject_relations: "linking_subject" }[failedStage] ?? "queued")
    : job.status;
  // Older running servers reuse this status for cross-material analysis.
  if (status === "analyzing_relations" && events.some((event) => event.kind === "timing" && event.stage === "localization" && event.outcome === "completed")) {
    status = "linking_subject";
  }
  const [stage, label, start, end, eventStage] = stages.find(([stage]) => stage === status) ?? stages[0];
  const offset = stage === "linking_subject"
    ? events.findLastIndex((event) => event.kind === "timing" && event.stage === "localization" && event.outcome === "completed") + 1
    : 0;
  const progress = eventStage ? events.slice(offset).filter((event) => event.kind === "progress" && event.stage === eventStage && event.total > 0) : [];
  const latest = progress.at(-1);
  // Rounds and adaptive batches can reset their counters. Never move backwards.
  const fraction = progress.reduce((maximum, event) => Math.max(maximum, Math.min(1, Math.max(0, event.completed / event.total))), 0);
  return {
    stage, label: job.status === "failed" ? `${label} 중단` : label,
    percent: Math.floor(start + (end - start) * fraction),
    ...(latest ? { completed: latest.completed, total: latest.total } : {}),
  };
}
