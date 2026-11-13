import type { Concept, LlmClient, Material, Question } from "../core/contracts.ts";
import { ensure } from "../core/errors.ts";
import { prompts } from "../core/prompts.ts";
import { evaluationSchema } from "../core/schemas.ts";
import { questionContext, validateQuestion } from "../question-generation/index.ts";

export async function evaluateAnswer(client: LlmClient, concept: Concept, material: Material, input: Question, answer: string) {
  const context = questionContext(concept, material);
  const question = validateQuestion(input);
  ensure(typeof answer === "string" && answer.trim().length > 0 && answer.length <= 8000, "Answer must contain 1-8,000 characters.", "INPUT");
  if (question.type === "MULTIPLE_CHOICE") {
    ensure(question.options.includes(answer), "Select one of the question options.", "INPUT");
    const isCorrect = answer === question.referenceAnswer;
    return {
      score: isCorrect ? 100 : 0,
      feedback: isCorrect ? "정답입니다." : `정답: ${question.referenceAnswer}`,
      weakPoints: isCorrect ? [] : [`${concept.name.slice(0, 500)}: 이 문항에서 정답을 선택하지 못했습니다. 구체적인 오개념의 원인은 선택 결과만으로 단정할 수 없습니다.`],
    };
  }
  const result = evaluationSchema.parse(await client.generate({ name: "answer_evaluation", instructions: prompts.evaluation, data: { ...context, question, answer }, schema: evaluationSchema }));
  ensure(result.score !== 100 || result.weakPoints.length === 0, "Full credit is inconsistent with missing criteria.");
  return result;
}
