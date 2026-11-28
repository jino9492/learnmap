import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../apps/api/src/api-app.mjs";
import { createBrowserFetch } from "./browser-fetch.mjs";

const url = process.env.LEARNMAP_TEST_DATABASE_URL;

test(
  "Fastify and MySQL preserve guest transfers, originals and sessions across restart",
  { skip: !url },
  async () => {
    const { connectMySql } =
      await import("../apps/api/src/infrastructure/database/mysql.mjs");
    const start = async () => {
      const persistence = await connectMySql(url);
      const app = await createApiServer({
        env: {
          APP_ORIGIN: "https://learnmap.example",
          API_LOG_LEVEL: "silent",
        },
        persistence,
        clientFactory: () => ({
          async generate() {
            throw new Error(
              "Fixture analysis stops before calling an external provider.",
            );
          },
        }),
      });
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      return { app, address };
    };
    let { app, address } = await start();
    const guest = createBrowserFetch();
    const second = createBrowserFetch();
    const headers = {
      Host: "learnmap.example",
      Origin: "https://learnmap.example",
    };
    const request = (browser, path, options) =>
      browser.fetch(address + path, {
        ...options,
        headers: { ...headers, ...options?.headers },
      });
    const read = async (browser, path) => {
      const response = await request(browser, path);
      assert.equal(response.status, 200);
      return response.json();
    };
    const post = async (browser, path, body, status = 200) => {
      const response = await request(browser, path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, status, await response.clone().text());
      return response.json();
    };
    const credentials = {
      email: `mysql-${crypto.randomUUID()}@example.com`,
      password: "test-password-012345",
    };
    try {
      await assert.rejects(connectMySql(url), /Another LearnMap API/);
      assert.equal(
        (
          await request(guest, "/api/account", {
            headers: { Origin: "https://unrelated.example" },
          })
        ).status,
        403,
      );
      assert.equal(
        (await request(guest, "/api/account")).headers
          .get("set-cookie")
          ?.includes("Secure"),
        true,
      );
      const existing = await post(
        guest,
        "/api/subjects",
        { name: "Guest subject" },
        201,
      );
      const bytes = "An original text file. ".repeat(4000);
      const uploaded = await request(
        guest,
        `/api/analyses?filename=original.txt&subjectId=${existing.id}`,
        { method: "POST", body: bytes },
      );
      assert.equal(uploaded.status, 202, await uploaded.clone().text());
      const material = await uploaded.json();
      const unauthenticated = createBrowserFetch(guest.cookies);
      assert.equal(
        (await post(guest, "/api/account/register", credentials))
          .importedSubjects,
        1,
      );
      assert.equal(
        (await request(unauthenticated, `/api/subjects/${existing.id}`)).status,
        404,
      );
      assert.equal(
        (await request(unauthenticated, `/api/materials/${material.id}/file`))
          .status,
        404,
      );
      const another = await post(
        second,
        "/api/subjects",
        { name: "Second device guest" },
        201,
      );
      assert.equal(
        (await post(second, "/api/account/login", credentials))
          .importedSubjects,
        1,
      );
      assert.deepEqual(
        new Set(
          (await read(second, "/api/workspace")).subjects.map(({ id }) => id),
        ),
        new Set([existing.id, another.id]),
      );
      await post(guest, "/api/account/logout", {});
      const newGuest = await post(
        guest,
        "/api/subjects",
        { name: "New guest after logout" },
        201,
      );
      assert.deepEqual(
        (await read(guest, "/api/workspace")).subjects.map(({ id }) => id),
        [newGuest.id],
      );
      assert.equal(
        (await post(guest, "/api/account/login", credentials)).importedSubjects,
        1,
      );
      for (let attempt = 0; attempt < 40; attempt++) {
        if (
          (await read(guest, `/api/analyses/${material.id}`)).status ===
          "failed"
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await app.close();
      ({ app, address } = await start());
      assert.equal(
        (await read(second, "/api/account")).user.email,
        credentials.email,
      );
      assert.deepEqual(
        new Set(
          (await read(second, "/api/workspace")).subjects.map(({ id }) => id),
        ),
        new Set([existing.id, another.id, newGuest.id]),
      );
      assert.equal(
        await (
          await request(second, `/api/materials/${material.id}/file`)
        ).text(),
        bytes,
      );
    } finally {
      await app.close();
    }
  },
);
