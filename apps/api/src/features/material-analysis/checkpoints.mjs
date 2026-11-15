import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  unlink,
  stat,
} from "node:fs/promises";
import { join } from "node:path";

// Store validated batches separately: one failed request cannot discard its successful siblings.
export function createCheckpoints({
  directory,
  scope,
  maxEntries = 512,
  onStatus = () => {},
}) {
  const pending = new Map();
  const memory = new Map();
  const stored = new Set();
  let initialized;
  async function initialize() {
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    const files = (await readdir(directory, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name),
    );
    // Only remove bounded checkpoint files owned by this store, never a directory tree.
    const dated = await Promise.all(
      files.map(async (entry) => ({
        name: entry.name,
        time: (await stat(join(directory, entry.name))).mtimeMs,
      })),
    );
    dated.sort((a, b) => b.time - a.time);
    for (const entry of dated.slice(0, maxEntries).reverse())
      stored.add(entry.name);
    if (files.length > maxEntries) {
      await Promise.all(
        dated
          .slice(maxEntries)
          .map((entry) => unlink(join(directory, entry.name))),
      );
    }
  }
  return {
    async run(key, produce, validate, shouldStore = () => true) {
      initialized ??= initialize();
      await initialized;
      const hash = createHash("sha256")
        .update(JSON.stringify([scope, key]))
        .digest("hex");
      if (pending.has(hash)) {
        onStatus("shared");
        return structuredClone(await pending.get(hash));
      }
      const task = (async () => {
        let cached = memory.get(hash);
        if (cached === undefined && directory) {
          try {
            cached = JSON.parse(
              await readFile(join(directory, `${hash}.json`), "utf8"),
            );
          } catch (error) {
            if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
              throw error;
          }
        }
        if (cached !== undefined) {
          try {
            const value = validate(structuredClone(cached));
            onStatus("hit");
            return value;
          } catch {
            memory.delete(hash);
          }
        }
        onStatus("miss");
        const value = validate(await produce());
        if (directory && shouldStore(value)) {
          const temporary = join(directory, `${hash}.${randomUUID()}.tmp`);
          await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
          await rename(temporary, join(directory, `${hash}.json`));
          stored.delete(`${hash}.json`);
          stored.add(`${hash}.json`);
          while (stored.size > maxEntries) {
            const oldest = stored.values().next().value;
            stored.delete(oldest);
            await unlink(join(directory, oldest)).catch((error) => {
              if (error.code !== "ENOENT") throw error;
            });
          }
        }
        if (shouldStore(value)) memory.set(hash, structuredClone(value));
        while (memory.size > maxEntries)
          memory.delete(memory.keys().next().value);
        return value;
      })();
      pending.set(hash, task);
      try {
        return structuredClone(await task);
      } finally {
        pending.delete(hash);
      }
    },
  };
}
