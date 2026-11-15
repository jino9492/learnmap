import type { Concept, Relation } from "../../ai/core/contracts.ts";

export interface CoreConceptGroup {
  name: string;
  description: string;
  memberIds: string[];
}

const normalize = (value: string) => value.replace(/\s+/g, "").toLowerCase();
// Explicit facets describe a named subject; subtypes, history and transitions stay separate.
const facet =
  /^(?:정의|개념|의미|구성|구조|작동|동작|원리|특징|특성|장점|단점|강점|약점|한계점?|활용|응용|산업\s*적용|적용\s*사례|문제점|규칙\s*유지보수|유지보수|지식\s*획득|지식\s*베이스|추론\s*엔진)(?:$|\s|와|과|및|·)/;

export function representativeConceptGroups(
  concepts: Concept[],
  relations: Pick<Relation, "source" | "target" | "type">[] = [],
): CoreConceptGroup[] {
  const candidates = new Map<string, { name: string; members: Concept[] }>();
  for (const concept of concepts) {
    const match = /^(.+?)의\s+(.+)$/.exec(concept.name.trim());
    if (!match || !facet.test(match[2]) || /비교|차이|전환|역사|시대|경쟁/.test(match[2])) continue;
    const key = normalize(match[1]);
    const group = candidates.get(key) ?? { name: match[1].trim(), members: [] };
    group.members.push(concept);
    candidates.set(key, group);
  }
  const groups: CoreConceptGroup[] = [];
  const used = new Set<string>();
  for (const [key, candidate] of candidates) {
    const root = concepts.find((concept) => normalize(concept.name) === key);
    const members = [...(root ? [root] : []), ...candidate.members];
    if (members.length < 2 || members.some((member) => used.has(member.id)))
      continue;
    const ids = new Set(members.map((member) => member.id));
    // Keep prerequisite steps independently visible, even when their names share a subject.
    let dependent = false;
    for (const member of members) {
      const pending = [member.id];
      const seen = new Set<string>();
      while (pending.length) {
        const id = pending.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const edge of relations) {
          if (edge.type !== "PREREQUISITE" || edge.source !== id) continue;
          if (ids.has(edge.target) && edge.target !== member.id)
            dependent = true;
          pending.push(edge.target);
        }
      }
    }
    if (dependent) continue;
    for (const member of members) used.add(member.id);
    groups.push({
      name: root?.name ?? candidate.name,
      description: (root ?? members[0]).description,
      memberIds: members.map((member) => member.id),
    });
  }
  return groups;
}

export function collapseConceptFacets(concepts: Concept[]): Concept[] {
  const groups = representativeConceptGroups(concepts);
  const byMember = new Map(
    groups.flatMap((group) =>
      group.memberIds.map((id) => [id, group] as const),
    ),
  );
  const emitted = new Set<CoreConceptGroup>();
  return concepts.flatMap((concept) => {
    const group = byMember.get(concept.id);
    if (!group) return [concept];
    if (emitted.has(group)) return [];
    emitted.add(group);
    const members = group.memberIds.map((id) =>
      concepts.find((member) => member.id === id)!,
    );
    const citations = members
      .flatMap((member) => [member, ...(member.citations ?? [])])
      .map(({ sourceLocation, evidence }) => ({ sourceLocation, evidence }));
    return [
      {
        ...members[0],
        name: group.name,
        description: group.description,
        memberConceptIds: [
          ...new Set(
            members.flatMap((member) => member.memberConceptIds ?? [member.id]),
          ),
        ],
        citations: [
          ...new Map(
            citations.map((citation) => [JSON.stringify(citation), citation]),
          ).values(),
        ],
        details: members.flatMap(
          (member) =>
            member.details ?? [
              {
                name: member.name,
                description: member.description,
                sourceLocation: member.sourceLocation,
                evidence: member.evidence,
              },
            ],
        ),
      },
    ];
  });
}
