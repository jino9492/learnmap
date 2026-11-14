import type { Concept, LlmClient, Material } from "../core/contracts.ts";
import { object, boundedText } from "../core/schema.ts";
import { prompts } from "../core/prompts.ts";
import { partitionRequests, runPartition } from "../core/partition.ts";
import { ensure } from "../core/errors.ts";
import { conceptCitations, conceptSummary } from "../../features/material-analysis/index.ts";

interface EvidenceFragment { id: string; text: string }

// Every original fragment is processed. Only generated summaries are reduced;
// exact source excerpts stored on the graph are never overwritten by summaries.
export async function prepareQuestionContext(client: LlmClient, concept: Concept, material: Material, focus?: unknown) {
  const citations = conceptCitations(concept, material);
  const context = { concept: conceptSummary(concept), source: { location: concept.sourceLocation, text: concept.evidence },
    sources: citations.filter((citation) => citation.sourceLocation !== concept.sourceLocation || citation.evidence !== concept.evidence)
      .map((citation) => ({ location: citation.sourceLocation, text: citation.evidence })),
  };
  if (JSON.stringify(context).length <= 6000 || !context.sources.length) return context;
  const schema = object({ summary: boundedText(800) });
  const build = (fragments: EvidenceFragment[]) => ({ name: "evidence_digest", instructions: prompts.evidenceDigest,
    data: { focus, fragments }, schema });
  let fragments: EvidenceFragment[] = [];
  for (const [index, source] of context.sources.entries()) {
    for (let offset = 0; offset < source.text.length; offset += 1800) {
      fragments.push({ id: `source:${index + 1}:${offset}`, text: source.text.slice(offset, offset + 1800) });
    }
  }
  let round = 0;
  while (fragments.length > 2 || round === 0) {
    const next: EvidenceFragment[] = [];
    const batches = partitionRequests(fragments, build).flatMap((batch) => {
      const chunks: EvidenceFragment[][] = [];
      for (let index = 0; index < batch.length; index += 4) chunks.push(batch.slice(index, index + 4));
      return chunks;
    });
    for (const batch of batches) {
      const summaries = await runPartition(batch, async (entries) => {
        const request = build(entries);
        return request.schema.parse(await client.generate(request));
      });
      for (const summary of summaries) next.push({ id: `summary:${round + 1}:${next.length + 1}`, text: summary.summary });
    }
    // A failing singleton must not produce an unbounded reduction loop.
    ensure(next.length < fragments.length || next.length <= 2, "Evidence summaries could not be reduced safely.", "FORMAT");
    fragments = next;
    round++;
  }
  return { ...context, sources: [], sourceSummaries: fragments.map(({ id, text }) => ({ id, summary: text })),
    evidenceProcessing: "Additional original excerpts were processed in batches and hierarchically summarized. These are generated summaries, not source quotations." };
}
