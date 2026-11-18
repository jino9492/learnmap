export interface AnalysisEvent {
  kind: string;
  stage?: string;
  outcome?: string;
  completed?: number;
  total?: number;
}

export function analysisProgress(job: {
  status: string;
  mode?: string;
  events?: AnalysisEvent[];
  queueState?: { waiting: number; active: number };
}): {
  stage: string;
  label: string;
  percent: number;
  waiting: boolean;
  completed?: number;
  total?: number;
};
