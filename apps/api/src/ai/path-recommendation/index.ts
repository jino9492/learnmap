import type { Graph, LlmClient, Recommendation } from "../core/contracts.ts";
import { AiError, ensure } from "../core/errors.ts";
import { prompts } from "../core/prompts.ts";
import { recommendationSchema, recommendationGenerationSchema, conceptCollectionSchema, relationCollectionSchema } from "../core/schemas.ts";
import { list, object, score, text } from "../core/schema.ts";
import { prerequisiteContext } from "../../features/knowledge-graph/index.ts";
import { conceptSummary } from "../../features/material-analysis/index.ts";
import { partitionRequests, requestCharacters, REQUEST_CHARACTERS, runPartition } from "../core/partition.ts";

export interface Progress {
  conceptId: string;
  scores: number[];
  recentMistakes: string[];
}

const progressSchema = list(object<Progress>({ conceptId: text, scores: list(score), recentMistakes: list(text, 0, 10) }), 0, Infinity);

export async function recommendPath(client: LlmClient, graph: Graph, targetConceptId: string, inputProgress: unknown) {
  conceptCollectionSchema.parse({ concepts: graph.concepts });
  relationCollectionSchema.parse({ relations: graph.relations });
  const subgraph = prerequisiteContext(graph, targetConceptId);
  const context = { concepts: subgraph.concepts.map(conceptSummary), relations: subgraph.relations };
  const ids = new Set(context.concepts.map((concept) => concept.id));
  const progress = progressSchema.parse(inputProgress);
  const seen = new Set<string>();
  for (const entry of progress) {
    ensure(graph.concepts.some((concept) => concept.id === entry.conceptId) && !seen.has(entry.conceptId), "Unknown or duplicate progress concept.", "INPUT");
    seen.add(entry.conceptId);
    ensure(entry.recentMistakes.every((value) => value.length <= 2000), "Invalid mistake history.", "INPUT");
  }
  const relevantProgress = progress.filter((entry) => ids.has(entry.conceptId))
    .map((entry) => ({ ...entry, scores: entry.scores.slice(-5), recentMistakes: entry.recentMistakes.slice(-3) }));
  const build = (concepts: Graph["concepts"]) => {
    const included = new Set(concepts.map((concept) => concept.id));
    return { name: "path_recommendation", instructions: prompts.path,
      data: { graph: { concepts, relations: context.relations.filter((relation) => included.has(relation.source) && included.has(relation.target)) },
        targetConceptId: concepts.at(-1)?.id, progress: relevantProgress.filter((entry) => included.has(entry.conceptId)) },
      schema: recommendationGenerationSchema([...included]),
    };
  };
  async function partitionedPath(): Promise<Recommendation> {
    const ordered = orderPrerequisites(context, targetConceptId);
    const batches = partitionRequests(ordered, build).flatMap((batch) => {
      const result: Graph["concepts"][] = [];
      for (let index = 0; index < batch.length; index += 8) result.push(batch.slice(index, index + 8));
      return result;
    });
    const steps: Recommendation["steps"] = [];
    const causes: string[] = [];
    let incomplete = false;
    let stopExplanations = false;
    for (const batch of batches) {
      try {
        const paths = await runPartition(batch, async (entries) => {
          if (stopExplanations) throw new AiError("CONNECTION", "Skipping optional explanations after a provider failure.");
          const request = build(entries);
          const target = entries.at(-1);
          ensure(target, "Empty recommendation batch.");
          return generatePath(client, request.data.graph, target.id, request.data.progress);
        }, (entries, error) => {
          if (!(error instanceof AiError) || ["CONFIG", "INPUT", "REFUSAL"].includes(error.code) || error.reason === "AUTH" || error.reason === "MODEL_NOT_FOUND") throw error;
          incomplete = true;
          if (error.reason === "RATE_LIMIT" || error.code === "CONNECTION" || error.reason === "UNAVAILABLE") stopExplanations = true;
          return { steps: entries.map((concept) => ({ conceptId: concept.id, reason: `'${concept.name.slice(0, 300)}'은 목표 개념 또는 그 선수 개념입니다. 선수 관계에 따라 이 순서로 복습하세요. (AI 설명 생성 미완료)` })),
            possibleCause: "이 구간의 AI 설명을 생성하지 못했습니다." };
        });
        for (const path of paths) {
          steps.push(...path.steps);
          if (causes.join("\n").length + path.possibleCause.length < 9000) causes.push(path.possibleCause);
        }
      } catch (error) {
        if (!(error instanceof AiError) || ["CONFIG", "INPUT", "REFUSAL"].includes(error.code) || error.reason === "AUTH" || error.reason === "MODEL_NOT_FOUND") throw error;
        incomplete = true;
        // Order is a graph invariant, not an AI prediction. Preserve every prerequisite.
        steps.push(...batch.map((concept) => ({ conceptId: concept.id, reason: `'${concept.name.slice(0, 300)}'은 목표 개념 또는 그 선수 개념입니다. 선수 관계에 따라 이 순서로 복습하세요. (AI 설명 생성 미완료)` })));
      }
    }
    const warning = incomplete ? "일부 AI 설명을 생성하지 못해 해당 구간은 확인된 선수 관계에 따른 순서로 제공했습니다." : "";
    const result = recommendationSchema.parse({ steps, possibleCause: [...causes, warning].filter(Boolean).join("\n\n") || "목표 개념과 연결된 선수 개념을 순서대로 복습하세요." });
    validatePath(result, ids, context.relations, targetConceptId);
    return result;
  }
  const whole = build(context.concepts);
  if (context.concepts.length > 8 || requestCharacters({ ...whole, data: { ...whole.data, targetConceptId } }) > REQUEST_CHARACTERS) return partitionedPath();
  try { return await generatePath(client, context, targetConceptId, relevantProgress); }
  catch (error) {
    if (context.concepts.length < 2 || !(error instanceof AiError) || (error.reason !== "CONTEXT_LIMIT" && error.code !== "TIMEOUT")) throw error;
    return partitionedPath();
  }
}

