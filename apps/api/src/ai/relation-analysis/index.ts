import type { AnalysisProgress, Concept, LlmClient, Relation } from "../core/contracts.ts";
import { validateGraph } from "../../features/knowledge-graph/index.ts";
import { validateMaterial } from "../concept-extraction/index.ts";
import { conceptCollectionSchema, relationGenerationSchema } from "../core/schemas.ts";
import { prompts } from "../core/prompts.ts";
import { conceptCitations, conceptSummary, conceptWindows, relationKey } from "../../features/material-analysis/index.ts";
import { AiError } from "../core/errors.ts";
import { mapBatches } from "../core/batches.ts";
import type { BatchOptions } from "../core/batches.ts";
import { canSplitFailure, requestCharacters, REQUEST_CHARACTERS } from "../core/partition.ts";
import { reviewRelations } from "./review.ts";
import { relationEvidence } from "./evidence.ts";
import { analyzeCrossMaterialRelations } from "./cross-material.ts";

interface RelationOptions extends BatchOptions {
  crossMaterial?: boolean;
  existingRelations?: Relation[];
  changedMaterialId?: string;
}

export async function analyzeRelations(client: LlmClient, input: unknown, concepts: Concept[], onProgress?: (progress: AnalysisProgress) => void, options: RelationOptions = {}) {
  const material = validateMaterial(input);
  conceptCollectionSchema.parse({ concepts });
  validateGraph({ concepts, relations: [] });
  for (const concept of concepts) conceptCitations(concept, material);
  if (options.crossMaterial) return analyzeCrossMaterialRelations(client, material, concepts, onProgress, options);
  const windows = conceptWindows(concepts.map((concept) => ({
    ...conceptSummary(concept), citations: relationEvidence(concept, material),
  })));
  validateGraph({ concepts, relations: options.existingRelations ?? [] });
  const relations = new Map<string, Relation>((options.existingRelations ?? []).map((relation) => [relationKey(relation), relation]));
  onProgress?.({ stage: "relations", completed: 0, total: windows.length });
  let completed = 0;
  const candidates = await mapBatches(windows, options.concurrency, async (window) => {
    async function analyze(entries: Concept[]): Promise<{ relations: Relation[] }> {
      const schema = relationGenerationSchema(entries.map((concept) => concept.id));
      const request = { name: "relation_analysis", instructions: prompts.relations, data: { material: { id: material.id, title: material.title }, concepts: entries }, schema };
      async function smaller() {
        const parts: Concept[][] = [];
        if (entries.length <= 4) {
          for (let left = 0; left < entries.length; left++) for (let right = left + 1; right < entries.length; right++) parts.push([entries[left], entries[right]]);
        } else {
          const groups: Concept[][] = [];
          for (let index = 0; index < entries.length; index += 2) groups.push(entries.slice(index, index + 2));
          for (let left = 0; left < groups.length; left++) for (let right = left + 1; right < groups.length; right++) parts.push([...groups[left], ...groups[right]]);
        }
        // Every original pair remains in at least one subwindow, including cross-boundary pairs.
        const results: Relation[] = [];
        for (const part of parts) results.push(...(await analyze(part)).relations);
        return { relations: results };
      }
      if (entries.length > 2 && requestCharacters(request) > REQUEST_CHARACTERS) return smaller();
      try { return schema.parse(await client.generate(request)); }
      catch (error) {
        if (!canSplitFailure(error) || entries.length <= 2) throw error;
        return smaller();
      }
    }
    const result = await analyze(window);
    onProgress?.({ stage: "relations", completed: ++completed, total: windows.length });
    return result;
  });
  const proposed = new Map<string, Relation>();
  const rejected: string[] = [];
  // Merge in input order so request latency cannot change which conflicting edge survives.
  for (const result of candidates) {
    for (const relation of result.relations) {
      const key = relationKey(relation);
      if (relations.has(key) || proposed.has(key)) continue;
      try {
        // Review opposing claims before choosing one; a bad first edge must not suppress a correct later edge.
        validateGraph({ concepts, relations: [relation] });
        proposed.set(key, relation);
      } catch (error) {
        if (!(error instanceof AiError) || error.code !== "SEMANTIC") throw error;
        rejected.push(`${relation.source} -> ${relation.target}: ${error.message}`);
      }
    }
  }
  if ([...proposed.values()].some((relation) => relation.type !== "RELATED")) {
    onProgress?.({ stage: "relations", completed, total: windows.length, detail: "방향이 있는 관계의 유형과 방향을 원문 근거로 검증합니다." });
  }
  for (const relation of await reviewRelations(client, material, concepts, [...proposed.values()], (event) => onProgress?.({ ...event, completed, total: windows.length }))) {
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
  const result = [...relations.values()];
  validateGraph({ concepts, relations: result });
  return result;
}
