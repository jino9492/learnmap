import type { Concept, LlmClient, Material, Question, QuestionType } from "../core/contracts.ts";
import { ensure } from "../core/errors.ts";
import { prompts } from "../core/prompts.ts";
import { conceptsSchema, questionSchema } from "../core/schemas.ts";
import { validateMaterial } from "../concept-extraction/index.ts";

export function questionContext(concept: Concept, input: Material) {
  const material = validateMaterial(input);
  conceptsSchema.parse({ concepts: [concept] });
  const source = material.sources.find((entry) => entry.location === concept.sourceLocation);
  ensure(source?.text.includes(concept.evidence), "Concept is not grounded in this material.", "INPUT");
  return { concept, source };
}

export function validateQuestion(input: unknown): Question {
  const question = questionSchema.parse(input);
  if (question.type === "MULTIPLE_CHOICE") {
    ensure(question.options.length === 4 && new Set(question.options.map((option) => option.trim())).size === 4, "Multiple-choice questions require four distinct options.");
    ensure(question.options.includes(question.referenceAnswer), "Correct answer must match an option.");
  } else ensure(question.options.length === 0, "Written questions must not have options.");
  return question;
}

export async function generateQuestion(client: LlmClient, concept: Concept, material: Material, type: QuestionType = "SHORT_ANSWER", difficulty: "EASY" | "MEDIUM" | "HARD" = "MEDIUM") {
  const context = questionContext(concept, material);
  ensure(["MULTIPLE_CHOICE", "SHORT_ANSWER", "ESSAY"].includes(type) && ["EASY", "MEDIUM", "HARD"].includes(difficulty), "Invalid question settings.", "INPUT");
  const question = validateQuestion(await client.generate({ name: "question_generation", instructions: prompts.question, data: { ...context, type, difficulty }, schema: questionSchema }));
  ensure(question.type === type, "Generated question type differs from the requested type.");
  return question;
}

export function publicQuestion(question: Question) {
  const { type, question: prompt, options } = validateQuestion(question);
  return { type, question: prompt, options };
}
