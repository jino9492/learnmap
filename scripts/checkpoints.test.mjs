import { createBrowserFetch } from "./browser-fetch.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createCheckpoints } from "../apps/api/src/features/material-analysis/checkpoints.mjs";
import { crossMaterialRequests } from "../apps/api/src/ai/relation-analysis/cross-material.ts";
import { analyzeRelations } from "../apps/api/src/ai/relation-analysis/index.ts";
import { organizeConcepts } from "../apps/api/src/ai/concept-organization/index.ts";
import { analysisOptionsFromEnv } from "../apps/api/src/ai/core/config.ts";
import { mapBatches } from "../apps/api/src/ai/core/batches.ts";
import { AiError } from "../apps/api/src/ai/core/errors.ts";
import { createDemoServer } from "../apps/api/src/demo-server.mjs";
import { once } from "node:events";
import { createConfiguredClient } from "../apps/api/src/ai/core/config.ts";
import { object, text } from "../apps/api/src/ai/core/schema.ts";

async function temporary(run) {
  const directory = await mkdtemp(join(tmpdir(), "learnmap-checkpoints-"));
  try {
    await run(directory);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.includes("learnmap-checkpoints-"));
    await rm(directory, { recursive: true, force: true });
  }
}

test("validated checkpoints survive a new store, reject corrupt data and invalidate changed model scopes", async () =>
  temporary(async (directory) => {
    let calls = 0;
    const validate = (value) => {
      assert.equal(value.ok, true);
      return value;
    };
    const produce = async () => {
      calls++;
      return { ok: true };
    };
    const first = createCheckpoints({ directory, scope: "model-one" });
    const returned = await first.run("batch", produce, validate);
    returned.ok = false;
    assert.equal((await first.run("batch", produce, validate)).ok, true);
    const second = createCheckpoints({ directory, scope: "model-one" });
    await second.run("batch", produce, validate);
    assert.equal(calls, 1);
    const [file] = await readdir(directory);
    await writeFile(join(directory, file), '{"ok":false}');
    const repaired = createCheckpoints({ directory, scope: "model-one" });
    await repaired.run("batch", produce, validate);
    assert.equal(calls, 2);
    await createCheckpoints({ directory, scope: "model-two" }).run(
      "batch",
      produce,
      validate,
    );
    assert.equal(calls, 3);
  }));

test("failed and partial requests do not overwrite completed checkpoints or become completed stages", async () =>
  temporary(async (directory) => {
    const store = createCheckpoints({ directory, scope: "test" });
    await store.run(
      "good",
      async () => ({ ok: true }),
      (value) => value,
    );
    await assert.rejects(
      store.run(
        "bad",
        async () => {
          throw new Error("503");
        },
        (value) => value,
      ),
    );
    await store.run(
      "partial",
      async () => ({ incomplete: true }),
      (value) => value,
      (value) => !value.incomplete,
    );
    assert.equal((await readdir(directory)).length, 1);
    assert.deepEqual(
      JSON.parse(
        await readFile(join(directory, (await readdir(directory))[0]), "utf8"),
      ),
      { ok: true },
    );
  }));

function notes(count = 12) {
  const concepts = ["a", "b"].flatMap((origin) =>
    Array.from({ length: count }, (_, index) => ({
      id: `${origin}:${index}`,
      name: `${origin} 주제 ${index}`,
      description: `독립적인 ${origin}${index} 학습 단위입니다.`,
      sourceLocation: `${origin}/page:${index}`,
      evidence: `${origin}${index}의 개별 원문입니다.`,
    })),
  );
  return {
    concepts,
    material: {
      id: "m",
      title: "강의",
      sources: concepts.map((concept) => ({
        location: concept.sourceLocation,
        text: concept.evidence,
      })),
    },
  };
}
function candidates(request) {
  return {
    selected: request.data.queries
      .flatMap((query) =>
        query.allowedTargets
          .slice(0, 4)
          .map((right) => ({ left: query.id, right, score: 80 })),
      )
      .slice(0, 16),
  };
}

