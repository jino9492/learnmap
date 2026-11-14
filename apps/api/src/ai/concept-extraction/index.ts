import type { AnalysisProgress, Concept, LlmClient, Material } from "../core/contracts.ts";
import { ensure } from "../core/errors.ts";
import { prompts } from "../core/prompts.ts";
import { conceptGenerationSchema, materialSchema } from "../core/schemas.ts";
import { batchMaterial, evidenceCatalog } from "../../features/material-analysis/index.ts";
import { mapBatches } from "../core/batches.ts";
import type { BatchOptions } from "../core/batches.ts";
import { canSplitFailure, requestCharacters, REQUEST_CHARACTERS } from "../core/partition.ts";

export function validateMaterial(value: unknown): Material {
  const material = materialSchema.parse(value);
  ensure(new Set(material.sources.map((source) => source.location)).size === material.sources.length, "Source locations must be unique.", "INPUT");
  return material;
}

export interface ConceptExtractionOptions extends BatchOptions {
  batchCharacters?: number;
}

export async function extractConcepts(client: LlmClient, input: unknown, onProgress?: (progress: AnalysisProgress) => void, options: ConceptExtractionOptions = {}) {
  const material = validateMaterial(input);
  const batches = batchMaterial(material, options.batchCharacters);
  let completed = 0;
  onProgress?.({ stage: "concepts", completed: 0, total: batches.length });
  const results = await mapBatches(batches, options.concurrency, async (batch, index) => {
    async function extract(part: Material, prefix: string, depth = 0): Promise<Concept[]> {
      const catalog = evidenceCatalog(part);
      const schema = conceptGenerationSchema([...catalog.quotes.keys()]);
      const request = { name: "concept_extraction", instructions: prompts.concepts, data: catalog.data, schema };
      const split = () => {
        if (part.sources.length > 1) {
          const middle = Math.ceil(part.sources.length / 2);
          return [part.sources.slice(0, middle), part.sources.slice(middle)];
        }
        const source = part.sources[0];
        if (source.text.length < 512) return null;
        const middle = Math.ceil(source.text.length / 2);
        return [[{ ...source, text: source.text.slice(0, middle) }], [{ ...source, text: source.text.slice(middle) }]];
      };
      async function smaller(): Promise<Concept[]> {
        const parts = split();
        ensure(parts && depth < 6, "자료 분석 배치를 더 작게 나눌 수 없습니다. 입력 또는 모델 컨텍스트 설정을 확인해 주세요.", "FORMAT");
        onProgress?.({ stage: "concepts", completed, total: batches.length, detail: "큰 요청을 작은 원문 구간으로 나눠 분석하고 있습니다." });
        const nodes: Concept[] = [];
        for (const [position, sources] of parts.entries()) {
          if (!sources.some((source) => source.text.trim())) continue;
          nodes.push(...await extract({ ...part, sources }, `${prefix}s${position + 1}:`, depth + 1));
        }
        return nodes;
      }
      if (requestCharacters(request) > REQUEST_CHARACTERS && split() && depth < 6) return smaller();
      try {
        const result = schema.parse(await client.generate(request));
        ensure(new Set(result.concepts.map((concept) => concept.id)).size === result.concepts.length, "Duplicate concept IDs.");
        return result.concepts.map((concept) => {
          const quote = catalog.quotes.get(concept.evidence);
          ensure(quote, `Batch ${index + 1}/${batches.length}: unknown evidence ID for ${concept.id}.`);
          return { ...concept, id: `${prefix}${concept.id}`, sourceLocation: quote.sourceLocation, evidence: quote.text };
        });
      } catch (error) {
        if (!canSplitFailure(error) || !split() || depth >= 6) throw error;
        return smaller();
      }
    }
    const concepts = await extract(batch, batches.length > 1 ? `b${index + 1}:` : "");
    onProgress?.({ stage: "concepts", completed: ++completed, total: batches.length });
    return concepts;
  });
  const concepts = results.flat();
  ensure(concepts.length, "No grounded concepts could be extracted from this material.");
  return concepts;
}
