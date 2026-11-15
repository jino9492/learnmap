import type {
  AnalysisProgress,
  Citation,
  Concept,
  LlmClient,
  Material,
  Relation,
} from "../core/contracts.ts";
import type { BatchOptions } from "../core/batches.ts";
import { mapBatches } from "../core/batches.ts";
import { boundedText, choice, list, object, score } from "../core/schema.ts";
import { AiError, ensure } from "../core/errors.ts";
import {
  partitionRequests,
  requestCharacters,
  REQUEST_CHARACTERS,
  runPartition,
} from "../core/partition.ts";
import { safety } from "../core/prompts.ts";
import {
  conceptCitations,
  relationKey,
} from "../../features/material-analysis/index.ts";
import { validateGraph } from "../../features/knowledge-graph/index.ts";
import { relationEvidence } from "./evidence.ts";
import { hierarchyDirectionFromText } from "./direction.ts";

interface Options extends BatchOptions {
  changedMaterialId?: string;
  existingRelations?: Relation[];
}
interface Pair {
  id: string;
  left: string;
  right: string;
  anchor: string;
}
interface Node {
  id: string;
  concept: Concept;
  evidence: Citation[];
}

const candidateInstructions = `${safety}
Task: Supplement code-based retrieval with cross-document conceptual candidates. This is retrieval, not a final graph.
Descriptions are generated hints, not facts. Include plausible taxonomy, prerequisites, equivalent terminology and
specific meaningful associations, even with different wording. Shared domain alone is insufficient. Do not invent pairs.
Return selected: [{left, right, score}], scoring relevance from 0 to 100. left must be a query ID and right one of
that query's allowedTargets. Search the entire target catalog, including differently worded terminology and implied
prerequisites. Choose up to 4 useful targets per query. Omit clearly unrelated targets. Never assert direction.
Do not enumerate every combination. Keep distinct mechanisms distinct. Return no more than 16 candidates per batch.`;

const judgmentInstructions = `${safety}
Task: Independently decide EVERY explicit pair using ONLY the exact evidence catalog. Screening is not evidence.
Return exactly one decision per pair: pairId, type (NONE, RELATED, PARENT_CHILD, PREREQUISITE), source, target,
evidenceIds and a short reason. The supplied pair is UNORDERED: choose direction from the source facts, not pair order.
Source and target must be the pair's two distinct endpoint IDs. NONE still copies those two IDs and uses evidenceIds: [].
PARENT_CHILD: source is broader; target is a KIND OF source. A component, application, example, historical successor
or shared topic is not a subtype. If A is a kind of B, source is B and target is A.
PREREQUISITE: source is specifically required knowledge to understand target. State what knowledge is required.
Membership, chronology, co-occurrence and usefulness alone are not prerequisites. RELATED needs a specific supported
association; a shared broad field is insufficient. Prefer NONE to guessing. Missing context cannot establish a relation.
Every accepted decision requires evidenceIds belonging to its endpoints. Never borrow other pairs' evidence.
Inspect supplied contrasts and exceptions. Descriptions and model-generated lessons are not source facts.
Never invent concepts, quotes or relationships. A reason contradicting the chosen direction must be corrected silently.`;

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, "");

// All eligible cross-document pairs are screened once, even when a merged node's primary source is older.
export function crossMaterialPlan(
  material: Material,
  concepts: Concept[],
  changedMaterialId?: string,
) {
  const nodes: Node[] = concepts.map((concept, index) => ({
    id: `n${index + 1}`,
    concept,
    evidence: relationEvidence(concept, material),
  }));
  const origins = new Map<string, Node[]>();
  const changed = new Set(
    concepts
      .filter((concept) =>
        conceptCitations(concept, material).some(
          (citation) =>
            citation.sourceLocation.split("/")[0] === changedMaterialId,
        ),
      )
      .map((concept) => concept.id),
  );
  for (const node of nodes) {
    const origin = node.concept.sourceLocation.split("/")[0];
    const entries = origins.get(origin) ?? [];
    entries.push(node);
    origins.set(origin, entries);
  }
  const pairs: Pair[] = [];
  const groups = [...origins.values()];
  for (let a = 0; a < groups.length; a++)
    for (let b = a + 1; b < groups.length; b++) {
      const [anchors, targets] =
        groups[a].length <= groups[b].length
          ? [groups[a], groups[b]]
          : [groups[b], groups[a]];
      for (const left of anchors)
        for (const right of targets) {
          if (
            changedMaterialId &&
            !changed.has(left.concept.id) &&
            !changed.has(right.concept.id)
          )
            continue;
          pairs.push({
            id: `p${pairs.length + 1}`,
            left: left.id,
            right: right.id,
            anchor: `${a}:${b}:${left.id}`,
          });
        }
    }
  return { nodes, pairs };
}

