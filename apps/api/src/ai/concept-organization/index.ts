import type { AnalysisProgress, Concept, LlmClient } from "../core/contracts.ts";
import { conceptCollectionSchema, conceptOrganizationSchema } from "../core/schemas.ts";
import { prompts } from "../core/prompts.ts";
import { ensure } from "../core/errors.ts";
import { validateMaterial } from "../concept-extraction/index.ts";
import { validateGraph } from "../../features/knowledge-graph/index.ts";
import { conceptCitations, organizationBatches, organizationSummary } from "../../features/material-analysis/index.ts";
import { mapBatches, validateConcurrency } from "../core/batches.ts";
import type { BatchOptions } from "../core/batches.ts";

export async function organizeConcepts(client: LlmClient, input: unknown, detailedConcepts: Concept[], onProgress?: (progress: AnalysisProgress) => void, options: BatchOptions = {}): Promise<Concept[]> {
  validateConcurrency(options.concurrency);
  const material = validateMaterial(input);
  conceptCollectionSchema.parse({ concepts: detailedConcepts });
  validateGraph({ concepts: detailedConcepts, relations: [] });
  const original = new Map(detailedConcepts.map((concept) => [concept.id, concept]));
  for (const concept of detailedConcepts) conceptCitations(concept, material);
  let pool = detailedConcepts.map((concept) => ({ ...concept, memberConceptIds: [concept.id] }));
  for (let round = 1; round <= 3; round++) {
    const batches = organizationBatches(pool);
    let completed = 0;
    onProgress?.({ stage: "organization", completed: 0, total: batches.length, detail: `Core concept organization, round ${round}.` });
    const results = await mapBatches(batches, options.concurrency, async (batch, index) => {
      const next: Concept[] = [];
      const byId = new Map(batch.map((concept) => [concept.id, concept]));
      const schema = conceptOrganizationSchema(batch.map((concept) => concept.id));
      const data = { title: material.title, concepts: batch.map(organizationSummary) };
      let result = schema.parse(await client.generate({ name: "concept_organization", instructions: prompts.organization, data, schema }));
      const overlappingIds = () => {
        const seen = new Set<string>();
        const duplicates = new Set<string>();
        for (const group of result.groups) for (const id of group.memberIds) {
          if (seen.has(id)) duplicates.add(id);
          seen.add(id);
        }
        return [...duplicates];
      };
      const duplicates = overlappingIds();
      if (duplicates.length) {
        onProgress?.({ stage: 'organization', completed, total: batches.length,
          detail: `개념 정리 배치 ${index + 1}: 중복 배정된 ${duplicates.length}개 항목을 발견해 한 번 교정합니다.` });
        result = schema.parse(await client.generate({ name: 'concept_organization',
          instructions: `${prompts.organization}\nCorrection: Your previous grouping reused member IDs. Regenerate the complete grouping. Each member ID must occur exactly once across all groups and within each group. Keep distinct learning objectives separate. Use singleton groups when uncertain. The correction.duplicateMemberIds field identifies the repeated IDs.`,
          data: { ...data, correction: { duplicateMemberIds: duplicates } }, schema }));
        if (overlappingIds().length) {
          onProgress?.({ stage: 'organization', completed: ++completed, total: batches.length, warning: true,
            detail: `핵심 개념 정리 배치 ${index + 1}에서 중복 배정이 반복되어 해당 배치의 세부 개념과 원문 근거를 그대로 유지했습니다.` });
          return batch;
        }
      }
      const assigned = new Set<string>();
      for (const group of result.groups) {
        for (const id of group.memberIds) {
          assigned.add(id);
        }
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
        next.push({ id: `r${round}:b${index + 1}:g${next.length + 1}`, name: group.name, description: group.description,
          sourceLocation: primary.sourceLocation, evidence: primary.evidence, memberConceptIds: memberIds, citations: sources,
          details: memberIds.flatMap((id) => { const member = original.get(id)!; return member.details ?? [{ name: member.name, description: member.description, sourceLocation: member.sourceLocation, evidence: member.evidence }]; }) });
      }
      // Incomplete model output must not silently remove learning objectives.
      if (result.groups.length) next.push(...batch.filter((concept) => !assigned.has(concept.id)));
      if (!result.groups.length) {
        next.push(...batch);
        onProgress?.({ stage: "organization", completed: ++completed, total: batches.length, detail: "No supported grouping returned; original items retained for this batch." });
      } else onProgress?.({ stage: "organization", completed: ++completed, total: batches.length, detail: `Core concept organization, round ${round}.` });
      return next;
    });
    const next = results.flat();
    const previousCount = pool.length;
    pool = next.map((concept, index) => ({ ...concept, id: `o${round}:${index + 1}`, memberConceptIds: concept.memberConceptIds ?? [concept.id] }));
    if (batches.length === 1 || pool.length >= previousCount) break;
  }
  return pool.map((concept, index) => ({ ...concept, id: `k${index + 1}` }));
}
