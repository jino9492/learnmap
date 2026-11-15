import type { Citation, Concept, Material } from "../core/contracts.ts";
import { conceptCitations } from "../../features/material-analysis/index.ts";

// Retrieve bounded verbatim context rather than feeding generated lessons back as facts.
export function relationEvidence(concept: Concept, material: Material): Citation[] {
  const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, "");
  const name = normalize(concept.name);
  const fragments = conceptCitations(concept, material).flatMap((citation) => {
    const result: Citation[] = [];
    for (let offset = 0; offset < citation.evidence.length; offset += 1000) {
      result.push({ ...citation, evidence: citation.evidence.slice(offset, offset + 1000) });
    }
    return result;
  });
  const rank = (citation: Citation) => (normalize(citation.evidence).includes(name) ? 4 : 0)
    + (/한\s*(?:분야|형태|종류)|하위|상위|포함|선행|이해하려면|kind of|type of|subset|requires/i.test(citation.evidence) ? 2 : 0);
  return fragments.sort((left, right) => rank(right) - rank(left)).slice(0, 2);
}
