import type { AnalysisProgress, Citation, Concept, LlmClient, Material } from "../core/contracts.ts";
import type { BatchOptions } from "../core/batches.ts";
import { mapBatches } from "../core/batches.ts";
import { AiError } from "../core/errors.ts";
import { object, text } from "../core/schema.ts";
import { prompts } from "../core/prompts.ts";
import { partitionRequests, runPartition } from "../core/partition.ts";
import { conceptCitations } from "../../features/material-analysis/index.ts";

// Depth is guided by the prompt. Validate only the shared response structure.
const explanationSchema = object({ description: text });

// Extraction identifies learning objectives. Writing a lesson is a separate,
// focused request so many concepts cannot compete for the same output budget.
export async function expandConceptDetails(client: LlmClient, concepts: Concept[], material: Material,
  onProgress?: (progress: AnalysisProgress) => void, options: BatchOptions = {}): Promise<Concept[]> {
  const result = structuredClone(concepts);
  const tasks: { concept: Concept; details: NonNullable<Concept["details"]> }[] = [];
  for (const concept of result) {
    conceptCitations(concept, material);
    const groups = new Map<string, NonNullable<Concept["details"]>>();
    const details = concept.details ?? conceptCitations(concept, material).map((citation) => ({ ...citation, name: concept.name, description: concept.description }));
    concept.details = details;
    for (const detail of details) {
      const key = JSON.stringify([detail.name, detail.description]);
      const group = groups.get(key) ?? [];
      group.push(detail); groups.set(key, group);
    }
    for (const entries of groups.values()) {
      tasks.push({ concept, details: entries });
    }
  }
  let completed = 0;
  onProgress?.({ stage: "concepts", completed, total: tasks.length, detail: "세부 항목별 학습 설명을 작성하고 있습니다." });
  await mapBatches(tasks, options.concurrency, async ({ concept, details }) => {
    const unique = new Map(details.map(({ sourceLocation, evidence }) => [JSON.stringify([sourceLocation, evidence]), { sourceLocation, evidence }]));
    // Process every original passage without reducing it to an extraction summary.
    const fragments: Citation[] = [...unique.values()].flatMap((citation) => {
      const parts: Citation[] = [];
      for (let offset = 0; offset < citation.evidence.length; offset += 2400) parts.push({ ...citation, evidence: citation.evidence.slice(offset, offset + 2400) });
      return parts;
    });
    const build = (sources: Citation[], correction?: string) => ({ name: "concept_detail_expansion", instructions: prompts.conceptDetails,
      data: { concept: { name: concept.name, summary: concept.description }, topic: details[0].name, sources, ...(correction ? { correction } : {}) }, schema: explanationSchema });
    const explanations: { description: string }[] = [];
    for (const batch of partitionRequests(fragments, build)) {
      explanations.push(...await runPartition(batch, async (sources) => {
        let failure: string | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { return explanationSchema.parse(await client.generate(build(sources, failure))); }
          catch (error) {
            if (!(error instanceof AiError) || error.code !== "FORMAT" || attempt === 2) throw error;
            failure = error.message;
          }
        }
        throw new AiError("FORMAT", "상세 설명 작성을 완료하지 못했습니다.");
      }, (_sources, error) => {
        if (!(error instanceof AiError) || error.code !== "FORMAT") throw error;
        onProgress?.({ stage: "concepts", completed, total: tasks.length, warning: true,
          detail: "일부 상세 설명의 응답 형식을 읽지 못해 기존 개념 설명을 유지했습니다. 분석은 계속 진행합니다." });
        return { description: details[0].description };
      }));
    }
    // Each partition remains a separate lesson section to avoid truncating or
    // summarizing the successful explanations back down to one small field.
    const expanded = explanations.flatMap(({ description }, index) => details.map((detail) => ({ ...detail,
      name: explanations.length > 1 ? `${detail.name} · ${index + 1}` : detail.name, description })));
    const position = concept.details!.findIndex((detail) => details.includes(detail));
    concept.details = concept.details!.filter((detail) => !details.includes(detail));
    concept.details.splice(position, 0, ...expanded);
    onProgress?.({ stage: "concepts", completed: ++completed, total: tasks.length, detail: `${completed}/${tasks.length}개 세부 항목의 상세 설명을 작성했습니다.` });
  });
  return result;
}
