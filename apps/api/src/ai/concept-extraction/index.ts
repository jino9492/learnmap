import type { AnalysisProgress, Concept, LlmClient, Material } from "../core/contracts.ts";
import { ensure } from "../core/errors.ts";
import { prompts } from "../core/prompts.ts";
import { conceptGenerationSchema, materialSchema } from "../core/schemas.ts";
import { batchMaterial, evidenceCatalog } from "../../features/material-analysis/index.ts";
import { mapBatches } from "../core/batches.ts";
import type { BatchOptions } from "../core/batches.ts";

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
    const catalog = evidenceCatalog(batch);
    const schema = conceptGenerationSchema([...catalog.quotes.keys()]);
    const result = schema.parse(await client.generate({ name: "concept_extraction", instructions: prompts.concepts, data: catalog.data, schema }));
    ensure(new Set(result.concepts.map((concept) => concept.id)).size === result.concepts.length, "Duplicate concept IDs.");
    const concepts: Concept[] = result.concepts.map((concept) => {
      const quote = catalog.quotes.get(concept.evidence);
      ensure(quote, `Batch ${index + 1}/${batches.length}: unknown evidence ID for ${concept.id}.`);
      return { ...concept, id: batches.length > 1 ? `b${index + 1}:${concept.id}` : concept.id, sourceLocation: quote.sourceLocation, evidence: quote.text };
    });
    onProgress?.({ stage: "concepts", completed: ++completed, total: batches.length });
    return concepts;
  });
  const concepts = results.flat();
  ensure(concepts.length, "No grounded concepts could be extracted from this material.");
  return concepts;
}
