import type { AnalysisProgress, Citation, Concept, LlmClient, Material } from "../core/contracts.ts";
import type { BatchOptions } from "../core/batches.ts";
import { mapBatches } from "../core/batches.ts";
import { AiError, ensure } from "../core/errors.ts";
import { object, text } from "../core/schema.ts";
import { prompts } from "../core/prompts.ts";
import { partitionRequests, runPartition } from "../core/partition.ts";
import { conceptCitations } from "../../features/material-analysis/index.ts";

export function isDetailedExplanation(value: string): boolean {
  const paragraphs = value.trim().split(/\n\s*\n/).filter((paragraph) => paragraph.trim().length >= 60);
  const normalized = paragraphs.map((paragraph) => paragraph.replace(/\s/g, ""));
  return value.trim().length >= 600 && paragraphs.length >= 4 && new Set(normalized).size === normalized.length;
}

const explanationSchema = object({ description: {
  json: { ...text.json, minLength: 600, maxLength: 9000 },
  parse(value: unknown) {
    const description = text.parse(value);
    ensure(description.length <= 9000 && isDetailedExplanation(description),
      "상세 설명은 서로 다른 내용을 설명하는 4개 이상의 문단과 600자 이상의 본문이 필요합니다. 요약이나 반복 문장은 저장하지 않습니다.", "FORMAT");
    return description;
  },
} });

// Extraction identifies learning objectives. Writing a lesson is a separate,
// focused request so many concepts cannot compete for the same output budget.
export async function expandConceptDetails(client: LlmClient, concepts: Concept[], material: Material,
  onProgress?: (progress: AnalysisProgress) => void, options: BatchOptions & { force?: boolean } = {}): Promise<Concept[]> {
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
      if (options.force || !isDetailedExplanation(entries[0].description)) tasks.push({ concept, details: entries });
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
