import { createApiServer } from "./api-app.mjs";
import { connectMySql } from "./infrastructure/database/mysql.mjs";

const {
  DATABASE_URL,
  APP_ORIGIN,
  API_HOST = "127.0.0.1",
  API_PORT = "8787",
} = process.env;
let persistence;
let app;
try {
  if (!DATABASE_URL) throw new Error("DATABASE_URL is required.");
  if (APP_ORIGIN && !/^https:\/\/[^/]+$/.test(APP_ORIGIN)) {
    throw new Error(
      "APP_ORIGIN must be the frontend HTTPS origin without a trailing slash.",
    );
  }
  if (!APP_ORIGIN && !["127.0.0.1", "localhost"].includes(API_HOST)) {
    throw new Error(
      "APP_ORIGIN is required when binding the API outside loopback.",
    );
  }
  const port = Number(API_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid API_PORT.");
  persistence = await connectMySql(DATABASE_URL);
  app = await createApiServer({ persistence });
  await app.listen({ host: API_HOST, port });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void app.close().catch(() => {
        process.exitCode = 1;
      });
    });
  }
} catch (error) {
  // Never print the database connection string or configuration credentials.
  console.error(
    "LearnMap API failed to start. Check API settings, database connectivity, migration status, and whether another API process is running.",
    error.code ?? error.name,
  );
  if (app) await app.close();
  else await persistence?.close();
  process.exitCode = 1;
}
