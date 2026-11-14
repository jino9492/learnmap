import type { Concept, LlmClient, Material, Question, QuestionType } from "../core/contracts.ts";
import { ensure } from "../core/errors.ts";
import { prompts } from "../core/prompts.ts";
import { conceptsSchema, questionSchema, questionGenerationSchema } from "../core/schemas.ts";
import { choice, list, object, text } from "../core/schema.ts";
import { validateMaterial } from "../concept-extraction/index.ts";
import { conceptCitations, conceptSummary } from "../../features/material-analysis/index.ts";
import { prepareQuestionContext } from "./context.ts";
export { prepareQuestionContext } from "./context.ts";

export function questionContext(concept: Concept, input: Material) {
  const material = validateMaterial(input);
  conceptsSchema.parse({ concepts: [concept] });
  const source = material.sources.find((entry) => entry.location === concept.sourceLocation);
  ensure(source?.text.includes(concept.evidence), "Concept is not grounded in this material.", "INPUT");
  // Send grounded excerpts, never a full page or internal membership/citation arrays.
  const citations = conceptCitations(concept, material);
  const summary = conceptSummary(concept);
  return { concept: summary, source: { location: concept.sourceLocation, text: concept.evidence },
    sources: citations.filter((citation) => citation.sourceLocation !== concept.sourceLocation || citation.evidence !== concept.evidence)
      .map((citation) => ({ location: citation.sourceLocation, text: citation.evidence })),
  };
}

export function validateQuestion(input: unknown): Question {
  const question = questionSchema.parse(input);
  if (question.type === "MULTIPLE_CHOICE") {
    ensure(question.options.length === 4 && new Set(question.options.map((option) => option.trim())).size === 4, "Multiple-choice questions require four distinct options.");
    ensure(question.options.includes(question.referenceAnswer), "Correct answer must match an option.");
  } else ensure(question.options.length === 0, "Written questions must not have options.");
  return question;
}

export async function reviewChoiceQuestion(client: LlmClient, concept: Concept, material: Material, input: Question) {
  const question = validateQuestion(input);
  if (question.type !== "MULTIPLE_CHOICE") return;
  const schema = object({ acceptableOptions: list(choice(...question.options), 0, 4), explanation: text });
  questionContext(concept, material);
  const context = await prepareQuestionContext(client, concept, material, publicQuestion(question));
  // Do not reveal the answer key or learner selection to the reviewer.
  const review = schema.parse(await client.generate({ name: "choice_question_review", instructions: prompts.choiceReview,
    data: { ...context, question: publicQuestion(question) }, schema }));
  ensure(review.acceptableOptions.length === 1 && review.acceptableOptions[0] === question.referenceAnswer,
    "정답이 하나로 확인되지 않거나 저장된 정답과 일치하지 않는 문항입니다. 학습 평가에 반영하지 않았습니다. 문제를 다시 생성해 주세요.");
}

export async function generateQuestion(client: LlmClient, concept: Concept, material: Material, type: QuestionType = "SHORT_ANSWER", difficulty: "EASY" | "MEDIUM" | "HARD" = "MEDIUM") {
  questionContext(concept, material);
  ensure(["MULTIPLE_CHOICE", "SHORT_ANSWER", "ESSAY"].includes(type) && ["EASY", "MEDIUM", "HARD"].includes(difficulty), "Invalid question settings.", "INPUT");
  const context = await prepareQuestionContext(client, concept, material);
  const question = validateQuestion(await client.generate({ name: "question_generation", instructions: prompts.question, data: { ...context, type, difficulty }, schema: questionGenerationSchema(type) }));
  ensure(question.type === type, "Generated question type differs from the requested type.");
  await reviewChoiceQuestion(client, concept, material, question);
  return question;
}

export function publicQuestion(question: Question) {
  const { type, question: prompt, options } = validateQuestion(question);
  return { type, question: prompt, options };
}
