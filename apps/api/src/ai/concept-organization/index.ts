import type { AnalysisProgress, Concept, LlmClient } from "../core/contracts.ts";
import { conceptCollectionSchema, conceptOrganizationSchema } from "../core/schemas.ts";
import { prompts } from "../core/prompts.ts";
import { ensure } from "../core/errors.ts";
import { validateMaterial } from "../concept-extraction/index.ts";
import { validateGraph } from "../../features/knowledge-graph/index.ts";
import { conceptCitations, organizationBatches, organizationSummary } from "../../features/material-analysis/index.ts";

export async function organizeConcepts(client: LlmClient, input: unknown, detailedConcepts: Concept[], onProgress?: (progress: AnalysisProgress) => void): Promise<Concept[]> {
  const material = validateMaterial(input);
  conceptCollectionSchema.parse({ concepts: detailedConcepts });
  validateGraph({ concepts: detailedConcepts, relations: [] });
  const original = new Map(detailedConcepts.map((concept) => [concept.id, concept]));
  for (const concept of detailedConcepts) conceptCitations(concept, material);
  let pool = detailedConcepts.map((concept) => ({ ...concept, memberConceptIds: [concept.id] }));
  for (let round = 1; round <= 3; round++) {
    const batches = organizationBatches(pool);
    const next: Concept[] = [];
    onProgress?.({ stage: "organization", completed: 0, total: batches.length, detail: `Core concept organization, round ${round}.` });
    for (const [index, batch] of batches.entries()) {
      const byId = new Map(batch.map((concept) => [concept.id, concept]));
      const schema = conceptOrganizationSchema(batch.map((concept) => concept.id));
      const result = schema.parse(await client.generate({ name: "concept_organization", instructions: prompts.organization,
        data: { title: material.title, concepts: batch.map(organizationSummary) }, schema }));
      for (const group of result.groups) {
        const memberIds = [...new Set(group.memberIds.flatMap((id) => {
          const member = byId.get(id);
          ensure(member, "Organized concept references an unknown member.");
          return member.memberConceptIds ?? [id];
        }))];
        const citations = new Map<string, { sourceLocation: string; evidence: string }>();
        for (const id of memberIds) {
          const member = original.get(id);
          ensure(member, "Organized concept lost its original provenance.");
          for (const citation of conceptCitations(member, material)) citations.set(JSON.stringify(citation), citation);
        }
        const sources = [...citations.values()];
        const primary = sources[0];
        ensure(primary, "Organized concept has no grounded citation.");
        next.push({ id: `r${round}:g${next.length + 1}`, name: group.name, description: group.description,
          sourceLocation: primary.sourceLocation, evidence: primary.evidence, memberConceptIds: memberIds, citations: sources });
      }
      if (!result.groups.length) {
        next.push(...batch);
        onProgress?.({ stage: "organization", completed: index + 1, total: batches.length, detail: "No supported grouping returned; original items retained for this batch." });
      } else onProgress?.({ stage: "organization", completed: index + 1, total: batches.length, detail: `Core concept organization, round ${round}.` });
    }
    const previousCount = pool.length;
    pool = next.map((concept, index) => ({ ...concept, id: `o${round}:${index + 1}`, memberConceptIds: concept.memberConceptIds ?? [concept.id] }));
    if (batches.length === 1 || pool.length >= previousCount) break;
  }
  return pool.map((concept, index) => ({ ...concept, id: `k${index + 1}` }));
}
