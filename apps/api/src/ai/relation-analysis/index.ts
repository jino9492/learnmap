import type { AnalysisProgress, Concept, LlmClient, Relation } from "../core/contracts.ts";
import { validateGraph } from "../../features/knowledge-graph/index.ts";
import { validateMaterial } from "../concept-extraction/index.ts";
import { conceptCollectionSchema, relationGenerationSchema } from "../core/schemas.ts";
import { prompts } from "../core/prompts.ts";
import { conceptCitations, conceptSummary, conceptWindows, crossMaterialWindows, relationKey } from "../../features/material-analysis/index.ts";
import { AiError } from "../core/errors.ts";
import { mapBatches } from "../core/batches.ts";
import type { BatchOptions } from "../core/batches.ts";

interface RelationOptions extends BatchOptions {
  crossMaterial?: boolean;
  existingRelations?: Relation[];
}

export async function analyzeRelations(client: LlmClient, input: unknown, concepts: Concept[], onProgress?: (progress: AnalysisProgress) => void, options: RelationOptions = {}) {
  const material = validateMaterial(input);
  conceptCollectionSchema.parse({ concepts });
  validateGraph({ concepts, relations: [] });
  for (const concept of concepts) conceptCitations(concept, material);
  const windows = (options.crossMaterial ? crossMaterialWindows : conceptWindows)(concepts.map(conceptSummary));
  validateGraph({ concepts, relations: options.existingRelations ?? [] });
  const relations = new Map<string, Relation>((options.existingRelations ?? []).map((relation) => [relationKey(relation), relation]));
  onProgress?.({ stage: "relations", completed: 0, total: windows.length });
  let completed = 0;
  const candidates = await mapBatches(windows, options.concurrency, async (window) => {
    const schema = relationGenerationSchema(window.map((concept) => concept.id));
    const result = schema.parse(await client.generate({ name: "relation_analysis", instructions: prompts.relations, data: { material: { id: material.id, title: material.title }, concepts: window }, schema }));
    onProgress?.({ stage: "relations", completed: ++completed, total: windows.length });
    return result;
  });
  // Merge in input order so request latency cannot change which conflicting edge survives.
  for (const result of candidates) {
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
    if (rejected.length) onProgress?.({ stage: "relations", completed, total: windows.length,
      detail: `Rejected ${rejected.length} invalid relation candidate(s): ${rejected.join("; ")}` });
  }
  const result = [...relations.values()];
  validateGraph({ concepts, relations: result });
  return result;
}
