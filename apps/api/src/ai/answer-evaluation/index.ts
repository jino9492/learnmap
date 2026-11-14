import type { Concept, Evaluation, Graph, LlmClient, Material, Question } from "../core/contracts.ts";
import { AiError, ensure } from "../core/errors.ts";
import { prompts } from "../core/prompts.ts";
import { evaluationFeedbackSchema, evaluationGenerationSchema } from "../core/schemas.ts";
import { prepareQuestionContext, questionContext, reviewChoiceQuestion, validateQuestion } from "../question-generation/index.ts";
import { validateGraph } from "../../features/knowledge-graph/index.ts";
import { conceptSummary } from "../../features/material-analysis/index.ts";
import { partitionRequests, requestCharacters, REQUEST_CHARACTERS, runPartition } from "../core/partition.ts";

export async function evaluateAnswer(client: LlmClient, concept: Concept, material: Material, input: Question, answer: string, graph: Graph = { concepts: [concept], relations: [] }) {
  questionContext(concept, material);
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
    .map((entry) => {
      // Validate every neighbor's provenance, but avoid repeating all of its citations.
      questionContext(entry, material);
      return { concept: conceptSummary(entry), source: { location: entry.sourceLocation, text: entry.evidence } };
    });
  // Older stored questions also need a quality review before an incorrect-choice diagnosis.
  await reviewChoiceQuestion(client, concept, material, question);
  const context = await prepareQuestionContext(client, concept, material, question);
  const candidateConceptIds = [concept.id, ...connectedConcepts.map((entry) => entry.concept.id)];
  const schema = evaluationGenerationSchema(candidateConceptIds);
  const build = (neighbors: typeof connectedConcepts, grading?: Evaluation) => {
    const ids = [concept.id, ...neighbors.map((entry) => entry.concept.id)];
    const included = new Set(ids);
    return { name: "answer_evaluation", instructions: grading ? prompts.evaluationDiagnosis : prompts.evaluation,
      data: { ...context, question, answer, connectedConcepts: neighbors,
        relations: relations.filter((relation) => included.has(relation.source) && included.has(relation.target)),
        candidateConceptIds: ids, ...(grading ? { grading: { score: grading.score, feedback: grading.feedback }, determinedScore: grading.score }
          : question.type === "MULTIPLE_CHOICE" ? { determinedScore: 0 } : {}) },
      schema: evaluationGenerationSchema(ids, grading ? 600 : 12000),
    };
  };
  const whole = build(connectedConcepts);
  let result: Evaluation;
  let diagnosticWarning = "";
  if (requestCharacters(whole) <= REQUEST_CHARACTERS || !connectedConcepts.length) {
    try { result = whole.schema.parse(await client.generate(whole)); }
    catch (error) {
      if (!connectedConcepts.length || !(error instanceof AiError) || (error.reason !== "CONTEXT_LIMIT" && error.code !== "TIMEOUT")) throw error;
      result = await evaluatePartitions();
    }
  } else result = await evaluatePartitions();

  async function evaluatePartitions(): Promise<Evaluation> {
    // Grade once. Neighbors explain misconceptions; they cannot vote on the score.
    const base = { ...build([]), schema: evaluationGenerationSchema([concept.id], 2400) };
    const grading = base.schema.parse(await client.generate(base));
    if (question.type === "MULTIPLE_CHOICE") grading.score = 0;
    ensure(new Set(grading.weakPoints).size === grading.weakPoints.length, "Duplicate weak concept IDs.");
    ensure(grading.score !== 100 || grading.weakPoints.length === 0, "Full credit is inconsistent with missing criteria.");
    if (grading.score === 100) return grading;
    const points = new Set(grading.weakPoints);
    const findings: string[] = [];
    let incomplete = false;
    let diagnosisFailures = 0;
    let stopDiagnosis = false;
    for (const batch of partitionRequests(connectedConcepts, (entries) => build(entries, grading))) {
      try {
        const results = await runPartition(batch, async (entries) => {
          if (stopDiagnosis) return { score: grading.score, feedback: "연결 개념의 추가 분석을 완료하지 못했습니다.", weakPoints: [] };
          const request = build(entries, grading);
          const diagnosis = request.schema.parse(await client.generate(request));
          ensure(diagnosis.score === grading.score, "Diagnosis changed the authoritative grade.", "FORMAT");
          ensure(new Set(diagnosis.weakPoints).size === diagnosis.weakPoints.length, "Duplicate diagnosis IDs.", "FORMAT");
          return diagnosis;
        }, (_entries, error) => {
          if (!(error instanceof AiError) || ["CONFIG", "INPUT", "REFUSAL"].includes(error.code) || error.reason === "AUTH" || error.reason === "MODEL_NOT_FOUND") throw error;
          incomplete = true;
          diagnosisFailures++;
          stopDiagnosis = error.reason === "RATE_LIMIT" || error.code === "CONNECTION" || diagnosisFailures >= 2;
          return { score: grading.score, feedback: "연결 개념의 추가 분석을 완료하지 못했습니다.", weakPoints: [] };
        });
        for (const diagnosis of results) {
          for (const id of diagnosis.weakPoints) if (points.size < 10) points.add(id);
          // These are internal findings, never paragraphs to concatenate for the learner.
          if (diagnosis.weakPoints.length && !findings.includes(diagnosis.feedback)
            && findings.join("").length + diagnosis.feedback.length <= 6000) findings.push(diagnosis.feedback);
        }
        if (stopDiagnosis) break;
      } catch (error) {
        if (!(error instanceof AiError) || ["CONFIG", "INPUT", "REFUSAL"].includes(error.code) || error.reason === "AUTH" || error.reason === "MODEL_NOT_FOUND") throw error;
        incomplete = true;
        // Required grading succeeded. Do not discard it because optional diagnosis failed.
        break;
      }
    }
    if (incomplete) diagnosticWarning = "일부 연결 개념의 추가 분석을 완료하지 못했습니다. 점수는 문항과 채점 기준에 대한 평가 결과입니다.";
    let feedback = grading.feedback;
    if (findings.length) {
      const weakConcepts = graph.concepts.filter((entry) => points.has(entry.id))
        .map((entry) => ({ id: entry.id, name: entry.name.slice(0, 100) }));
      // A failed optional rewrite must still leave one usable explanation.
      const additionalNames = weakConcepts.filter((entry) => !grading.weakPoints.includes(entry.id)).map((entry) => entry.name);
      if (additionalNames.length) feedback += ` 함께 복습할 연결 개념: ${additionalNames.join(", ")}.`;
      try {
        const request = { name: "evaluation_feedback", instructions: prompts.evaluationFeedback,
          data: { grading: { score: grading.score, feedback: grading.feedback }, findings, weakConcepts },
          schema: evaluationFeedbackSchema };
        feedback = request.schema.parse(await client.generate(request)).feedback;
      } catch (error) {
        if (!(error instanceof AiError) || ["CONFIG", "INPUT", "REFUSAL"].includes(error.code) || error.reason === "AUTH" || error.reason === "MODEL_NOT_FOUND") throw error;
      }
    }
    return { score: grading.score, feedback, weakPoints: [...points] };
  }
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
  if (diagnosticWarning) result.feedback += `\n\n${diagnosticWarning}`;
  return schema.parse(result);
}
