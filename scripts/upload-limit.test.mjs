import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createDemoServer } from "../apps/api/src/demo-server.mjs";
import { createBrowserFetch } from "./browser-fetch.mjs";
import { MAX_UPLOAD_BYTES } from "../apps/shared/upload-limit.ts";

test("upload limit accepts the boundary and rejects declared or streamed excess before analysis", async () => {
  const server = createDemoServer({ env: {}, clientFactory: () => { throw Error("Invalid PDF must not call AI"); } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/api/analyses?filename=limit.pdf`;
  const { fetch } = createBrowserFetch();
  try {
    const bytes = Buffer.alloc(MAX_UPLOAD_BYTES);
    const accepted = await fetch(url, { method: "POST", body: bytes });
    assert.equal(accepted.status, 202);
    await accepted.json();
    const oversized = await fetch(url, { method: "POST", body: Buffer.alloc(MAX_UPLOAD_BYTES + 1) });
    assert.equal(oversized.status, 413);
    assert.match((await oversized.json()).error.message, /11 MiB/);
    async function* stream() { yield bytes; yield Buffer.alloc(1); }
    const streamed = await fetch(url, { method: "POST", body: stream(), duplex: "half" });
    assert.equal(streamed.status, 413);
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
});
