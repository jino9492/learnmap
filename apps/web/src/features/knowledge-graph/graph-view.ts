import type {
  Concept,
  Relation,
} from "../../../../api/src/ai/core/contracts.ts";

export interface DisplayConcept extends Concept {
  members?: Concept[];
  groupSize?: number;
  representative?: boolean;
  searchText?: string;
}
export interface ExplorationGroup {
  id: string;
  name: string;
  memberIds: string[];
}

export function conceptProjection(
  concepts: Concept[],
  relations: Relation[],
  equivalences: { memberIds: string[] }[] = [],
  coreGroups: { name: string; description: string; memberIds: string[] }[] = [],
) {
  const byId = new Map(concepts.map((concept) => [concept.id, concept]));
  const canonicalIds = new Map(
    concepts.map((concept) => [concept.id, concept.id]),
  );
  for (const group of equivalences) {
    const members = group.memberIds.flatMap((id) =>
      byId.has(id) ? [byId.get(id)!] : [],
    );
    const canonical = [...members].sort(
      (a, b) => a.name.length - b.name.length,
    )[0];
    if (!canonical) continue;
    for (const member of members) canonicalIds.set(member.id, canonical.id);
  }
  const representatives = new Map<string, (typeof coreGroups)[number]>();
  for (const group of coreGroups) {
    const aliases = new Set(
      group.memberIds
        .map((id) => canonicalIds.get(id))
        .filter((id) => id !== undefined),
    );
    const canonical = group.memberIds
      .map((id) => canonicalIds.get(id))
      .find((id) => id !== undefined);
    if (!canonical) continue;
    for (const [id, alias] of canonicalIds)
      if (aliases.has(alias)) canonicalIds.set(id, canonical);
    representatives.set(canonical, group);
  }
  const buckets = new Map<string, Concept[]>();
  for (const concept of concepts) {
    const id = canonicalIds.get(concept.id)!;
    const members = buckets.get(id) ?? [];
    members.push(concept);
    buckets.set(id, members);
  }
  const displayed: DisplayConcept[] = [...buckets].map(([id, members]) => {
    const canonical = byId.get(id)!;
    const citations = members
      .flatMap((member) => [member, ...(member.citations ?? [])])
      .map(({ sourceLocation, evidence }) => ({ sourceLocation, evidence }));
    return {
      ...canonical,
      ...(representatives.has(id)
        ? {
            name: representatives.get(id)!.name,
            description: representatives.get(id)!.description,
            representative: true,
          }
        : {}),
      members,
      searchText: members
        .flatMap((member) => [
          member.name,
          member.description,
          ...(member.details ?? []).map((detail) => detail.name),
        ])
        .join(" "),
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
      citations: [
        ...new Map(
          citations.map((citation) => [JSON.stringify(citation), citation]),
        ).values(),
      ],
    };
  });
  const links = new Map<string, Relation>();
  for (const edge of relations) {
    const source = canonicalIds.get(edge.source);
    const target = canonicalIds.get(edge.target);
    if (!source || !target || source === target) continue;
    const endpoints =
      edge.type === "RELATED" ? [source, target].sort() : [source, target];
    links.set(JSON.stringify([edge.type, endpoints]), {
      ...edge,
      source,
      target,
    });
  }
  return { concepts: displayed, relations: [...links.values()], canonicalIds };
}

export function prerequisiteConcepts(
  projection: ReturnType<typeof conceptProjection>,
  relations: Relation[],
  conceptId: string,
) {
  const target = projection.canonicalIds.get(conceptId);
  if (!target) return [];
  const sources = new Map<string, string>();
  for (const edge of relations) {
    if (
      edge.type !== "PREREQUISITE" ||
      projection.canonicalIds.get(edge.target) !== target
    )
      continue;
    const source = projection.canonicalIds.get(edge.source);
    if (source && source !== target && !sources.has(source))
      sources.set(source, edge.source);
  }
  return projection.concepts
    .filter((concept) => sources.has(concept.id))
    .map((concept) => ({ ...concept, id: sources.get(concept.id)! }));
}

