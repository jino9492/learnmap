import type {
  Concept,
  Relation,
  LlmClient,
  AnalysisProgress,
} from "../core/contracts.ts";
import type { BatchOptions } from "../core/batches.ts";
import { mapBatches } from "../core/batches.ts";
import { boundedText, choice, list, object } from "../core/schema.ts";
import { AiError, ensure } from "../core/errors.ts";
import { partitionRequests } from "../core/partition.ts";
import { safety } from "../core/prompts.ts";

export interface EquivalenceGroup {
  memberIds: string[];
  reason: string;
}
const normalize = (value: string) =>
  value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
const identity = (name: string) =>
  normalize(name).replace(/(?:의정의|의개념|의의미|정의)$/, "");
const terms = (value: string) =>
  new Set(value.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []);

export function equivalenceSignature(
  concepts: Concept[],
  relations: Relation[],
): string {
  return JSON.stringify([
    concepts.map(
      ({ id, name, description, sourceLocation, evidence, citations }) => ({
        id,
        name,
        description,
        sourceLocation,
        evidence,
        citations,
      }),
    ),
    relations.filter((edge) => edge.type !== "RELATED"),
  ]);
}

// Projection only: preserve original IDs, lessons and learner records behind each displayed concept.
export function equivalentGroups(
  concepts: Concept[],
  relations: Relation[],
  confirmed: EquivalenceGroup[] = [],
): EquivalenceGroup[] {
  const ids = new Set(concepts.map((concept) => concept.id));
  const parent = new Map(concepts.map((concept) => [concept.id, concept.id]));
  const find = (id: string): string => {
    const next = parent.get(id)!;
    return next === id ? id : find(next);
  };
  function join(left: string, right: string) {
    if (!ids.has(left) || !ids.has(right)) return;
    const a = find(left);
    const b = find(right);
    if (a === b) return;
    const reachable = (start: string, target: string) => {
      const queue = [start];
      const seen = new Set<string>();
      while (queue.length) {
        const id = queue.pop()!;
        if (id === target) return true;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const edge of relations)
          if (
            edge.type !== "RELATED" &&
            ids.has(edge.source) &&
            ids.has(edge.target) &&
            find(edge.source) === id
          )
            queue.push(find(edge.target));
      }
      return false;
    };
    if (reachable(a, b) || reachable(b, a)) return;
    parent.set(b, a);
  }
  for (let a = 0; a < concepts.length; a++)
    for (let b = a + 1; b < concepts.length; b++) {
      const left = concepts[a];
      const right = concepts[b];
      if (identity(left.name) !== identity(right.name)) continue;
      const tokens = terms(left.description);
      const other = terms(right.description);
      const overlap =
        [...tokens].filter((token) => other.has(token)).length /
        Math.max(1, Math.min(tokens.size, other.size));
      const sameLabelWithContext =
        normalize(left.name) === normalize(right.name) &&
        relations.some(
          (edge) =>
            edge.type === "RELATED" &&
            ((edge.source === left.id && edge.target === right.id) ||
              (edge.source === right.id && edge.target === left.id)),
        );
      if (
        sameLabelWithContext ||
        normalize(left.description) === normalize(right.description) ||
        left.evidence === right.evidence ||
        (normalize(left.name) !== normalize(right.name) && overlap >= 0.3)
      )
        join(left.id, right.id);
    }
  for (const group of confirmed)
    for (const id of group.memberIds.slice(1)) join(group.memberIds[0], id);
  const groups = new Map<string, string[]>();
  for (const concept of concepts) {
    const key = find(concept.id);
    const entries = groups.get(key) ?? [];
    entries.push(concept.id);
    groups.set(key, entries);
  }
  return [...groups.values()]
    .filter((members) => members.length > 1)
    .map((memberIds) => ({
      memberIds,
      reason: "같은 개념의 원본 학습 항목을 함께 표시합니다.",
    }));
}

const instructions = `${safety}
Task: Decide whether each supplied pair is the SAME learning concept under alternate wording, across document batches.
EQUIVALENT requires the same underlying concept identity. Different document sources, wording, examples,
historical context or assessment coverage do not make two descriptions of that same concept DISTINCT.
A definition and its concept may be equivalent. When identical names refer to the same subject in the evidence,
consolidate them even if one excerpt explains its definition and another its adoption or use.
Shared topic, broader/narrower concepts, mechanisms, applications, examples, prerequisites, and overlapping headings
are DISTINCT. Preserve separately assessable ideas. Homonyms in different contexts are DISTINCT. Prefer DISTINCT when unsure.
Use the supplied exact excerpts and summaries, never invent facts. Return exactly one decision per pair ID with a concise reason.
This proposes display consolidation only; original content and learner records are preserved.`;

