import type { AnalysisProgress, Concept, LlmClient, Material, Relation } from "../core/contracts.ts";
import { boundedText, choice, list, object } from "../core/schema.ts";
import { prompts } from "../core/prompts.ts";
import { ensure } from "../core/errors.ts";
import { partitionRequests, runPartition } from "../core/partition.ts";
import { relationEvidence } from "./evidence.ts";
import { explicitHierarchyDirection, hierarchyDirectionFromText } from "./direction.ts";
import type { Schema } from "../core/schema.ts";

interface ReviewDecision {
  candidateId: string;
  verdict: "SUPPORTED" | "REJECT";
  evidenceIds: string[];
  reason: string;
  broaderConceptId?: string;
  narrowerConceptId?: string;
  prerequisiteConceptId?: string;
  dependentConceptId?: string;
}

function reviewSchema(candidateIds: string[], conceptIds: string[], evidenceIds: string[], hierarchy: boolean): Schema<{ decisions: ReviewDecision[] }> {
  const common = { candidateId: choice(...candidateIds), verdict: choice("SUPPORTED", "REJECT"),
    evidenceIds: list(choice(...evidenceIds), 0, evidenceIds.length), reason: boundedText(600) };
  if (hierarchy) {
    return object({ decisions: list(object({ ...common, broaderConceptId: choice(...conceptIds), narrowerConceptId: choice(...conceptIds) }), candidateIds.length, candidateIds.length) });
  }
  return object({ decisions: list(object({ ...common, prerequisiteConceptId: choice(...conceptIds), dependentConceptId: choice(...conceptIds) }), candidateIds.length, candidateIds.length) });
}

// Review only directed claims. Symmetric relatedness does not determine the learning order.
export async function reviewRelations(client: LlmClient, material: Material, concepts: Concept[], relations: Relation[],
  onProgress?: (progress: AnalysisProgress) => void): Promise<Relation[]> {
  const candidates = relations.filter((relation) => relation.type !== "RELATED")
    .map((relation, index) => ({ id: `r${index + 1}`, ...relation }));
  if (!candidates.length) return relations;
  const byId = new Map(concepts.map((concept) => [concept.id, concept]));
  const reviewed = new Map<string, Relation>();
  const unresolved = candidates.filter((candidate) => {
    if (candidate.type !== "PARENT_CHILD") return true;
    const source = byId.get(candidate.source);
    const target = byId.get(candidate.target);
    ensure(source && target, "Relation review references an unknown concept.");
    const direction = explicitHierarchyDirection(material, source, target);
    if (!direction) return true;
    const broader = byId.get(direction.source)!;
    const narrower = byId.get(direction.target)!;
    reviewed.set(candidate.id, { ...direction, type: candidate.type, reason: `원문에서 ${narrower.name}을(를) ${broader.name}의 한 종류로 명시합니다.` });
    return false;
  });
  const build = (entries: typeof candidates) => {
    const ids = new Set(entries.flatMap((entry) => [entry.source, entry.target]));
    const nodes = [...ids].map((id) => {
      const concept = byId.get(id);
      ensure(concept, "Relation review references an unknown concept.");
      return concept;
    });
    const quotes = new Map<string, { id: string; sourceLocation: string; text: string }>();
    const nodesWithEvidence = nodes.map((concept) => {
      const evidenceIds: string[] = [];
      for (const citation of relationEvidence(concept, material)) {
        const text = citation.evidence;
        const key = JSON.stringify([citation.sourceLocation, text]);
        if (!quotes.has(key)) quotes.set(key, { id: `e${quotes.size + 1}`, sourceLocation: citation.sourceLocation, text });
        evidenceIds.push(quotes.get(key)!.id);
      }
      return { id: concept.id, name: concept.name, evidenceIds: [...new Set(evidenceIds)] };
    });
    const hierarchy = entries[0].type === "PARENT_CHILD";
    const schema = reviewSchema(entries.map((entry) => entry.id), [...ids], [...quotes.values()].map((quote) => quote.id), hierarchy);
    return { name: "relation_review", instructions: prompts.relationReview,
      data: { concepts: nodesWithEvidence, candidates: entries.map(({ id, source, target, type }) => ({ id, type, conceptIds: [source, target],
        allowedEvidenceIds: [...new Set(nodesWithEvidence.filter((node) => node.id === source || node.id === target).flatMap((node) => node.evidenceIds))],
      })),
        evidence: [...quotes.values()], roles: hierarchy ? "broaderConceptId -> narrowerConceptId" : "prerequisiteConceptId -> dependentConceptId" }, schema };
  };
  const batches = ["PARENT_CHILD", "PREREQUISITE"].flatMap((type) => partitionRequests(unresolved.filter((candidate) => candidate.type === type), build));
  for (const batch of batches) {
    const results = await runPartition(batch, async (entries) => {
      const request = build(entries);
      const response = request.schema.parse(await client.generate(request));
      ensure(new Set(response.decisions.map((decision) => decision.candidateId)).size === entries.length,
        "Relation review must decide every candidate exactly once.", "FORMAT");
      // Validate within runPartition so mixed-up batch evidence can recover in smaller requests.
      for (const decision of response.decisions) {
        if (decision.verdict === "REJECT" || !decision.evidenceIds.length) continue;
        const candidate = request.data.candidates.find((entry) => entry.id === decision.candidateId)!;
        const allowed = new Set(candidate.allowedEvidenceIds);
        ensure(decision.evidenceIds.every((id) => allowed.has(id)), "Review evidence must belong to the candidate's endpoints.", "FORMAT");
      }
      return { entries, response };
    });
    for (const { entries, response } of results) {
      for (const decision of response.decisions) {
        const candidate = entries.find((entry) => entry.id === decision.candidateId)!;
        if (decision.verdict === "REJECT" || !decision.evidenceIds.length) {
          onProgress?.({ stage: "relations", completed: 0, total: candidates.length,
            detail: `관계 검증에서 제외: ${candidate.source} -> ${candidate.target}: ${decision.reason}` });
          continue;
        }
        const sourceId = decision.broaderConceptId ?? decision.prerequisiteConceptId;
        const targetId = decision.narrowerConceptId ?? decision.dependentConceptId;
        ensure(sourceId && targetId && sourceId !== targetId && [candidate.source, candidate.target].includes(sourceId)
          && [candidate.source, candidate.target].includes(targetId), "Review must preserve the candidate's two distinct endpoints.", "FORMAT");
        // Generated prose cannot establish a fact, but a contradiction with its own IDs can veto the claim.
        const claimedDirection = candidate.type === "PARENT_CHILD"
          ? hierarchyDirectionFromText([decision.reason], byId.get(sourceId)!, byId.get(targetId)!) : undefined;
        if (claimedDirection && claimedDirection.source !== sourceId) {
          onProgress?.({ stage: "relations", completed: 0, total: candidates.length,
            detail: `관계 검증에서 제외: ${sourceId} -> ${targetId}: 설명과 상하 방향이 일치하지 않습니다.` });
          continue;
        }
        reviewed.set(candidate.id, { source: sourceId, target: targetId, type: candidate.type, reason: decision.reason });
      }
    }
  }
  let index = 0;
  const result: Relation[] = [];
  for (const relation of relations) {
    const accepted = relation.type === "RELATED" ? relation : reviewed.get(`r${++index}`);
    if (accepted) result.push(accepted);
  }
  return result;
}