function focusedQuote(citation: Citation, names: string[]): Citation {
  if (citation.evidence.length <= 450) return citation;
  const position =
    names
      .map((name) => citation.evidence.indexOf(name))
      .find((index) => index >= 0) ?? 0;
  const start = Math.max(
    0,
    Math.min(position - 120, citation.evidence.length - 450),
  );
  return { ...citation, evidence: citation.evidence.slice(start, start + 450) };
}

export function crossMaterialRequests(
  material: Material,
  concepts: Concept[],
  changedMaterialId?: string,
) {
  const plan = crossMaterialPlan(material, concepts, changedMaterialId);
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));
  function screen(entries: Pair[]) {
    const ids = new Set(entries.flatMap((pair) => [pair.left, pair.right]));
    const queries = [...new Set(entries.map((pair) => pair.left))];
    const targets = [...new Set(entries.map((pair) => pair.right))];
    const schema = object({
      selected: list(
        object({ left: choice(...queries), right: choice(...targets), score }),
        0,
        Math.min(16, queries.length * 4),
      ),
    });
    return {
      name: "relation_candidates",
      instructions: candidateInstructions,
      data: {
        concepts: [...ids].map((id) => {
          const concept = byId.get(id)!.concept;
          return {
            id,
            name: concept.name,
            summary: concept.description.slice(0, 60),
          };
        }),
        queries: queries.map((id) => ({
          id,
          allowedTargets: entries
            .filter((pair) => pair.left === id)
            .map((pair) => pair.right),
        })),
      },
      schema,
    };
  }
  function judge(entries: Pair[]) {
    const ids = new Set(entries.flatMap((pair) => [pair.left, pair.right]));
    const quotes = new Map<
      string,
      { id: string; sourceLocation: string; text: string }
    >();
    const nodes = [...ids].map((id) => {
      const node = byId.get(id)!;
      const neighbors = entries
        .filter((pair) => pair.left === id || pair.right === id)
        .map(
          (pair) =>
            byId.get(pair.left === id ? pair.right : pair.left)!.concept.name,
        );
      const evidenceIds = node.evidence.map((citation) => {
        const focused = focusedQuote(citation, neighbors);
        const key = JSON.stringify(focused);
        if (!quotes.has(key))
          quotes.set(key, {
            id: `e${quotes.size + 1}`,
            sourceLocation: focused.sourceLocation,
            text: focused.evidence,
          });
        return quotes.get(key)!.id;
      });
      return {
        id,
        name: node.concept.name,
        evidenceIds: [...new Set(evidenceIds)],
      };
    });
    const schema = object({
      decisions: list(
        object({
          pairId: choice(...entries.map((pair) => pair.id)),
          type: choice("NONE", "RELATED", "PARENT_CHILD", "PREREQUISITE"),
          source: choice(...ids),
          target: choice(...ids),
          evidenceIds: list(
            choice(...[...quotes.values()].map((quote) => quote.id)),
            0,
            quotes.size,
          ),
          reason: boundedText(200),
        }),
        entries.length,
        entries.length,
      ),
    });
    return {
      name: "relation_adjudication",
      instructions: judgmentInstructions,
      data: {
        concepts: nodes,
        pairs: entries.map(({ id, left, right }) => ({ id, left, right })),
        evidence: [...quotes.values()],
      },
      schema,
    };
  }
  // Rectangular blocks share concept cards; a long row would resend every target's card.
  const domains = new Map<string, Pair[]>();
  for (const pair of plan.pairs) {
    const domain = pair.anchor.split(":").slice(0, 2).join(":");
    const entries = domains.get(domain) ?? [];
    entries.push(pair);
    domains.set(domain, entries);
  }
  const screeningBatches: Pair[][] = [];
  for (const pairs of domains.values()) {
    const anchors = [...new Set(pairs.map((pair) => pair.left))];
    for (let a = 0; a < anchors.length; a += 4) {
      const left = new Set(anchors.slice(a, a + 4));
      screeningBatches.push(
        ...partitionRequests(
          pairs.filter((pair) => left.has(pair.left)),
          screen,
        ),
      );
    }
  }
  return { ...plan, byId, screen, judge, screeningBatches };
}

