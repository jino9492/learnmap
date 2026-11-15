import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAiClient } from "../apps/api/src/ai/core/client.ts";
import { openAiSchema } from "../apps/api/src/ai/core/openai-schema.ts";
import { conceptGenerationSchema } from "../apps/api/src/ai/core/schemas.ts";
import { list, object, optional, text } from "../apps/api/src/ai/core/schema.ts";

test("OpenAI concept extraction sends required nullable details and parses null as omitted", async () => {
  const schema = conceptGenerationSchema(["e1"]);
  const original = structuredClone(schema.json);
  const concept = { id: "c1", name: "개념", description: "설명", sourceLocation: "p1", evidence: "e1" };
  const client = createOpenAiClient({ apiKey: "test", model: "test", fetcher: async (_, options) => {
    const body = JSON.parse(options.body);
    const item = body.text.format.schema.properties.concepts.items;
    assert.deepEqual(item.required, Object.keys(item.properties));
    assert.equal(item.additionalProperties, false);
    const [details, nullable] = item.properties.details.anyOf;
    assert.deepEqual(nullable, { type: "null" });
    assert.deepEqual(details.items.required, Object.keys(details.items.properties));
    return Response.json({ status: "completed", output: [{ type: "message", content: [
      { type: "output_text", text: JSON.stringify({ concepts: [{ ...concept, details: null }] }) },
    ] }] });
  } });
  assert.deepEqual(await client.generate({ name: "concept_extraction", instructions: "Extract concepts.", data: {}, schema }), { concepts: [concept] });
  assert.deepEqual(schema.json, original);
});

test("OpenAI nullable conversion preserves nested values and original validation", () => {
  const schema = openAiSchema(object({ name: text, groups: optional(list(object({ value: text, note: optional(text) }), 1)) }));
  assert.deepEqual(schema.parse({ name: "ok", groups: [{ value: "v", note: null }] }), { name: "ok", groups: [{ value: "v" }] });
  assert.deepEqual(schema.parse({ name: "ok", groups: [{ value: "v", note: "kept" }] }), { name: "ok", groups: [{ value: "v", note: "kept" }] });
  for (const value of [
    { name: null, groups: null }, { name: "ok", groups: [] },
    { name: "ok", groups: [{ value: null }] }, { name: "ok", groups: null, extra: null },
  ]) assert.throws(() => schema.parse(value), (error) => error.code === "FORMAT");
});
