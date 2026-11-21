import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createParallelDemo } from "../apps/api/src/features/parallel-demo/index.mjs";

function group(count) {
  const form = new FormData();
  form.set("users", String(count));
  for (const name of ["one.txt", "two.txt"])
    form.append("files", new Blob([name]), name);
  return form;
}
async function finish(demo) {
  for (let i = 0; i < 100; i++) {
    const run = demo.snapshot("owner");
    if (run.ended) return run;
    await delay(5);
  }
  assert.fail("Experiment did not finish.");
}
test("replicates one bundle per independent subject, runs users concurrently and bounds admission", async () => {
  const gate = Promise.withResolvers(),
    visits = new Map();
  let active = 0,
    peak = 0;
  const analyses = new Map(),
    subjects = new Map();
  const demo = createParallelDemo({
    analyses,
    subjects,
    reserveAnalysis() {
      peak = Math.max(peak, ++active);
      return () => active--;
    },
    async analyze(job, name, bytes) {
      assert.equal(bytes.toString(), name);
      const seen = visits.get(job.subjectId) ?? [];
      visits.set(job.subjectId, seen);
      seen.push(name);
      job.status = "extracting_concepts";
      await gate.promise;
      Object.assign(job, {
        status: "ready",
        concepts: [],
        relations: [],
        material: { sources: [] },
      });
    },
  });
  await demo.start("owner", group(17));
  assert.equal(active, 16);
  assert.equal(demo.snapshot("another"), null);
  assert.equal(demo.snapshot("owner").users[16].files[0].status, "queued");
  await assert.rejects(demo.start("owner", group(1)), { status: 409 });
  gate.resolve();
  const run = await finish(demo);
  assert.equal(peak, 16);
  assert.equal(visits.size, 17);
  for (const seen of visits.values())
    assert.deepEqual(seen, ["one.txt", "two.txt"]);
  assert.ok(run.users.every((u) => u.files.every((f) => f.percent === 100)));
  assert.equal(analyses.size + subjects.size + active, 0);
});
test("only the owner can stop a run and pending files do not call the provider", async () => {
  let calls = 0;
  const demo = createParallelDemo({
    analyses: new Map(),
    subjects: new Map(),
    reserveAnalysis: () => () => {},
    async analyze(job, _name, _bytes, _previous, signal) {
      calls++;
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      job.status = "failed";
    },
  });
  const id = await demo.start("owner", group(2));
  assert.throws(() => demo.stop("other", id), { status: 404 });
  demo.stop("owner", id);
  const run = await finish(demo);
  assert.equal(calls, 2);
  assert.ok(
    run.users.every((u) => u.files.every((f) => f.status === "cancelled")),
  );
});

test("a spend limit stops the demo and explains blocked files for all 20 users", async () => {
  let calls = 0;
  const demo = createParallelDemo({
    analyses: new Map(),
    subjects: new Map(),
    reserveAnalysis: () => () => {},
    async analyze(job) {
      calls++;
      job.status = "failed";
      job.error = {
        reason: "QUOTA_EXHAUSTED",
        message: "조직의 API 지출 한도에 도달했습니다.",
      };
    },
  });
  await demo.start("owner", group(20));
  const run = await finish(demo);
  assert.equal(calls, 16);
  assert.match(run.error, /지출 한도/);
  assert.ok(
    run.users.every((user) =>
      user.files.every(
        (file) => file.status === "failed" && file.error === run.error,
      ),
    ),
  );
});
