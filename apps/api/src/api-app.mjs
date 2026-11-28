import Fastify, { LogController } from "fastify";
import { createLearnMapHandler } from "./demo-server.mjs";
import { createWorkspace } from "./features/workspace/index.mjs";

export async function createApiServer({
  env = process.env,
  persistence,
  clientFactory,
} = {}) {
  const workspace = createWorkspace(undefined, persistence);
  await workspace.initialized;
  const app = Fastify({
    logger: { level: env.API_LOG_LEVEL || "info" },
    // Trust forwarded client IPs only from the explicitly configured proxy.
    trustProxy: env.API_TRUST_PROXY || false,
    logController: new LogController({ disableRequestLogging: true }),
    requestTimeout: 120000,
  });
  const handle = createLearnMapHandler({
    env,
    workspace,
    clientFactory,
    serveWeb: false,
  });
  app.get("/healthz", async (_request, reply) => {
    try {
      await workspace.assertAvailable?.();
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
    return { status: "ok" };
  });
  app.route({
    method: ["GET", "HEAD", "POST", "DELETE"],
    url: "/api/*",
    // The shared API handler streams uploaded bytes and validates each route's
    // existing limits. Delegate before Fastify's content parsers consume them.
    onRequest: async (request, reply) => {
      reply.hijack();
      await handle(request.raw, reply.raw, request.ip);
    },
    handler: async () => undefined,
  });
  if (persistence) app.addHook("onClose", () => persistence.close());
  return app;
}
