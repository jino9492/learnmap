import type { Graph, LlmClient } from "../core/contracts.ts";
import { ensure } from "../core/errors.ts";
import { prompts } from "../core/prompts.ts";
import { recommendationSchema, conceptCollectionSchema, relationCollectionSchema } from "../core/schemas.ts";
import { list, object, score, text } from "../core/schema.ts";
import { prerequisiteContext } from "../../features/knowledge-graph/index.ts";
import { conceptSummary } from "../../features/material-analysis/index.ts";

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
  const result = recommendationSchema.parse(await client.generate({ name: "path_recommendation", instructions: prompts.path, data: { graph: context, targetConceptId, progress: progress.filter((entry) => ids.has(entry.conceptId)) }, schema: recommendationSchema }));
  const positions = new Map(result.steps.map((step, index) => [step.conceptId, index]));
  ensure(positions.size === result.steps.length && positions.size === ids.size && [...positions.keys()].every((id) => ids.has(id)), "Path must include exactly the target and its prerequisites.");
  ensure(result.steps.at(-1)?.conceptId === targetConceptId, "Path must end at the target.");
  for (const relation of context.relations) {
    const source = positions.get(relation.source);
    const target = positions.get(relation.target);
    ensure(source !== undefined && target !== undefined && source < target, "Path violates prerequisite order.");
  }
  return result;
}