// Inverse document frequency suppresses generic course-wide vocabulary without a new embedding service.
function retrievalScores(nodes: Node[], pairs: Pair[]) {
  const terms = new Map(
    nodes.map((node) => [
      node.id,
      new Set(
        (
          `${node.concept.name} ${node.concept.description} ${node.evidence.map((quote) => quote.evidence).join(" ")}`
            .toLowerCase()
            .match(/[\p{L}\p{N}]+/gu) ?? []
        ).filter((term) => term.length >= 2),
      ),
    ]),
  );
  const frequencies = new Map<string, number>();
  for (const tokens of terms.values())
    for (const term of tokens)
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  return new Map(
    pairs.map((pair) => {
      const left = terms.get(pair.left)!;
      const right = terms.get(pair.right)!;
      let overlap = 0;
      for (const term of left)
        if (
          right.has(term) &&
          frequencies.get(term)! <= Math.max(2, nodes.length * 0.4)
        ) {
          overlap += Math.log((nodes.length + 1) / frequencies.get(term)!);
        }
      return [pair.id, Math.min(65, overlap * 10)];
    }),
  );
}

function checkpointKey(request: {
  name: string;
  instructions: string;
  data: unknown;
  schema: { json: unknown };
}) {
  return {
    version: "cross-material-v5",
    name: request.name,
    instructions: request.instructions,
    data: request.data,
    schema: request.schema.json,
  };
}

