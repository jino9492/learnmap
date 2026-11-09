import type { AnalysisProgress, Concept, LlmClient, Relation } from "../core/contracts.ts";
import { validateGraph } from "../../features/knowledge-graph/index.ts";
import { validateMaterial } from "../concept-extraction/index.ts";
import { conceptCollectionSchema, relationGenerationSchema } from "../core/schemas.ts";
import { prompts } from "../core/prompts.ts";
import { conceptWindows, relationKey } from "../../features/material-analysis/index.ts";
import { AiError, ensure } from "../core/errors.ts";

export async function analyzeRelations(client: LlmClient, input: unknown, concepts: Concept[], onProgress?: (progress: AnalysisProgress) => void) {
  const material = validateMaterial(input);
  conceptCollectionSchema.parse({ concepts });
  validateGraph({ concepts, relations: [] });
  for (const concept of concepts) {
    ensure(material.sources.some((source) => source.location === concept.sourceLocation && source.text.includes(concept.evidence)), "Concept is not grounded in this material.", "INPUT");
  }
  const windows = conceptWindows(concepts);
  const relations = new Map<string, Relation>();
  onProgress?.({ stage: "relations", completed: 0, total: windows.length });
  for (const [index, window] of windows.entries()) {
    const schema = relationGenerationSchema(window.map((concept) => concept.id));
    const result = schema.parse(await client.generate({ name: "relation_analysis", instructions: prompts.relations, data: { material: { id: material.id, title: material.title }, concepts: window }, schema }));
    const rejected: string[] = [];
    for (const relation of result.relations) {
      const key = relationKey(relation);
      if (relations.has(key)) continue;
      try {
        validateGraph({ concepts, relations: [...relations.values(), relation] });
        relations.set(key, relation);
      } catch (error) {
        if (!(error instanceof AiError) || error.code !== "SEMANTIC") throw error;
        rejected.push(`${relation.source} -> ${relation.target}: ${error.message}`);
      }
    }
    onProgress?.({ stage: "relations", completed: index + 1, total: windows.length,
      ...(rejected.length ? { detail: `Rejected ${rejected.length} invalid relation candidate(s): ${rejected.join("; ")}` } : {}),
    });
  }
  const result = [...relations.values()];
  validateGraph({ concepts, relations: result });
  return result;
}
