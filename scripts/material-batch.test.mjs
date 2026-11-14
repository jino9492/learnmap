import test from "node:test";
import assert from "node:assert/strict";
import { createAnalysisBatchPoller, DemoApiError } from "../apps/demo/api.js";

test("batch polling tracks every file and continues after one analysis fails", async () => {
  const states = []; const timers = []; const calls = [];
  const poller = createAnalysisBatchPoller({
    request: async (url) => {
      calls.push(url);
      if (url.endsWith("missing")) throw new DemoApiError(404, "INPUT", "자료를 찾을 수 없습니다.");
      return { status: calls.filter((item) => item === url).length === 1 ? "extracting_concepts" : "ready" };
    },
    onState: (snapshots) => states.push(snapshots),
    onConnectionError: () => assert.fail("No connection failure"),
    onFatalError: () => assert.fail("One missing file must not stop the batch"),
    schedule: (callback) => { timers.push(callback); }, cancel() {},
  });
  await poller.start([{ id: "first", filename: "첫째.pdf" }, { id: "missing", filename: "둘째.pdf" }]);
  assert.deepEqual(states[0].map((item) => item.status), ["extracting_concepts", "failed"]);
  timers.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(states[1].map((item) => item.status), ["ready", "failed"]);
  assert.equal(states[1][1].filename, "둘째.pdf");
  assert.equal(calls.filter((url) => url.endsWith("missing")).length, 1);
  assert.equal(timers.length, 0);
});

test("batch polling retries connection failures without submitting any file again", async () => {
  const timers = []; const states = []; let disconnected = true;
  const poller = createAnalysisBatchPoller({
    request: async (url, options) => {
      assert.equal(options.method, undefined);
      if (disconnected) throw new DemoApiError(0, "DEMO_CONNECTION", "연결 실패");
      return { status: "ready" };
    },
    onState: (snapshots) => states.push(snapshots),
    onConnectionError() {}, onFatalError: () => assert.fail("Should retry"),
    schedule: (callback) => { timers.push(callback); }, cancel() {},
  });
  await poller.start([{ id: "a" }, { id: "b" }]);
  assert.equal(states.length, 0);
  disconnected = false; timers.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(states[0].length, 2);
  assert.ok(states[0].every((item) => item.status === "ready"));
});

