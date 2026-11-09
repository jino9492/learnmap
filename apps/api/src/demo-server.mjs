import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createConfiguredClient, extractConcepts, organizeConcepts, analyzeRelations, generateQuestion, publicQuestion, evaluateAnswer, recommendPath, AiError } from "./ai/index.ts";
import { loadMaterialBytes } from "./features/materials/index.mjs";

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function body(request, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= limit) chunks.push(chunk);
    else chunks.length = 0;
  }
  if (size > limit) throw new HttpError(413, "Request body is too large.");
  return Buffer.concat(chunks);
}

async function jsonBody(request) {
  const bytes = await body(request, 65536);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new HttpError(400, "Invalid JSON request."); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, "Expected a JSON object.");
  return value;
}

function text(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > 8000) throw new HttpError(400, `Invalid ${name}.`);
  return value;
}

function errorInfo(error) {
  if (error instanceof AiError) return { code: error.code, message: error.message };
  if (error instanceof HttpError) return { code: "INPUT", message: error.message };
  return { code: "INTERNAL", message: "The demo could not complete this operation." };
}

function send(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(value));
}

export function createDemoServer({ env = process.env, clientFactory = (onEvent) => createConfiguredClient(env, { onEvent }) } = {}) {
  const analyses = new Map();
  const assets = new Map([
    ["/", { url: new URL("../../demo/index.html", import.meta.url), type: "text/html; charset=utf-8" }],
    ["/app.js", { url: new URL("../../demo/app.js", import.meta.url), type: "text/javascript; charset=utf-8" }],
    ["/api.js", { url: new URL("../../demo/api.js", import.meta.url), type: "text/javascript; charset=utf-8" }],
  ]);

  function snapshot(job) {
    return {
      id: job.id, status: job.status, busy: job.busy, mode: job.mode,
      material: job.material ? { id: job.material.id, title: job.material.title, sourceCount: job.material.sources.length } : null,
      graph: job.concepts ? { concepts: job.concepts, relations: job.relations ?? null } : null,
      detailedConcepts: job.mode === "conceptual" ? job.detailedConcepts : undefined,
      events: job.events, error: job.error,
    };
  }

  async function analyze(job, name, bytes) {
    try {
      job.status = "extracting_text";
      job.material = await loadMaterialBytes(name, bytes);
      job.client = clientFactory((event) => job.events.push({ kind: "request", ...event }));
      const progress = (event) => job.events.push({ kind: "progress", ...event });
      job.status = "extracting_concepts";
      const batchValue = env.AI_BATCH_CHARACTERS?.trim();
      job.detailedConcepts = await extractConcepts(job.client, job.material, progress, { batchCharacters: batchValue ? Number(batchValue) : undefined });
      job.concepts = job.detailedConcepts;
      if (job.mode === "conceptual") {
        job.status = "organizing_concepts";
        job.concepts = await organizeConcepts(job.client, job.material, job.detailedConcepts, progress);
      }
      job.status = "analyzing_relations";
      job.relations = await analyzeRelations(job.client, job.material, job.concepts, progress);
      job.status = "ready";
    } catch (error) {
      job.status = "failed";
      job.error = errorInfo(error);
    }
  }

  return createServer(async (request, response) => {
    try {
      const allowedHosts = [`127.0.0.1:${request.socket.localPort}`, `localhost:${request.socket.localPort}`];
      if (!allowedHosts.includes(request.headers.host)) throw new HttpError(403, "Local demo requests only.");
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) throw new HttpError(403, "Cross-origin requests are not allowed.");
      const url = new URL(request.url, `http://${request.headers.host}`);
      const asset = assets.get(url.pathname);
      if (request.method === "GET" && asset) {
        const content = await readFile(asset.url);
        response.writeHead(200, {
          "Content-Type": asset.type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        });
        response.end(content);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/config") {
        const provider = env.AI_PROVIDER?.trim().toLowerCase() || "openai";
        const model = provider === "ollama" ? env.OLLAMA_MODEL : provider === "gemini" ? env.GEMINI_MODEL : env.OPENAI_MODEL;
        send(response, 200, { provider, model: model ?? "" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/analyses") {
        const mode = url.searchParams.get("mode") || "detailed";
        if (!["detailed", "conceptual"].includes(mode)) throw new HttpError(400, "Mode must be detailed or conceptual.");
        const name = text(url.searchParams.get("filename"), "filename");
        if (!name.toLowerCase().endsWith(".pdf")) throw new HttpError(400, "Select a PDF file.");
        const bytes = await body(request, 20 * 1024 * 1024);
        if (!bytes.length) throw new HttpError(400, "The PDF file is empty.");
        const job = { id: randomUUID(), mode, status: "queued", busy: false, events: [], error: null, questions: new Map(), progress: new Map() };
        analyses.set(job.id, job);
        send(response, 202, { id: job.id });
        void analyze(job, name, bytes);
        return;
      }
      const match = /^\/api\/analyses\/([a-f0-9-]+)(?:\/(questions|evaluations|path))?$/.exec(url.pathname);
      if (!match) throw new HttpError(404, "Not found.");
      const job = analyses.get(match[1]);
      if (!job) throw new HttpError(404, "Analysis not found. Upload the PDF again if the server restarted.");
      if (request.method === "GET" && !match[2]) { send(response, 200, snapshot(job)); return; }
      if (request.method !== "POST" || !match[2]) throw new HttpError(405, "Method not allowed.");
      if (job.status !== "ready" || job.busy) throw new HttpError(409, "Wait for the current operation to finish.");
      const input = await jsonBody(request);
      if (job.busy) throw new HttpError(409, "Wait for the current operation to finish.");
      job.busy = true;
      try {
        if (match[2] === "evaluations") {
          const stored = job.questions.get(text(input.questionId, "question ID"));
          if (!stored) throw new HttpError(400, "Unknown question ID.");
          const concept = job.concepts.find((concept) => concept.id === stored.conceptId);
          const answer = text(input.answer, "answer");
          const evaluation = await evaluateAnswer(job.client, concept, job.material, stored.question, answer);
          const history = job.progress.get(concept.id) ?? { conceptId: concept.id, scores: [], recentMistakes: [] };
          history.scores = [...history.scores, evaluation.score].slice(-100);
          history.recentMistakes = evaluation.weakPoints;
          job.progress.set(concept.id, history);
          send(response, 200, { evaluation });
        } else {
          const concept = job.concepts.find((concept) => concept.id === text(input.conceptId, "concept ID"));
          if (!concept) throw new HttpError(400, "Unknown concept ID.");
          if (match[2] === "questions") {
            const question = await generateQuestion(job.client, concept, job.material, input.type ?? "SHORT_ANSWER", input.difficulty ?? "MEDIUM");
            const id = randomUUID();
            job.questions.set(id, { conceptId: concept.id, question });
            send(response, 200, { questionId: id, conceptId: concept.id, question: publicQuestion(question) });
          } else {
            const path = await recommendPath(job.client, { concepts: job.concepts, relations: job.relations }, concept.id, [...job.progress.values()]);
            send(response, 200, { path });
          }
        }
      } finally { job.busy = false; }
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof AiError ? ({ INPUT: 400, CONFIG: 503, TIMEOUT: 504, REFUSAL: 422 }[error.code] ?? 502) : 500;
      if (!response.headersSent) send(response, status, { error: errorInfo(error) });
      else response.end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.DEMO_PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write("DEMO_PORT must be an integer from 1 to 65535.\n");
    process.exitCode = 1;
  } else {
    const server = createDemoServer();
    server.on("error", (error) => { process.stderr.write(error.code === "EADDRINUSE" ? "Demo port is already in use. Set DEMO_PORT to another port.\n" : "Could not start the demo server.\n"); process.exitCode = 1; });
    server.listen(port, "127.0.0.1", () => process.stdout.write(`AI demo: http://127.0.0.1:${port}\n`));
  }
}
