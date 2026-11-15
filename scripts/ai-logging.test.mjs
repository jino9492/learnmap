import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createJsonClient } from "../apps/api/src/ai/core/http.ts";
import { AiError } from "../apps/api/src/ai/core/errors.ts";

test("AI logs persist starts, retries, validated success and failures without request bodies", async () => {
  const task = `logging_test_${randomUUID()}`;
  const events = [];
  let calls = 0;
  let readStarted;
  const started = new Promise((resolve) => { readStarted = resolve; });
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const adapter = {
    provider: "test", model: "test-model", url: "https://example.invalid",
    headers: { Authorization: "secret-api-key" },
    body: () => ({ prompt: "private-material" }),
    output: () => ({ text: calls === 1 ? "invalid-json" : '{"ok":true}', usage: { total_tokens: 10 } }),
  };
  const client = createJsonClient(adapter, {
    fetcher: async () => {
      calls++;
      if (calls === 1) { readStarted(); await pending; }
      return new Response("{}");
    },
    sleep: async () => {}, onEvent: (event) => events.push(event),
  });
  const logs = () => readdirSync("logs").filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(`logs/${name}`, "utf8").trim().split("\n").map(JSON.parse))
    .filter((event) => event.task === task);
  const request = { name: task, instructions: "private-instructions", data: {}, schema: { json: {}, parse: (value) => value } };
  const result = client.generate(request);
  await started;
  assert.deepEqual(logs().map((event) => event.outcome), ["started"]);
  finish();
  assert.deepEqual(await result, { ok: true });
  let entries = logs();
  assert.deepEqual(entries.map((event) => event.outcome), ["started", "retrying", "started", "completed"]);
  assert.equal(new Set(entries.map((event) => event.requestId)).size, 1);
  assert.ok(entries.every((event) => event.timestamp && event.pid === process.pid && event.model === "test-model"));
  assert.equal(entries.at(-1).usage.total_tokens, 10);
  assert.equal(events.length, 2);
  assert.doesNotMatch(JSON.stringify(entries), /secret-api-key|private-material|private-instructions/);

  const failing = createJsonClient(adapter, { maxAttempts: 1, fetcher: async () => new Response("{}") });
  await assert.rejects(failing.generate({ ...request, schema: { json: {}, parse() { throw new AiError("FORMAT", "invalid schema"); } } }), { code: "FORMAT" });
  entries = logs().slice(4);
  assert.deepEqual(entries.map((event) => event.outcome), ["started", "failed"]);
  assert.equal(entries.at(-1).error, "FORMAT");
});
