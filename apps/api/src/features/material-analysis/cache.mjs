import { createHash } from "node:crypto";
import { prompts } from "../../ai/core/prompts.ts";
import { conceptCollectionSchema, conceptGenerationSchema, conceptOrganizationSchema, relationCollectionSchema, relationGenerationSchema } from "../../ai/core/schemas.ts";

export function analysisCacheScope(env, options) {
  const provider = env.AI_PROVIDER?.trim().toLowerCase() || "openai";
  const settings = provider === "ollama"
    ? [env.OLLAMA_MODEL, env.OLLAMA_BASE_URL, env.OLLAMA_CONTEXT_LENGTH]
    : provider === "gemini" ? [env.GEMINI_MODEL, env.GEMINI_API_KEY] : [env.OPENAI_MODEL, env.OPENAI_API_KEY];
  // Hash credentials with the configuration; never expose or retain them as cache keys.
  return createHash("sha256").update(JSON.stringify([
    "analysis-v2", provider, settings, options, prompts,
    conceptCollectionSchema.json, relationCollectionSchema.json,
    conceptGenerationSchema(["evidence"]).json, conceptOrganizationSchema(["member"]).json, relationGenerationSchema(["concept"]).json,
  ])).digest("hex");
}

export function createAnalysisCache({ maxEntries = 32, maxBytes = 16 * 1024 * 1024, ttlMs = 30 * 60 * 1000, now = Date.now } = {}) {
  const completed = new Map();
  const pending = new Map();
  let bytes = 0;
  function remove(key) {
    const entry = completed.get(key);
    if (entry) bytes -= entry.bytes;
    completed.delete(key);
  }
  return {
    async run(keyParts, produce, onStatus = () => {}) {
      const key = createHash("sha256").update(JSON.stringify(keyParts)).digest("hex");
      for (const [id, entry] of completed) if (entry.expiresAt <= now()) remove(id);
      const cached = completed.get(key);
      if (cached) {
        completed.delete(key);
        completed.set(key, cached);
        onStatus("hit");
        return structuredClone(cached.value);
      }
      const active = pending.get(key);
      if (active) {
        onStatus("shared");
        return structuredClone(await active);
      }
      onStatus("miss");
      const task = Promise.resolve().then(produce).then((value) => {
        const snapshot = structuredClone(value);
        const size = Buffer.byteLength(JSON.stringify(snapshot));
        if (maxEntries > 0 && size <= maxBytes && ttlMs > 0) {
          while (completed.size && (completed.size >= maxEntries || bytes + size > maxBytes)) remove(completed.keys().next().value);
          completed.set(key, { value: snapshot, bytes: size, expiresAt: now() + ttlMs });
          bytes += size;
        }
        return snapshot;
      });
      pending.set(key, task);
      try { return structuredClone(await task); }
      finally { pending.delete(key); }
    },
  };
}