// These are navigation communities, never taxonomic or prerequisite claims.
export function explorationGroups(
  concepts: { id: string; name?: string }[],
  relations: Pick<Relation, "source" | "target" | "type">[],
  capacity = 10,
): ExplorationGroup[] {
  const ids = new Set(concepts.map((concept) => concept.id));
  const neighbors = new Map(
    concepts.map((concept) => [concept.id, new Map<string, number>()]),
  );
  for (const edge of relations) {
    if (
      !ids.has(edge.source) ||
      !ids.has(edge.target) ||
      edge.source === edge.target
    )
      continue;
    const weight = edge.type === "RELATED" ? 1 : 3;
    for (const [a, b] of [
      [edge.source, edge.target],
      [edge.target, edge.source],
    ]) {
      const entries = neighbors.get(a)!;
      entries.set(b, (entries.get(b) ?? 0) + weight);
    }
  }
  const degrees = new Map(
    [...neighbors].map(([id, entries]) => [
      id,
      [...entries.values()].reduce((a, b) => a + b, 0),
    ]),
  );
  const degree = (id: string) => degrees.get(id)!;
  const remaining = new Set(concepts.map((concept) => concept.id));
  const groups: ExplorationGroup[] = [];
  while (remaining.size) {
    const seed = [...remaining].sort(
      (a, b) => degree(b) - degree(a) || a.localeCompare(b),
    )[0];
    const members = [seed];
    remaining.delete(seed);
    while (members.length < capacity && remaining.size) {
      const affinity = (id: string) =>
        members.reduce(
          (sum, member) => sum + (neighbors.get(member)!.get(id) ?? 0),
          0,
        );
      const next = [...remaining].sort(
        (a, b) =>
          affinity(b) - affinity(a) ||
          degree(b) - degree(a) ||
          a.localeCompare(b),
      )[0];
      members.push(next);
      remaining.delete(next);
    }
    const title =
      concepts.find((concept) => concept.id === seed)?.name ?? "개념";
    groups.push({
      id: `group:${seed}`,
      name: `${title} 등`,
      memberIds: members,
    });
  }
  return groups;
}

