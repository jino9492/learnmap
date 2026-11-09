import type { Citation, Concept, Material, Relation } from "../../ai/core/contracts.ts";
import { ensure } from "../../ai/core/errors.ts";
export { evidenceCatalog } from "./evidence.ts";

export function conceptSummary(concept: Concept): Concept {
  const { id, name, description, sourceLocation, evidence } = concept;
  return { id, name, description, sourceLocation, evidence };
}

export function conceptCitations(concept: Concept, material: Material): Citation[] {
  const citations = [{ sourceLocation: concept.sourceLocation, evidence: concept.evidence }, ...(concept.citations ?? [])];
  const unique = new Map<string, Citation>();
  for (const citation of citations) {
    ensure(material.sources.some((source) => source.location === citation.sourceLocation && source.text.includes(citation.evidence)), "Concept citation is not grounded in this material.", "INPUT");
    unique.set(JSON.stringify(citation), citation);
  }
  return [...unique.values()];
}

export function organizationBatches(concepts: Concept[]): Concept[][] {
  const batches: Concept[][] = [];
  let current: Concept[] = [];
  let characters = 0;
  for (const concept of concepts) {
    const size = JSON.stringify(organizationSummary(concept)).length;
    if (current.length && (current.length >= 12 || characters + size > 6000)) {
      batches.push(current);
      current = [];
      characters = 0;
    }
    current.push(concept);
    characters += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

export function organizationSummary(concept: Concept) {
  return { id: concept.id, name: concept.name.slice(0, 160), description: concept.description.slice(0, 400), evidence: concept.evidence.slice(0, 160) };
}

export function batchMaterial(material: Material, maxCharacters = 6000): Material[] {
  ensure(Number.isInteger(maxCharacters) && maxCharacters >= 1000 && maxCharacters <= 12000, "AI_BATCH_CHARACTERS must be an integer from 1000 to 12000.", "CONFIG");
  const batches: Material[] = [];
  let sources: Material["sources"] = [];
  let characters = 0;
  for (const source of material.sources) {
    for (let offset = 0; offset < source.text.length; offset += maxCharacters) {
      const fragment = source.text.slice(offset, offset + maxCharacters);
      if (!fragment.trim()) continue;
      if (sources.length && (characters + fragment.length > maxCharacters || sources.length >= 20)) {
        batches.push({ ...material, sources });
        sources = [];
        characters = 0;
      }
      sources.push({ ...source, text: fragment });
      characters += fragment.length;
    }
  }
  if (sources.length) batches.push({ ...material, sources });
  return batches;
}

export function conceptWindows(concepts: Concept[]): Concept[][] {
  const windows: Concept[][] = [];
  for (let offset = 0; offset < concepts.length;) {
    let end = offset;
    let characters = 0;
    while (end < concepts.length && end - offset < 10) {
      const size = JSON.stringify(concepts[end]).length;
      if (end - offset >= 2 && characters + size > 8000) break;
      characters += size;
      end++;
    }
    windows.push(concepts.slice(offset, end));
    if (end >= concepts.length) break;
    offset = Math.max(offset + 1, end - 2);
  }
  return windows;
}

export function relationKey(relation: Relation): string {
  const pair = relation.type === "RELATED" ? [relation.source, relation.target].sort() : [relation.source, relation.target];
  return JSON.stringify([relation.type, ...pair]);
}
