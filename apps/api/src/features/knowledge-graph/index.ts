import type { Graph } from "../../ai/core/contracts.ts";
import { ensure } from "../../ai/core/errors.ts";

export function validateGraph(graph: Graph): void {
  const ids = new Set(graph.concepts.map((concept) => concept.id));
  ensure(ids.size === graph.concepts.length && ids.size > 0, "Concept IDs must be unique and nonempty.");
  const keys = new Set<string>();
  const outgoing = new Map<string, string[]>();
  for (const relation of graph.relations) {
    ensure(ids.has(relation.source) && ids.has(relation.target), "Relation references an unknown concept.");
    ensure(relation.source !== relation.target, "Self-relations are not allowed.");
    const pair = relation.type === "RELATED" ? [relation.source, relation.target].sort() : [relation.source, relation.target];
    const key = JSON.stringify([relation.type, ...pair]);
    ensure(!keys.has(key), "Duplicate relation.");
    keys.add(key);
    if (relation.type === "PREREQUISITE") {
      outgoing.set(relation.source, [...(outgoing.get(relation.source) ?? []), relation.target]);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    ensure(!visiting.has(id), "Prerequisite cycle detected.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of outgoing.get(id) ?? []) visit(next);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) visit(id);
}

export function prerequisiteContext(graph: Graph, targetId: string): Graph {
  validateGraph(graph);
  ensure(graph.concepts.some((concept) => concept.id === targetId), "Unknown target concept.", "INPUT");
  const included = new Set([targetId]);
  function addParents(id: string): void {
    for (const relation of graph.relations) {
      if (relation.type === "PREREQUISITE" && relation.target === id && !included.has(relation.source)) {
        included.add(relation.source);
        addParents(relation.source);
      }
    }
  }
  addParents(targetId);
  return {
    concepts: graph.concepts.filter((concept) => included.has(concept.id)),
    relations: graph.relations.filter((relation) => relation.type === "PREREQUISITE" && included.has(relation.source) && included.has(relation.target)),
  };
}
