import type { Concept, Graph, LlmClient, Material, Question } from "../core/contracts.ts";
import { ensure } from "../core/errors.ts";
import { prompts } from "../core/prompts.ts";
import { evaluationGenerationSchema } from "../core/schemas.ts";
import { questionContext, reviewChoiceQuestion, validateQuestion } from "../question-generation/index.ts";
import { validateGraph } from "../../features/knowledge-graph/index.ts";

export async function evaluateAnswer(client: LlmClient, concept: Concept, material: Material, input: Question, answer: string, graph: Graph = { concepts: [concept], relations: [] }) {
  const context = questionContext(concept, material);
  const question = validateQuestion(input);
  ensure(typeof answer === "string" && answer.trim().length > 0 && answer.length <= 8000, "Answer must contain 1-8,000 characters.", "INPUT");
  if (question.type === "MULTIPLE_CHOICE") {
    ensure(question.options.includes(answer), "Select one of the question options.", "INPUT");
    if (answer === question.referenceAnswer) return { score: 100, feedback: "정답입니다.", weakPoints: [] };
  }
  validateGraph(graph);
  ensure(graph.concepts.some((entry) => entry.id === concept.id), "Unknown evaluation concept.", "INPUT");
  const relations = graph.relations.filter((relation) => relation.source === concept.id || relation.target === concept.id);
  const connectedIds = new Set(relations.flatMap((relation) => [relation.source, relation.target]));
  const connectedConcepts = graph.concepts.filter((entry) => entry.id !== concept.id && connectedIds.has(entry.id))
    .map((entry) => questionContext(entry, material));
  // Older stored questions also need a quality review before an incorrect-choice diagnosis.
  await reviewChoiceQuestion(client, concept, material, question);
  const candidateConceptIds = [concept.id, ...connectedConcepts.map((entry) => entry.concept.id)];
  const schema = evaluationGenerationSchema(candidateConceptIds);
  const result = schema.parse(await client.generate({ name: "answer_evaluation", instructions: prompts.evaluation,
    data: { ...context, question, answer, connectedConcepts, relations, candidateConceptIds, ...(question.type === "MULTIPLE_CHOICE" ? { determinedScore: 0 } : {}) }, schema }));
  // The model explains the distractor; it cannot change exact-choice scoring.
  if (question.type === "MULTIPLE_CHOICE") result.score = 0;
  ensure(new Set(result.weakPoints).size === result.weakPoints.length, "Duplicate weak concept IDs.");
  ensure(result.score !== 100 || result.weakPoints.length === 0, "Full credit is inconsistent with missing criteria.");
  if (result.score < 100) {
    const deferral = /(?:단정|판단|추론|추정|분석|파악|확인|알)\s*(?:할\s*수\s*없|수\s*없|하기\s*어렵)|(?:cannot|can't|unable to)\s+(?:determine|infer|identify|establish)/i;
    if (result.weakPoints.length === 0 || deferral.test(result.feedback)) {
      // With no usable model hypothesis, only the tested concept is supported as a weak-node candidate.
      result.weakPoints = [concept.id];
      const relation = relations[0];
      const neighbor = connectedConcepts.find((entry) => entry.concept.id === (relation?.source === concept.id ? relation.target : relation?.source));
      const connection = relation && neighbor ? ` 연결된 '${neighbor.concept.name.slice(0, 300)}' 개념과의 관계(${relation.reason.slice(0, 600)})를 함께 복습하세요.` : "";
      result.feedback = `${concept.name.slice(0, 300)}: 제출 답안 '${answer.slice(0, 1000)}'과 모범 답안 '${question.referenceAnswer.slice(0, 1000)}'의 핵심 내용을 혼동했을 가능성이 있습니다. 두 답안의 차이를 비교해 이 문항에서 요구하는 개념을 복습하세요.${connection}`;
    }
  }
  return schema.parse(result);
}