test("a failed screening batch resumes from disk without repeating successful catalog searches", async () =>
  temporary(async (directory) => {
    const { material, concepts } = notes();
    let fail = true;
    const calls = [];
    const client = {
      async generate(request) {
        if (request.name === "relation_candidates") {
          const key = request.data.queries[0].id;
          calls.push(key);
          if (fail && calls.length === 2)
            throw new AiError("PROVIDER", "503", "UNAVAILABLE");
          return candidates(request);
        }
        return {
          decisions: request.data.pairs.map((pair) => ({
            pairId: pair.id,
            type: "NONE",
            source: pair.left,
            target: pair.right,
            evidenceIds: [],
            reason: "관련 근거가 없습니다.",
          })),
        };
      },
    };
    const options = () => ({
      crossMaterial: true,
      concurrency: 1,
      checkpoints: createCheckpoints({ directory, scope: "same-model" }),
    });
    await assert.rejects(
      analyzeRelations(client, material, concepts, undefined, options()),
      (error) => error.code === "PROVIDER",
    );
    fail = false;
    await analyzeRelations(client, material, concepts, undefined, options());
    assert.equal(calls.filter((key) => key === "n1").length, 1);
    assert.equal(calls.filter((key) => key === "n5").length, 2);
    assert.equal(calls.filter((key) => key === "n9").length, 1);
  }));

test("a failed judgment resumes validated decisions instead of redoing completed high-model calls", async () =>
  temporary(async (directory) => {
    const { material, concepts } = notes();
    const calls = [];
    let fail = true;
    const client = {
      async generate(request) {
        if (request.name === "relation_candidates") return candidates(request);
        calls.push(request.data.pairs[0].id);
        if (fail && calls.length === 2)
          throw new AiError("PROVIDER", "Unavailable", "UNAVAILABLE");
        return {
          decisions: request.data.pairs.map((pair) => ({
            pairId: pair.id,
            type: "NONE",
            source: pair.left,
            target: pair.right,
            evidenceIds: [],
            reason: "관계가 확인되지 않습니다.",
          })),
        };
      },
    };
    const options = () => ({
      crossMaterial: true,
      concurrency: 1,
      checkpoints: createCheckpoints({ directory, scope: "same-model" }),
    });
    await assert.rejects(
      analyzeRelations(client, material, concepts, undefined, options()),
    );
    const first = calls[0];
    fail = false;
    await analyzeRelations(client, material, concepts, undefined, options());
    assert.equal(calls.filter((id) => id === first).length, 1);
  }));

test("catalog screening uses a few requests for 31 by 59 concepts while exposing all eligible targets", () => {
  const { material, concepts } = notes(59);
  const subset = concepts.filter(
    (concept) =>
      !concept.id.startsWith("a:") || Number(concept.id.split(":")[1]) < 31,
  );
  const plan = crossMaterialRequests(material, subset);
  assert.equal(plan.pairs.length, 1829);
  assert.equal(plan.screeningBatches.length, 8);
  const seen = new Set();
  for (const batch of plan.screeningBatches)
    for (const query of plan.screen(batch).data.queries) {
      for (const target of query.allowedTargets)
        seen.add(`${query.id}:${target}`);
    }
  assert.equal(seen.size, 1829);
});

test("single-pass organization preserves provenance and merges exact duplicates across batches without more rounds", async () => {
  const { material, concepts } = notes(25);
  const ids = new Set(concepts.map((concept) => concept.id));
  let calls = 0;
  const result = await organizeConcepts(
    {
      async generate(request) {
        calls++;
        assert.ok(
          request.data.concepts.every((concept) => ids.has(concept.id)),
        );
        return {
          groups: [
            {
              name: "동일 개념",
              description: "같은 정의를 설명하는 개념입니다.",
              memberIds: request.data.concepts.map((concept) => concept.id),
            },
          ],
        };
      },
    },
    material,
    concepts,
    undefined,
    { concurrency: 2 },
  );
  assert.ok(calls <= Math.ceil(concepts.length / 12) + 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].memberConceptIds.length, concepts.length);
  assert.equal(result[0].citations.length, concepts.length);
});

