import type { Concept, Evaluation, Material, Question, QuestionType, Recommendation, Relation } from "./contracts.ts";
import { boundedText, choice, list, object, optional, score, text } from "./schema.ts";

export const materialSchema = object<Material>({
  id: text, title: text,
  sources: list(object({ location: text, text }), 1, Infinity),
});
const conceptSchema = object<Concept>({
  id: text, name: text, description: text, sourceLocation: text, evidence: text,
  memberConceptIds: optional(list(text, 1, Infinity)),
  citations: optional(list(object({ sourceLocation: text, evidence: text }), 1, Infinity)),
});
export const conceptsSchema = object<{ concepts: Concept[] }>({
  concepts: list(conceptSchema, 0, 15),
});
export function conceptGenerationSchema(evidenceIds: string[]) {
  return object<{ concepts: Concept[] }>({
    concepts: list(object<Concept>({
      id: text, name: text, description: text, sourceLocation: text, evidence: choice(...evidenceIds),
    }), 0, 15),
  });
}
export const conceptCollectionSchema = object<{ concepts: Concept[] }>({ concepts: list(conceptSchema, 1, Infinity) });
export interface ConceptGroup {
  name: string;
  description: string;
  memberIds: string[];
}
export function conceptOrganizationSchema(memberIds: string[]) {
  return object<{ groups: ConceptGroup[] }>({
    groups: list(object<ConceptGroup>({ name: text, description: text, memberIds: list(choice(...memberIds), 1, memberIds.length) }), 0, memberIds.length),
  });
}
const relationSchema = object<Relation>({ source: text, target: text, type: choice("PARENT_CHILD", "PREREQUISITE", "RELATED"), reason: text });
export function relationGenerationSchema(conceptIds: string[]) {
  return object<{ relations: Relation[] }>({
    relations: list(object<Relation>({
      source: choice(...conceptIds), target: choice(...conceptIds),
      type: choice("PARENT_CHILD", "PREREQUISITE", "RELATED"), reason: text,
    }), 0, 30),
  });
}
export const relationCollectionSchema = object<{ relations: Relation[] }>({ relations: list(relationSchema, 0, Infinity) });
export const questionSchema = object<Question>({
  type: choice("MULTIPLE_CHOICE", "SHORT_ANSWER", "ESSAY"), question: text,
  options: list(text, 0, 4), referenceAnswer: text, evaluationCriteria: list(text, 1, 6),
});
export function questionGenerationSchema(type: QuestionType) {
  return object<Question>({
    type: choice(type), question: text,
    options: list(text, type === "MULTIPLE_CHOICE" ? 4 : 0, type === "MULTIPLE_CHOICE" ? 4 : 0),
    referenceAnswer: text, evaluationCriteria: list(text, 1, 6),
  });
}
export const evaluationSchema = object<Evaluation>({ score, feedback: text, weakPoints: list(text, 0, 10) });
export const evaluationFeedbackSchema = object<{ feedback: string }>({ feedback: boundedText(1600) });
export function evaluationGenerationSchema(conceptIds: string[], feedbackCharacters = 12000) {
  return object<Evaluation>({ score, feedback: boundedText(feedbackCharacters), weakPoints: list(choice(...conceptIds), 0, 10) });
}
export const recommendationSchema = object<Recommendation>({
  steps: list(object({ conceptId: text, reason: text }), 1, Infinity), possibleCause: text,
});

export function recommendationGenerationSchema(conceptIds: string[]) {
  return object<Recommendation>({
    steps: list(object({ conceptId: choice(...conceptIds), reason: text }), conceptIds.length, conceptIds.length),
    possibleCause: text,
  });
}