async function generatePath(client: LlmClient, context: Graph, targetConceptId: string, progress: Progress[]): Promise<Recommendation> {
  const ids = new Set(context.concepts.map((concept) => concept.id));
  const schema = recommendationGenerationSchema([...ids]);
  let correction: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = recommendationSchema.parse(await client.generate({ name: "path_recommendation", instructions: prompts.path,
        data: { graph: context, targetConceptId, progress: progress.filter((entry) => ids.has(entry.conceptId)), ...(correction ? { correction } : {}) }, schema }));
      validatePath(result, ids, context.relations, targetConceptId);
      return result;
    } catch (error) {
      if (!(error instanceof AiError) || !["FORMAT", "SEMANTIC"].includes(error.code)) throw error;
      if (attempt === 1) throw new AiError(error.code, "추천 학습 경로의 개념 또는 선수 순서를 확인하지 못했습니다. 경로 생성을 다시 시도해 주세요.");
      correction = `The previous response was rejected: ${error.message} Regenerate the complete path using every supplied concept ID exactly once, unchanged, with prerequisites first and targetConceptId last.`;
    }
  }
  throw new AiError("SEMANTIC", "추천 학습 경로를 생성하지 못했습니다. 경로 생성을 다시 시도해 주세요.");
}

function orderPrerequisites(graph: Graph, targetId: string): Graph["concepts"] {
  const indegree = new Map(graph.concepts.map((concept) => [concept.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const relation of graph.relations) {
    indegree.set(relation.target, (indegree.get(relation.target) ?? 0) + 1);
    outgoing.set(relation.source, [...(outgoing.get(relation.source) ?? []), relation.target]);
  }
  const byId = new Map(graph.concepts.map((concept) => [concept.id, concept]));
  const ready = graph.concepts.filter((concept) => indegree.get(concept.id) === 0).map((concept) => concept.id);
  const ordered: Graph["concepts"] = [];
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index];
    const concept = byId.get(id);
    ensure(concept, "Unknown prerequisite concept.");
    ordered.push(concept);
    for (const next of outgoing.get(id) ?? []) {
      const degree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, degree);
      if (degree === 0) ready.push(next);
    }
  }
  ensure(ordered.length === graph.concepts.length && ordered.at(-1)?.id === targetId, "Invalid prerequisite ordering.");
  return ordered;
}

function validatePath(result: Recommendation, ids: Set<string>, relations: Graph["relations"], targetConceptId: string) {
  const positions = new Map(result.steps.map((step, index) => [step.conceptId, index]));
  ensure(positions.size === result.steps.length && positions.size === ids.size && [...positions.keys()].every((id) => ids.has(id)), "Path must include exactly the target and its prerequisites.");
  ensure(result.steps.at(-1)?.conceptId === targetConceptId, "Path must end at the target.");
  for (const relation of relations) {
    const source = positions.get(relation.source);
    const target = positions.get(relation.target);
    ensure(source !== undefined && target !== undefined && source < target, "Path violates prerequisite order.");
  }
}
