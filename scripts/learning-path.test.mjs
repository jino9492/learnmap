import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLearningPath,
  companionConcepts,
} from "../apps/shared/learning-path.ts";

const graph = {
  concepts: ["C", "B", "A", "D"].map((id) => ({ id, name: id })),
  relations: [
    { source: "A", target: "B", type: "PREREQUISITE" },
    { source: "B", target: "C", type: "PREREQUISITE" },
    { source: "D", target: "C", type: "RELATED" },
  ],
};
const ids = (path) => path.steps.map((step) => step.conceptId);

test("companion concepts collect both directions without duplicates, path members or unrelated types", () => {
  const related = {
    ...graph,
    relations: [
      ...graph.relations,
      { source: "A", target: "D", type: "RELATED", reason: "공통 원리" },
      { source: "D", target: "A", type: "RELATED", reason: "공통 원리" },
      { source: "A", target: "B", type: "RELATED" },
      { source: "C", target: "missing", type: "RELATED" },
      { source: "C", target: "C", type: "RELATED" },
    ],
  };
  const result = companionConcepts(related, ["A", "B", "C"]);
  assert.deepEqual(
    result.map((item) => item.conceptId),
    ["D"],
  );
  assert.deepEqual(
    result[0].connections.map((item) => item.conceptId),
    ["C", "A"],
  );
  assert.equal(result[0].connections[1].reason, "공통 원리");
  assert.deepEqual(companionConcepts(related, []), []);
  assert.deepEqual(
    companionConcepts(graph, ["D"])[0].connections.map(
      (item) => item.conceptId,
    ),
    ["D"],
  );
  assert.deepEqual(
    companionConcepts(graph, ["A", "B", "C", "D"], false).map(
      (item) => item.conceptId,
    ),
    ["C", "D"],
  );
});

test("unstarted targets include all recursive prerequisites in learning order", () => {
  assert.deepEqual(ids(buildLearningPath(graph, [], "C")), ["A", "B", "C"]);
  assert.deepEqual(ids(buildLearningPath(graph, [], "B")), ["A", "B"]);
  assert.deepEqual(ids(buildLearningPath(graph, [], "D")), ["D"]);
  assert.equal(new Set(ids(buildLearningPath(graph))).size, 4);
});

test("progress prioritizes available weak concepts without moving dependents ahead of prerequisites", () => {
  const branched = {
    ...graph,
    relations: [
      ...graph.relations,
      { source: "D", target: "C", type: "PREREQUISITE" },
    ],
  };
  const progress = [
    { conceptId: "A", score: 100, status: "MASTERED" },
    { conceptId: "B", score: 0, status: "WEAK" },
    { conceptId: "D", score: 20, status: "WEAK" },
  ];
  assert.deepEqual(ids(buildLearningPath(branched, progress, "C")), [
    "D",
    "A",
    "B",
    "C",
  ]);
  assert.deepEqual(
    ids(
      buildLearningPath(
        branched,
        [{ conceptId: "D", score: 100, status: "MASTERED" }],
        "C",
      ),
    ),
    ["A", "B", "D", "C"],
  );
  assert.match(
    buildLearningPath(branched, progress, "C").steps[0].reason,
    /20%/,
  );
});

test("diamond prerequisites occur once and independent concepts remain available", () => {
  const diamond = {
    ...graph,
    relations: [
      { source: "A", target: "B", type: "PREREQUISITE" },
      { source: "A", target: "D", type: "PREREQUISITE" },
      { source: "B", target: "C", type: "PREREQUISITE" },
      { source: "D", target: "C", type: "PREREQUISITE" },
    ],
  };
  assert.deepEqual(ids(buildLearningPath(diamond, [], "C")), [
    "A",
    "B",
    "D",
    "C",
  ]);
});

test("empty, missing and cyclic paths never produce a misleading partial sequence", () => {
  assert.equal(buildLearningPath({ concepts: [], relations: [] }), null);
  assert.equal(buildLearningPath(graph, [], "deleted"), null);
  assert.equal(
    buildLearningPath({
      ...graph,
      relations: [
        ...graph.relations,
        { source: "C", target: "A", type: "PREREQUISITE" },
      ],
    }),
    null,
  );
});