test("cloud relation concurrency defaults to four, honors overrides and keeps Ollama sequential", async () => {
  assert.equal(analysisOptionsFromEnv({}).relationConcurrency, 4);
  assert.equal(
    analysisOptionsFromEnv({ AI_PROVIDER: "ollama" }).relationConcurrency,
    1,
  );
  assert.equal(
    analysisOptionsFromEnv({ AI_CONCURRENCY: "2" }).relationConcurrency,
    2,
  );
  assert.equal(
    analysisOptionsFromEnv({
      AI_CONCURRENCY: "2",
      AI_RELATION_CONCURRENCY: "4",
    }).relationConcurrency,
    4,
  );
  for (const value of ["0", "5", "NaN"])
    assert.throws(() =>
      analysisOptionsFromEnv({ AI_RELATION_CONCURRENCY: value }),
    );
  for (const concurrency of [2, 4]) {
    let active = 0;
    let peak = 0;
    await mapBatches([1, 2, 3, 4], concurrency, async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    });
    assert.equal(peak, concurrency);
  }
});

test("completed file stages are reused after restarting the API server", async () =>
  temporary(async (directory) => {
    const { fetch } = createBrowserFetch();
    let calls = 0;
    let server;
    const storagePath = join(directory, "workspace.json");
    const start = async () => {
      server = createDemoServer({
        env: {},
        storagePath,
        clientFactory: () => ({
          async generate(request) {
            calls++;
            if (request.name === "concept_extraction") {
              const source = request.data.sources[0];
              return {
                concepts: [
                  {
                    id: "c1",
                    name: "페이징",
                    description:
                      "페이징은 주소 공간을 고정 크기 페이지로 나누는 방식입니다.",
                    sourceLocation: source.location,
                    evidence: source.excerpts[0].id,
                  },
                ],
              };
            }
            assert.equal(request.name, "relation_analysis");
            return { relations: [] };
          },
        }),
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      return `http://127.0.0.1:${server.address().port}`;
    };
    const close = async () => {
      if (!server) return;
      const stopped = once(server, "close");
      server.close();
      server.closeAllConnections();
      await stopped;
      server = null;
    };
    const ready = async (base, id) => {
      for (let index = 0; index < 100; index++) {
        const job = await (await fetch(`${base}/api/analyses/${id}`)).json();
        assert.notEqual(job.status, "failed", JSON.stringify(job.error));
        if (job.status === "ready") return job;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail("Analysis did not finish");
    };
    try {
      let base = await start();
      const subject = await (
        await fetch(`${base}/api/subjects`, {
          method: "POST",
          body: JSON.stringify({ name: "운영체제" }),
        })
      ).json();
      const upload = await (
        await fetch(
          `${base}/api/analyses?filename=notes.txt&subjectId=${subject.id}`,
          {
            method: "POST",
            body: "페이징은 주소 공간을 고정 크기 페이지로 나눕니다.",
          },
        )
      ).json();
      await ready(base, upload.id);
      assert.equal(calls, 2);
      await close();
      base = await start();
      assert.equal(
        (
          await fetch(`${base}/api/materials/${upload.id}/analyze`, {
            method: "POST",
          })
        ).status,
        202,
      );
      const resumed = await ready(base, upload.id);
      assert.equal(calls, 2);
      assert.ok(
        resumed.events.filter(
          (event) => event.kind === "checkpoint" && event.status === "hit",
        ).length >= 2,
      );
    } finally {
      await close();
    }
  }));

test("a transient 503 is retried once inside the same request deadline", async () => {
  let calls = 0;
  const client = createConfiguredClient(
    { AI_PROVIDER: "ollama", OLLAMA_MODEL: "test" },
    {
      sleep: async () => {},
      fetcher: async () => {
        calls++;
        return calls === 1
          ? Response.json({ error: "Unavailable" }, { status: 503 })
          : Response.json({
              done: true,
              done_reason: "stop",
              message: { role: "assistant", content: '{"value":"ok"}' },
            });
      },
    },
  );
  const value = await client.generate({
    name: "relation_candidates",
    instructions: "Return JSON.",
    data: {},
    schema: object({ value: text }),
    deadlineAt: Date.now() + 10000,
    maxAttempts: 2,
  });
  assert.equal(value.value, "ok");
  assert.equal(calls, 2);
});
