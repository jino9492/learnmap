import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { connectMySql } from "../apps/api/src/infrastructure/database/mysql.mjs";

const { values } = parseArgs({
  options: {
    file: { type: "string", default: ".learnmap/workspace.json" },
    "legacy-owner": { type: "string" },
  },
});
let store;
try {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const source = JSON.parse(await readFile(values.file, "utf8"));
  for (const key of ["users", "sessions", "subjects", "analyses"]) {
    if (source[key] !== undefined && !Array.isArray(source[key]))
      throw new Error("Invalid list in source workspace: " + key);
    source[key] ??= [];
  }
  const ownerEmail = values["legacy-owner"]?.trim().toLowerCase();
  const unowned = [...source.subjects, ...source.analyses].filter(
    (item) => !item.ownerId,
  );
  if (ownerEmail) {
    const owner = source.users.find(({ email }) => email === ownerEmail);
    if (!owner)
      throw new Error(
        "Legacy owner must already have an account in the source JSON.",
      );
    for (const item of unowned) item.ownerId = owner.id;
  }
  store = await connectMySql(process.env.DATABASE_URL);
  const target = await store.load();
  if (Object.values(target).some((items) => items.length)) {
    throw new Error(
      "Import requires an empty database. Existing data was not modified.",
    );
  }
  await store.save(source);
  console.log(
    `Imported ${source.users.length} accounts, ${source.subjects.length} subjects, and ${source.analyses.length} analyses.`,
  );
  if (unowned.length && !ownerEmail)
    console.log(
      `${unowned.length} legacy records imported without owners. Use the local API restore flow to claim them before enabling the public origin.`,
    );
} catch (error) {
  const allowed =
    /^(DATABASE_URL is required|Invalid list|Legacy owner|Import requires)/.test(
      error.message,
    );
  console.error(
    allowed
      ? error.message
      : "Import failed. Check the source file, MySQL migration status, and API process lock.",
  );
  process.exitCode = 1;
} finally {
  await store?.close();
}
