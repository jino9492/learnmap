interface PathGraph {
  concepts: { id: string; name: string }[];
  relations: {
    source: string;
    target: string;
    type: string;
    reason?: string;
  }[];
}

export function companionConcepts(
  graph: PathGraph,
  pathIds: string[],
  excludePath = true,
) {
  const included = new Set(pathIds);
  const valid = new Set(graph.concepts.map((concept) => concept.id));
  const companions = new Map<string, Map<string, string>>();
  for (const relation of graph.relations) {
    if (
      relation.type !== "RELATED" ||
      relation.source === relation.target ||
      !valid.has(relation.source) ||
      !valid.has(relation.target)
    )
      continue;
    // Relatedness is symmetric and never adds a prerequisite or a path step.
    for (const [anchor, candidate] of [
      [relation.source, relation.target],
      [relation.target, relation.source],
    ]) {
      if (!included.has(anchor) || (excludePath && included.has(candidate)))
        continue;
      if (!companions.has(candidate)) companions.set(candidate, new Map());
      companions.get(candidate)!.set(anchor, relation.reason ?? "");
    }
  }
  return graph.concepts
    .filter((concept) => companions.has(concept.id))
    .map((concept) => ({
      conceptId: concept.id,
      connections: [...companions.get(concept.id)!].map(
        ([conceptId, reason]) => ({ conceptId, reason }),
      ),
    }));
}

interface PathProgress {
  conceptId: string;
  score: number;
  status: string;
}

// Only prerequisites establish a learning order; hierarchy and relatedness do not.
export function buildLearningPath(
  graph: PathGraph,
  progress: PathProgress[] = [],
  targetId?: string,
) {
  const concepts = new Map(
    graph.concepts.map((concept) => [concept.id, concept]),
  );
  if (targetId && !concepts.has(targetId)) return null;
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  for (const relation of graph.relations) {
    if (
      relation.type !== "PREREQUISITE" ||
      !concepts.has(relation.source) ||
      !concepts.has(relation.target)
    )
      continue;
    if (!incoming.has(relation.target))
      incoming.set(relation.target, new Set());
    if (!outgoing.has(relation.source))
      outgoing.set(relation.source, new Set());
    incoming.get(relation.target)!.add(relation.source);
    outgoing.get(relation.source)!.add(relation.target);
  }
  const included = new Set<string>();
  const pending = targetId ? [targetId] : [...concepts.keys()];
  while (pending.length) {
    const id = pending.pop()!;
    if (included.has(id)) continue;
    included.add(id);
    pending.push(...(incoming.get(id) ?? []));
  }
  const records = new Map(progress.map((entry) => [entry.conceptId, entry]));
  const priority = (id: string) => {
    const entry = records.get(id);
    if (!entry || entry.status === "NOT_STARTED") return 50;
    if (entry.status === "MASTERED") return 101;
    return entry.score;
  };
  const remaining = new Map(
    [...included].map((id) => [id, incoming.get(id)?.size ?? 0]),
  );
  // Keep ties stable as concepts become available.
  const ready = graph.concepts
    .filter(({ id }) => included.has(id) && remaining.get(id) === 0)
    .map(({ id }) => id);
  const steps: { conceptId: string; reason: string }[] = [];
  while (ready.length) {
    ready.sort((a, b) => priority(a) - priority(b));
    const id = ready.shift()!;
    const record = records.get(id);
    const state =
      record?.status === "MASTERED"
        ? "이해를 완료한 개념입니다. 필요할 때 복습하세요."
        : !record || record.status === "NOT_STARTED"
          ? "아직 학습 기록이 없는 개념입니다."
          : `현재 이해도 ${record.score}%로, 학습 보완이 필요합니다.`;
    steps.push({
      conceptId: id,
      reason: `${concepts.get(id)!.name}: ${state} 선수 개념을 먼저 배치하고, 같은 단계에서는 이해도가 낮은 개념을 우선합니다.`,
    });
    for (const next of outgoing.get(id) ?? []) {
      if (!included.has(next)) continue;
      const count = remaining.get(next)! - 1;
      remaining.set(next, count);
      if (count === 0) ready.push(next);
    }
  }
  if (!steps.length || steps.length !== included.size) return null;
  return {
    steps,
    possibleCause: `${targetId ? "목표 개념과 연결된 모든 선수 개념을" : "과목의 전체 개념을"} 선수 관계에 따라 배치했습니다. 학습 기록이 있으면 선수 순서를 유지하면서 이해도가 낮은 개념을 우선합니다. 완료한 개념도 전체 흐름을 볼 수 있도록 표시합니다.`,
  };
}