export function radialGraphLayout(
  concepts: { id: string; name?: string }[],
  relations: Pick<Relation, "source" | "target" | "type">[],
) {
  const ids = new Set(concepts.map((concept) => concept.id));
  const links = relations.filter(
    (edge) =>
      ids.has(edge.source) &&
      ids.has(edge.target) &&
      edge.source !== edge.target,
  );
  const incoming = new Map(concepts.map((concept) => [concept.id, 0]));
  const neighbors = new Map(
    concepts.map((concept) => [concept.id, new Map<string, number>()]),
  );
  for (const edge of links) {
    if (edge.type !== "RELATED")
      incoming.set(edge.target, incoming.get(edge.target)! + 1);
    const forward = neighbors.get(edge.source)!;
    forward.set(
      edge.target,
      Math.max(forward.get(edge.target) ?? 0, edge.type === "RELATED" ? 1 : 4),
    );
    if (edge.type === "RELATED")
      neighbors.get(edge.target)!.set(edge.source, 1);
  }
  const degree = (id: string) =>
    [...neighbors.get(id)!.values()].reduce((sum, weight) => sum + weight, 0);
  const compare = (a: string, b: string) =>
    degree(b) - degree(a) || a.localeCompare(b);
  const remaining = new Set(ids);
  const children = new Map(
    concepts.map((concept) => [concept.id, [] as string[]]),
  );
  const depths = new Map<string, number>();
  const rootIds: string[] = [];
  // A spanning forest guides placement only; it never adds semantic edges to the graph.
  while (remaining.size) {
    const available = [...remaining];
    const root =
      available.filter((id) => incoming.get(id) === 0).sort(compare)[0] ??
      available.sort(compare)[0];
    rootIds.push(root);
    remaining.delete(root);
    depths.set(root, 1);
    const queue = [root];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const id = queue[cursor];
      const depth = depths.get(id)!;
      const next = [...neighbors.get(id)!].sort(
        (a, b) => b[1] - a[1] || compare(a[0], b[0]),
      );
      for (const [target, weight] of next) {
        if (!remaining.has(target)) continue;
        // Undirected chains should not produce dozens of artificial hierarchy levels.
        if (weight === 1 && (depth >= 4 || incoming.get(target)! > 0)) continue;
        children.get(id)!.push(target);
        remaining.delete(target);
        depths.set(target, depth + 1);
        queue.push(target);
      }
    }
  }
  const mass = new Map<string, number>();
  const measure = (id: string): number => {
    const size = Math.max(
      1,
      children.get(id)!.reduce((sum, child) => sum + measure(child), 0),
    );
    mass.set(id, size);
    return size;
  };
  const total = rootIds.reduce((sum, id) => sum + measure(id), 0);
  const angles = new Map<string, number>();
  const assign = (id: string, start: number, span: number) => {
    angles.set(id, start + span / 2);
    let offset = start;
    for (const child of children.get(id)!) {
      const width = (span * mass.get(child)!) / mass.get(id)!;
      assign(child, offset, width);
      offset += width;
    }
  };
  let offset =
    -Math.PI / 2 -
    (rootIds.length ? (Math.PI * mass.get(rootIds[0])!) / total : 0);
  for (const root of rootIds) {
    const span = (2 * Math.PI * mass.get(root)!) / total;
    assign(root, offset, span);
    offset += span;
  }
  const layers = new Map<number, string[]>();
  for (const [id, depth] of depths) {
    const layer = layers.get(depth) ?? [];
    layer.push(id);
    layers.set(depth, layer);
  }
  const positions = new Map<string, { x: number; y: number }>();
  let previousRadius = 0;
  for (const [, layer] of [...layers].sort((a, b) => a[0] - b[0])) {
    layer.sort((a, b) => angles.get(a)! - angles.get(b)!);
    const bands = Math.ceil(layer.length / 24);
    for (let band = 0; band < bands; band++) {
      const members = layer.filter((_, index) => index % bands === band);
      let radius = Math.max(
        previousRadius + 120,
        Math.ceil((members.length * 220) / (2 * Math.PI)) + 10,
      );
      let points: { id: string; x: number; y: number }[] = [];
      for (;;) {
        const adjusted = members.map((id) => angles.get(id)!);
        const gap = 2 * Math.asin(Math.min(1, 110 / radius));
        // Relax neighboring angles within a layer instead of inflating a narrow branch's entire circle.
        for (
          let iteration = 0;
          iteration < 240 && adjusted.length > 1;
          iteration++
        ) {
          let error = 0;
          for (let index = 0; index < adjusted.length; index++) {
            const next = (index + 1) % adjusted.length;
            const distance =
              adjusted[next] + (next === 0 ? 2 * Math.PI : 0) - adjusted[index];
            const correction = Math.max(0, gap - distance) / 2;
            adjusted[index] -= correction;
            adjusted[next] += correction;
            error = Math.max(error, correction);
          }
          if (error < 0.00001) break;
        }
        points = members.map((id, index) => ({
          id,
          x: Math.cos(adjusted[index]) * radius,
          y: Math.sin(adjusted[index]) * radius,
        }));
        const occupied = [{ x: 0, y: 0 }, ...positions.values()];
        const overlap = points.some((point, index) =>
          [...occupied, ...points.slice(index + 1)].some(
            (other) =>
              Math.abs(point.x - other.x) < 190 &&
              Math.abs(point.y - other.y) < 100,
          ),
        );
        if (!overlap) break;
        radius += 16;
      }
      for (const point of points)
        positions.set(point.id, { x: point.x, y: point.y });
      previousRadius = radius;
    }
  }
  const values = [{ x: 0, y: 0 }, ...positions.values()];
  const minX = Math.min(...values.map((point) => point.x)) - 120;
  const maxX = Math.max(...values.map((point) => point.x)) + 120;
  const minY = Math.min(...values.map((point) => point.y)) - 90;
  const maxY = Math.max(...values.map((point) => point.y)) + 90;
  const width = Math.max(846, maxX - minX);
  const height = Math.max(646, maxY - minY);
  const center = {
    x: -minX + (width - (maxX - minX)) / 2,
    y: -minY + (height - (maxY - minY)) / 2,
  };
  for (const point of positions.values()) {
    point.x += center.x;
    point.y += center.y;
  }
  return {
    positions,
    roots: concepts.filter((concept) => rootIds.includes(concept.id)),
    width,
    height,
    center,
  };
}
