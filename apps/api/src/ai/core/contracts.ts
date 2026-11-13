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
  stage: "concepts" | "organization" | "relations";
  completed: number;
  total: number;
  detail?: string;
  warning?: boolean;
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
  memberConceptIds?: string[];
  citations?: Citation[];
}

export interface Citation {
  sourceLocation: string;
  evidence: string;
}

export type ConceptMode = "detailed" | "conceptual";

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
  /** IDs of concepts inferred to need review; explanations belong in feedback. */
  weakPoints: string[];
}

export interface Recommendation {
  steps: { conceptId: string; reason: string }[];
  possibleCause: string;
}
