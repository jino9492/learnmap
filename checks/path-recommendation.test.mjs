import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { recommendPath, AiError } from "../apps/api/src/ai/index.ts";

const fixture = JSON.parse(await readFile(new URL("../examples/fixture.json", import.meta.url), "utf8"));
const concepts = fixture.concept_extraction.concepts;
const graph = { concepts, relations: fixture.relation_analysis.relations };
const code = (expected) => (error) => error.code === expected;

test("path generation constrains full subject IDs and retries invalid model output", async () => {
  const ids = concepts.map((concept) => `material-uuid:${concept.id}-uuid`);
  const scoped = {
    concepts: concepts.map((concept, index) => ({ ...concept, id: ids[index] })),
    relations: graph.relations.map((relation) => ({ ...relation, source: ids[concepts.findIndex((concept) => concept.id === relation.source)], target: ids[concepts.findIndex((concept) => concept.id === relation.target)] })),
  };
  for (const invalid of [[ids[0], "c2", ids[2]], [ids[0], ids[0], ids[2]], [ids[0], ids[2]], [ids[1], ids[0], ids[2]], [ids[0], ids[2], ids[1]]]) {
    let calls = 0;
    const path = await recommendPath({ async generate(request) {
      calls++;
      const steps = request.schema.json.properties.steps;
      assert.deepEqual(steps.items.properties.conceptId.enum, ids);
      assert.equal(steps.minItems, 3);
      assert.equal(steps.maxItems, 3);
      if (calls === 2) assert.match(request.data.correction, /previous response was rejected/);
      return { steps: (calls === 1 ? invalid : ids).map((conceptId) => ({ conceptId, reason: "Review" })), possibleCause: "Possible gap." };
    } }, scoped, ids[2], []);
    assert.equal(calls, 2);
    assert.deepEqual(path.steps.map((step) => step.conceptId), ids);
  }
});

test("a single isolated target uses its complete ID and needs only one model request", async () => {
  const concept = { ...concepts[0], id: "material-uuid:concept-uuid" };
  let calls = 0;
  const path = await recommendPath({ async generate(request) {
    calls++;
    return request.schema.parse({ steps: [{ conceptId: concept.id, reason: "Review" }], possibleCause: "Possible gap." });
  } }, { concepts: [concept], relations: [] }, concept.id, []);
  assert.equal(calls, 1);
  assert.equal(path.steps[0].conceptId, concept.id);
});

test("path retries are bounded and transport errors are not retried by recommendation", async () => {
  for (const failure of ["FORMAT", "SEMANTIC", "CONNECTION"]) {
    let calls = 0;
    await assert.rejects(recommendPath({ async generate() {
      calls++;
      throw new AiError(failure, "Rejected");
    } }, graph, "c3", []), code(failure));
    assert.equal(calls, failure === "CONNECTION" ? 1 : 2);
  }
});

