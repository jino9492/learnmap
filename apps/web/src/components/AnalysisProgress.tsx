import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { analysisProgress } from "../../../api/src/features/material-analysis/progress.mjs";
import { request, type Material } from "../utils/api";

const analysisStateSchema = z.object({
  status: z.string(),
  mode: z.string().optional(),
  queueState: z.object({ waiting: z.number(), active: z.number() }).optional(),
  events: z.array(
    z.object({
      kind: z.string(),
      stage: z.string().optional(),
      outcome: z.string().optional(),
      completed: z.number().optional(),
      total: z.number().optional(),
    }),
  ),
});

export const AnalysisProgress = ({ material }: { material: Material }) => {
  // An already-running API may predate the progress field. Its analysis log
  // still provides live counters without restarting or interrupting the job.
  const query = useQuery({
    queryKey: ["analysis-progress", material.id],
    queryFn: () =>
      request(
        `/api/analyses/${encodeURIComponent(material.id)}`,
        analysisStateSchema,
      ),
    enabled: !material.analysisProgress,
    refetchInterval: (query) =>
      ["ready", "failed"].includes(query.state.data?.status ?? "")
        ? false
        : 1500,
    retry: 1,
  });
  const progress =
    material.analysisProgress ??
    (query.data ? analysisProgress(query.data) : undefined);
  const label =
    progress?.label ?? analysisProgress({ status: material.status }).label;
  return (
    <li>
      <span>
        {material.title} · {label}
        {progress?.total
          ? ` · ${progress.completed}/${progress.total}묶음 처리`
          : ""}
      </span>
      <progress
        aria-label={`${material.title} 분석 진행률`}
        max={100}
        value={progress?.percent}
      />
      <span role="status">
        {query.isError && !material.analysisProgress
          ? "진행 상태 연결 지연 · 다시 확인 중"
          : progress
            ? `${progress.percent}%`
            : "진행률 확인 중"}
      </span>
    </li>
  );
};