export async function analyzeCrossMaterialRelations(
  client: LlmClient,
  material: Material,
  concepts: Concept[],
  onProgress?: (progress: AnalysisProgress) => void,
  options: Options = {},
): Promise<Relation[]> {
  validateGraph({ concepts, relations: options.existingRelations ?? [] });
  const plan = crossMaterialRequests(
    material,
    concepts,
    options.changedMaterialId,
  );
  const relations = new Map(
    (options.existingRelations ?? []).map((relation) => [
      relationKey(relation),
      relation,
    ]),
  );
  const deadline = Date.now() + 270_000;
  let limited = false;
  let screeningCompleted = 0;
  const relevance = new Map<string, number>();
  const lexical = retrievalScores(plan.nodes, plan.pairs);
  const direct = new Map<string, Relation>();
  for (const pair of plan.pairs) {
    const left = plan.byId.get(pair.left)!;
    const right = plan.byId.get(pair.right)!;
    const passages = [...left.evidence, ...right.evidence].map(
      (quote) => quote.evidence,
    );
    const direction = hierarchyDirectionFromText(
      passages,
      left.concept,
      right.concept,
    );
    if (direction) {
      direct.set(pair.id, {
        ...direction,
        type: "PARENT_CHILD",
        reason: "원문에 명시된 상위·하위 분류 관계입니다.",
      });
      continue;
    }
    // Cross-mentions are a recall safeguard, never sufficient to accept an edge.
    if (
      left.evidence.some((quote) =>
        normalize(quote.evidence).includes(normalize(right.concept.name)),
      ) ||
      right.evidence.some((quote) =>
        normalize(quote.evidence).includes(normalize(left.concept.name)),
      )
    )
      relevance.set(pair.id, 70);
  }
  const retrievalAnchors = new Map<string, Pair[]>();
  for (const pair of plan.pairs) {
    const entries = retrievalAnchors.get(pair.anchor) ?? [];
    entries.push(pair);
    retrievalAnchors.set(pair.anchor, entries);
  }
  for (const pairs of retrievalAnchors.values()) {
    for (const pair of pairs
      .sort((a, b) => lexical.get(b.id)! - lexical.get(a.id)!)
      .slice(0, 4)) {
      if (lexical.get(pair.id)! > 0)
        relevance.set(
          pair.id,
          Math.max(relevance.get(pair.id) ?? 0, lexical.get(pair.id)!),
        );
    }
  }
  onProgress?.({
    stage: "relations",
    completed: 0,
    total: plan.screeningBatches.length,
    detail: `${plan.pairs.length}개 개념 쌍에서 코드 검색으로 후보를 찾고, 빠른 모델 ${plan.screeningBatches.length}묶음으로 의미 검색을 보완합니다.`,
  });
  await mapBatches(
    plan.screeningBatches,
    options.concurrency,
    async (batch) => {
      if (Date.now() >= deadline) {
        limited = true;
        return;
      }
      for (const entries of await runPartition(
        batch,
        async (entries) => {
          if (Date.now() >= deadline) {
            limited = true;
            return [];
          }
          const request = plan.screen(entries);
          ensure(
            requestCharacters(request) <= REQUEST_CHARACTERS,
            "Candidate request exceeds its input budget.",
            "INPUT",
          );
          const validate = (value: unknown) => {
            const result = request.schema.parse(value);
            const keys = result.selected.map(
              (entry) => `${entry.left}:${entry.right}`,
            );
            ensure(
              new Set(keys).size === keys.length,
              "Candidate screening repeated a pair.",
              "FORMAT",
            );
            ensure(
              result.selected.every((entry) =>
                entries.some(
                  (pair) =>
                    pair.left === entry.left && pair.right === entry.right,
                ),
              ),
              "Screening invented an eligible pair.",
              "FORMAT",
            );
            return result;
          };
          const produce = () =>
            client.generate({
              ...request,
              deadlineAt: deadline,
              maxAttempts: 2,
            });
          const result = options.checkpoints
            ? await options.checkpoints.run(
                checkpointKey(request),
                produce,
                validate,
              )
            : validate(await produce());
          return result.selected.map((entry) => ({
            pairId: entries.find(
              (pair) => pair.left === entry.left && pair.right === entry.right,
            )!.id,
            score: entry.score,
          }));
        },
        (_entries, error) => {
          if (
            !(error instanceof AiError) ||
            error.code !== "TIMEOUT" ||
            Date.now() < deadline
          )
            throw error;
          limited = true;
          return [];
        },
      ))
        for (const candidate of entries)
          relevance.set(
            candidate.pairId,
            Math.max(relevance.get(candidate.pairId) ?? 0, candidate.score),
          );
      onProgress?.({
        stage: "relations",
        completed: ++screeningCompleted,
        total: plan.screeningBatches.length,
      });
    },
  );
  const anchors = new Map<string, Pair[]>();
  for (const pair of plan.pairs) {
    if (!relevance.has(pair.id) || direct.has(pair.id)) continue;
    const entries = anchors.get(pair.anchor) ?? [];
    entries.push(pair);
    anchors.set(pair.anchor, entries);
  }
  const selected = [...anchors.values()].flatMap((pairs) =>
    pairs
      .sort((a, b) => relevance.get(b.id)! - relevance.get(a.id)!)
      .slice(0, 6),
  );
  const batches = selected.flatMap((_, index) =>
    index % 12 === 0
      ? partitionRequests(selected.slice(index, index + 12), plan.judge)
      : [],
  );
  let requests = 0;
  let completed = 0;
  onProgress?.({
    stage: "relations",
    completed: 0,
    total: batches.length,
    detail: `${selected.length}개 후보를 ${batches.length}개 묶음으로 고추론 모델이 판정합니다. 원문 근거와 관계 방향을 함께 검증합니다.`,
  });
  const results = await mapBatches(
    batches,
    options.concurrency,
    async (batch) => {
      const outputs = await runPartition(
        batch,
        async (entries): Promise<Relation[]> => {
          if (requests >= 48 || Date.now() >= deadline) {
            limited = true;
            return [];
          }
          const request = plan.judge(entries);
          ensure(
            requestCharacters(request) <= REQUEST_CHARACTERS,
            "Relation judgment exceeds its input budget.",
            "INPUT",
          );
          const validate = (value: unknown) => {
            const result = request.schema.parse(value);
            ensure(
              new Set(result.decisions.map((decision) => decision.pairId))
                .size === entries.length,
              "Judge must decide each pair exactly once.",
              "FORMAT",
            );
            for (const decision of result.decisions) {
              const pair = entries.find((pair) => pair.id === decision.pairId)!;
              ensure(
                decision.source !== decision.target &&
                  [pair.left, pair.right].includes(decision.source) &&
                  [pair.left, pair.right].includes(decision.target),
                "Judge substituted a pair endpoint.",
                "FORMAT",
              );
              if (decision.type === "NONE") continue;
              const allowed = new Set(
                request.data.concepts
                  .filter(
                    (node) => node.id === pair.left || node.id === pair.right,
                  )
                  .flatMap((node) => node.evidenceIds),
              );
              ensure(
                decision.evidenceIds.length > 0 &&
                  decision.evidenceIds.every((id) => allowed.has(id)),
                "Judge must cite its pair's source evidence.",
                "FORMAT",
              );
            }
            return result;
          };
          const produce = () => {
            requests++;
            return client.generate({
              ...request,
              deadlineAt: deadline,
              maxAttempts: 2,
            });
          };
          const result = options.checkpoints
            ? await options.checkpoints.run(
                checkpointKey(request),
                produce,
                validate,
              )
            : validate(await produce());
          return result.decisions.flatMap((decision) => {
            if (decision.type === "NONE") return [];
            const source = plan.byId.get(decision.source)!.concept;
            const target = plan.byId.get(decision.target)!.concept;
            if (decision.type === "PARENT_CHILD") {
              const direction = hierarchyDirectionFromText(
                [decision.reason],
                source,
                target,
              );
              if (direction && direction.source !== source.id) return [];
            }
            return [
              {
                source: source.id,
                target: target.id,
                type: decision.type,
                reason: decision.reason,
              },
            ];
          });
        },
        (_entries, error) => {
          if (
            !(error instanceof AiError) ||
            error.code !== "TIMEOUT" ||
            Date.now() < deadline
          )
            throw error;
          limited = true;
          return [];
        },
      );
      onProgress?.({
        stage: "relations",
        completed: ++completed,
        total: batches.length,
      });
      return outputs.flat();
    },
  );
  // Stable input order makes cycle/conflict resolution independent of provider latency.
  for (const relation of [...direct.values(), ...results.flat()]) {
    const key = relationKey(relation);
    if (relations.has(key)) continue;
    try {
      validateGraph({ concepts, relations: [...relations.values(), relation] });
      relations.set(key, relation);
    } catch (error) {
      if (!(error instanceof AiError) || error.code !== "SEMANTIC") throw error;
    }
  }
  if (limited)
    onProgress?.({
      stage: "relations",
      completed,
      total: batches.length,
      warning: true,
      incomplete: true,
      detail:
        "파일 간 관계 분석의 요청·시간 예산에 도달했습니다. 검증된 관계만 저장했으며 일부 비교는 완료하지 못했습니다.",
    });
  onProgress?.({
    stage: "relations",
    completed,
    total: batches.length,
    detail: `파일 간 비교: ${plan.pairs.length}쌍 선별, ${selected.length}쌍 정밀 판정, 고추론 요청 ${requests}회. 후보 선별 방식이므로 모든 관계의 발견을 보장하지 않습니다.`,
  });
  return [...relations.values()];
}