export async function inferEquivalentGroups(
  client: LlmClient,
  concepts: Concept[],
  relations: Relation[],
  options: BatchOptions = {},
  onProgress?: (progress: AnalysisProgress) => void,
): Promise<EquivalenceGroup[]> {
  const deadline = Date.now() + 30_000;
  const pairs: { id: string; left: Concept; right: Concept }[] = [];
  for (let a = 0; a < concepts.length; a++)
    for (let b = a + 1; b < concepts.length; b++) {
      const left = concepts[a];
      const right = concepts[b];
      const l = identity(left.name);
      const r = identity(right.name);
      const lt = terms(left.name);
      const rt = terms(right.name);
      const overlap = [...lt].filter((term) => rt.has(term)).length;
      const ratio =
        Math.min(l.length, r.length) / Math.max(1, l.length, r.length);
      const acronym =
        (left.name.match(/\b[A-Z][A-Z0-9-]+\b/g) ?? []).some(
          (word) => normalize(word) === r,
        ) ||
        (right.name.match(/\b[A-Z][A-Z0-9-]+\b/g) ?? []).some(
          (word) => normalize(word) === l,
        );
      if (
        l === r ||
        acronym ||
        (ratio >= 0.65 &&
          Math.min(l.length, r.length) >= 4 &&
          (l.includes(r) || r.includes(l))) ||
        (overlap >= 2 && ratio >= 0.7)
      ) {
        pairs.push({ id: `p${pairs.length + 1}`, left, right });
      }
    }
  const build = (entries: typeof pairs) => {
    const nodes = [
      ...new Map(
        entries
          .flatMap((pair) => [pair.left, pair.right])
          .map((concept) => [concept.id, concept]),
      ).values(),
    ];
    const aliases = new Map(
      nodes.map((concept, index) => [concept.id, `n${index + 1}`]),
    );
    const schema = object({
      decisions: list(
        object({
          pairId: choice(...entries.map((pair) => pair.id)),
          verdict: choice("EQUIVALENT", "DISTINCT"),
          reason: boundedText(200),
        }),
        entries.length,
        entries.length,
      ),
    });
    return {
      name: "concept_equivalence",
      instructions,
      schema,
      data: {
        concepts: nodes.map((concept) => ({
          id: aliases.get(concept.id),
          name: concept.name,
          summary: concept.description.slice(0, 250),
          evidence: concept.evidence.slice(0, 350),
        })),
        pairs: entries.map((pair) => ({
          id: pair.id,
          left: aliases.get(pair.left.id),
          right: aliases.get(pair.right.id),
        })),
      },
    };
  };
  const batches = pairs.flatMap((_, index) =>
    index % 8 === 0
      ? partitionRequests(pairs.slice(index, index + 8), build)
      : [],
  );
  let completed = 0;
  const results = await mapBatches(
    batches,
    options.concurrency,
    async (entries) => {
      const request = build(entries);
      const validate = (value: unknown) => {
        const result = request.schema.parse(value);
        ensure(
          new Set(result.decisions.map((entry) => entry.pairId)).size ===
            entries.length,
          "Equivalence review must decide every pair exactly once.",
          "FORMAT",
        );
        return result;
      };
      const produce = () => {
        if (Date.now() >= deadline)
          throw new AiError(
            "TIMEOUT",
            "Concept equivalence review reached its time budget.",
          );
        return client.generate({
          ...request,
          deadlineAt: deadline,
          maxAttempts: 1,
        });
      };
      const result = options.checkpoints
        ? await options.checkpoints.run(
            { ...request, schema: request.schema.json },
            produce,
            validate,
          )
        : validate(await produce());
      onProgress?.({
        stage: "organization",
        completed: ++completed,
        total: batches.length,
        detail: "파일·배치를 넘는 동일 개념을 확인하고 있습니다.",
      });
      return result.decisions.flatMap((decision) => {
        const pair = entries.find((pair) => pair.id === decision.pairId)!;
        return decision.verdict === "EQUIVALENT"
          ? [
              {
                memberIds: [pair.left.id, pair.right.id],
                reason: decision.reason,
              },
            ]
          : [];
      });
    },
  );
  return equivalentGroups(concepts, relations, results.flat());
}
