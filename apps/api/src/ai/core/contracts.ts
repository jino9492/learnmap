import type { Schema } from "./schema.ts";

export interface GenerationRequest<T> {
  name: string;
  instructions: string;
  data: unknown;
  schema: Schema<T>;
}

export interface LlmClient {
  generate<T>(request: GenerationRequest<T>): Promise<T>;
}

export interface AnalysisProgress {
  stage: "concepts" | "relations";
  completed: number;
  total: number;
  detail?: string;
}

export interface Source {
  location: string;
  text: string;
}

export interface Material {
  id: string;
  title: string;
  sources: Source[];
}

export interface Concept {
  id: string;
  name: string;
  description: string;
  sourceLocation: string;
  evidence: string;
}

export interface Relation {
  source: string;
  target: string;
  type: "PARENT_CHILD" | "PREREQUISITE" | "RELATED";
  reason: string;
}

export interface Graph {
  concepts: Concept[];
  relations: Relation[];
}

export type QuestionType = "MULTIPLE_CHOICE" | "SHORT_ANSWER" | "ESSAY";
export interface Question {
  type: QuestionType;
  question: string;
  options: string[];
  referenceAnswer: string;
  evaluationCriteria: string[];
}

export interface Evaluation {
  score: number;
  feedback: string;
  weakPoints: string[];
}

export interface Recommendation {
  steps: { conceptId: string; reason: string }[];
  possibleCause: string;
}
