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
}): {
  stage: string;
  label: string;
  percent: number;
  completed?: number;
  total?: number;
};
