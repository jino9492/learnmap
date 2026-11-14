import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createWorkspace, combineSubject, learningProgress, conceptContentKey } from "./features/workspace/index.mjs";
import { createConfiguredClient, analysisOptionsFromEnv, extractConcepts, organizeConcepts, analyzeRelations, generateQuestion, publicQuestion, evaluateAnswer, recommendPath, localizeResult, AiError } from "./ai/index.ts";
import { loadMaterialBytes } from "./features/materials/index.mjs";
import { createAnalysisCache, analysisCacheScope } from "./features/material-analysis/cache.mjs";
import { measureAnalysisStage } from "./features/material-analysis/timing.mjs";
import { validateGraph } from "./features/knowledge-graph/index.ts";
import { expandConceptDetails, isDetailedExplanation } from "./ai/concept-extraction/details.ts";
import { mapBatches } from "./ai/core/batches.ts";
import { questionTargets, validateQuestion } from "./ai/question-generation/index.ts";
import { conceptCollectionSchema, relationCollectionSchema, evaluationSchema, recommendationSchema } from "./ai/core/schemas.ts";

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
  if (error instanceof AiError) return { code: error.code, message: error.message, ...(error.reason ? { reason: error.reason } : {}) };
  if (error instanceof HttpError) return { code: "INPUT", message: error.message };
  return { code: "INTERNAL", message: "The demo could not complete this operation." };
}

function send(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(value));
}

export function createDemoServer({ env = process.env, storagePath, clientFactory = (onEvent) => createConfiguredClient(env, { onEvent }) } = {}) {
  const workspace = createWorkspace(storagePath);
  const { analyses, subjects } = workspace;
  const cache = createAnalysisCache();
  const subjectLinks = new Map();
  const assets = new Map([
    ["/", { url: new URL("../../web/index.html", import.meta.url), type: "text/html; charset=utf-8" }],
    ["/demo", { url: new URL("../../demo/index.html", import.meta.url), type: "text/html; charset=utf-8" }],
    ["/web.js", { url: new URL("../../web/app.js", import.meta.url), type: "text/javascript; charset=utf-8" }],
    ["/explanation.js", { url: new URL("../../web/explanation.js", import.meta.url), type: "text/javascript; charset=utf-8" }],
    ["/graph.js", { url: new URL("../../web/graph.js", import.meta.url), type: "text/javascript; charset=utf-8" }],
    ["/styles.css", { url: new URL("../../web/styles.css", import.meta.url), type: "text/css; charset=utf-8" }],
    ["/assets/avatar.svg", { url: new URL("../../web/assets/avatar.svg", import.meta.url), type: "image/svg+xml" }],
    ["/app.js", { url: new URL("../../demo/app.js", import.meta.url), type: "text/javascript; charset=utf-8" }],
    ["/api.js", { url: new URL("../../demo/api.js", import.meta.url), type: "text/javascript; charset=utf-8" }],
    ["/loading.js", { url: new URL("../../demo/loading.js", import.meta.url), type: "text/javascript; charset=utf-8" }],
    ["/loading.css", { url: new URL("../../demo/loading.css", import.meta.url), type: "text/css; charset=utf-8" }],
  ]);

  function snapshot(job) {
    return {
      id: job.id, status: job.status, busy: job.busy, mode: job.mode,
      material: job.material ? { id: job.material.id, title: job.material.title, sourceCount: job.material.sources.length } : null,
      graph: job.status === "ready" ? { concepts: job.concepts, relations: job.relations } : null,
      detailedConcepts: job.status === "ready" && job.mode === "conceptual" ? job.detailedConcepts : undefined,
      localization: job.localization ?? null,
      events: job.events, error: job.error,
      warnings: (job.events ?? []).filter((event) => event.kind === 'progress' && event.warning).map((event) => event.detail),
      progress: [...job.progress.values()].map(learningProgress),
    };
  }

  async function analyze(job, name, bytes, previous = null) {
    const report = (event) => job.events.push(event);
    await measureAnalysisStage("analysis", async () => {
      const options = analysisOptionsFromEnv(env);
      const scope = analysisCacheScope(env, options);
      const stage = (name, input, run) => measureAnalysisStage(name, async () => {
        if (!options.cacheEnabled) {
          report({ kind: "cache", stage: name, status: "disabled" });
          return run();
        }
        let cacheStatus;
        const cached = await cache.run([scope, name, input], async () => {
          const start = job.events.length;
          const value = await run();
          return { value, warnings: job.events.slice(start).filter((event) => event.kind === 'progress' && event.warning) };
        }, (status) => {
          cacheStatus = status;
          report({ kind: 'cache', stage: name, status });
        });
        if (cacheStatus === 'hit' || cacheStatus === 'shared') cached.warnings.forEach(report);
        return cached.value;
      }, report);
      job.status = "extracting_text";
      job.material = await measureAnalysisStage("text", () => loadMaterialBytes(name, bytes), report);
      job.client = clientFactory((event) => job.events.push({ kind: "request", ...event }));
      const progress = (event) => job.events.push({ kind: "progress", ...event });
      job.status = "extracting_concepts";
      job.detailedConcepts = await stage("concepts", job.material, async () => expandConceptDetails(job.client, await extractConcepts(job.client, job.material, progress, options), job.material, progress, options));
      job.concepts = job.detailedConcepts;
      if (job.mode === "conceptual") {
        job.status = "organizing_concepts";
        job.concepts = await stage("organization", [job.material, job.detailedConcepts], () => organizeConcepts(job.client, job.material, job.detailedConcepts, progress, options));
      }
      job.status = "analyzing_relations";
      job.relations = await stage("relations", [job.material, job.concepts], () => analyzeRelations(job.client, job.material, job.concepts, progress, options));
      job.status = "localizing";
      const localized = await measureAnalysisStage("localization", () => localizeResult(job.client, {
        graph: { concepts: job.concepts, relations: job.relations },
        ...(job.mode === "conceptual" ? { detailedConcepts: job.detailedConcepts } : {}),
      }, { onProgress(event) {
        job.localization = { status: "running", completed: event.completed, total: event.total };
        progress(event);
      }, validate(value) {
        conceptCollectionSchema.parse({ concepts: value.graph.concepts });
        relationCollectionSchema.parse({ relations: value.graph.relations });
        validateGraph(value.graph);
        if (!value.graph.concepts.every((concept) => concept.details?.every((detail) => isDetailedExplanation(detail.description)))) {
          throw new AiError("FORMAT", "상세 설명을 축소해서 저장할 수 없습니다.");
        }
        if (value.detailedConcepts) conceptCollectionSchema.parse({ concepts: value.detailedConcepts });
      } }), report);
      job.concepts = localized.result.graph.concepts;
      job.relations = localized.result.graph.relations;
      if (previous) {
        const ids = new Map();
        for (const concept of job.concepts) {
          const existing = previous.concepts.find((item) => item.name === concept.name && item.description === concept.description);
          ids.set(concept.id, existing?.id ?? randomUUID());
        }
        job.concepts = job.concepts.map((concept) => ({ ...concept, id: ids.get(concept.id) }));
        job.relations = job.relations.map((relation) => ({ ...relation, source: ids.get(relation.source), target: ids.get(relation.target) }));
      }
      if (localized.result.detailedConcepts) job.detailedConcepts = localized.result.detailedConcepts;
      job.localization = localized.report;
      const subject = subjects.get(job.subjectId);
      if (subject) {
        job.status = "analyzing_relations";
        // Serialize subject updates so simultaneous uploads include the last completed graph.
        const pending = (subjectLinks.get(subject.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
          const available = new Map(analyses);
          available.set(job.id, { ...job, status: 'ready' });
          const combined = combineSubject(subject, available);
          if (new Set(combined.concepts.map((concept) => concept.sourceLocation.split('/')[0])).size > 1) {
            const relations = await stage('subject_relations', [combined.material, combined.concepts, combined.relations],
              () => analyzeRelations(job.client, combined.material, combined.concepts, progress, { ...options, crossMaterial: true, existingRelations: combined.relations }));
            subject.crossRelations = relations.filter((relation) => {
              const source = combined.concepts.find((concept) => concept.id === relation.source);
              const target = combined.concepts.find((concept) => concept.id === relation.target);
              return source.sourceLocation.split('/')[0] !== target.sourceLocation.split('/')[0];
            });
          }
          job.status = 'saving';
        });
        subjectLinks.set(subject.id, pending);
        try { await pending; }
        finally { if (subjectLinks.get(subject.id) === pending) subjectLinks.delete(subject.id); }
      } else job.status = "saving";
    }, report).catch((error) => {
      job.status = "failed";
      const failedStage = job.events.findLast((event) => event.kind === 'timing' && event.outcome === 'failed' && event.stage !== 'analysis')?.stage;
      job.error = { ...errorInfo(error), ...(failedStage ? { stage: failedStage } : {}) };
    });
    if (job.status === "failed" && previous) { Object.assign(job, previous); job.status = "ready"; }
    const subject = subjects.get(job.subjectId);
    if (subject && ['ready', 'saving'].includes(job.status) && !job.error) {
      const valid = new Set(combineSubject(subject, analyses).concepts.map((concept) => concept.id));
      for (const id of subject.progress.keys()) if (!valid.has(id)) subject.progress.delete(id);
      for (const [id, stored] of subject.questions) if (!valid.has(stored.conceptId)) subject.questions.delete(id);
      subject.path = null;
    }
    await workspace.save();
    if (job.status === 'saving') job.status = 'ready';
  }

  return createServer(async (request, response) => {
    try {
      await workspace.initialized;
      const allowedHosts = [`127.0.0.1:${request.socket.localPort}`, `localhost:${request.socket.localPort}`];
      if (!allowedHosts.includes(request.headers.host)) throw new HttpError(403, "Local demo requests only.");
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) throw new HttpError(403, "Cross-origin requests are not allowed.");
      const url = new URL(request.url, `http://${request.headers.host}`);
      const asset = assets.get(url.pathname);
      if (request.method === "GET" && asset) {
        const content = await readFile(asset.url);
        response.writeHead(200, {
          "Content-Type": asset.type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        });
        response.end(content);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/workspace") {
        send(response, 200, { subjects: [...subjects.values()].map((subject) => {
          const combined = combineSubject(subject, analyses);
          return { id: subject.id, name: subject.name, conceptCount: combined.concepts.length, materialCount: combined.materials.length };
        }) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/subjects") {
        const input = await jsonBody(request);
        const name = text(input.name, "subject name").trim();
        if (name.length > 80) throw new HttpError(400, "과목명은 80자 이내로 입력해 주세요.");
        const subject = { id: randomUUID(), name, questions: new Map(), progress: new Map(), history: [], path: null };
        subjects.set(subject.id, subject);
        await workspace.save();
        send(response, 201, { id: subject.id, name });
        return;
      }
      const subjectMatch = /^\/api\/subjects\/([a-f0-9-]+)$/.exec(url.pathname);
      if (subjectMatch && request.method === "GET") {
        const subject = subjects.get(subjectMatch[1]);
        if (!subject) throw new HttpError(404, "과목을 찾을 수 없습니다.");
        const combined = combineSubject(subject, analyses);
        send(response, 200, { id: subject.id, name: subject.name, graph: { concepts: combined.concepts, relations: combined.relations }, materials: combined.materials, progress: [...subject.progress.values()].map(learningProgress), history: subject.history, path: subject.path });
        return;
      }
      const materialMatch = /^\/api\/materials\/([a-f0-9-]+)(?:\/(file|analyze))?$/.exec(url.pathname);
      if (materialMatch) {
        const job = analyses.get(materialMatch[1]);
        if (!job) throw new HttpError(404, "학습 자료를 찾을 수 없습니다.");
        if (request.method === "GET" && materialMatch[2] === "file") {
          response.writeHead(200, { "Content-Type": job.filename.toLowerCase().endsWith(".pdf") ? "application/pdf" : "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(job.filename)}`, "Cache-Control": "no-store" });
          response.end(Buffer.from(job.bytes, "base64"));
          return;
        }
        if (request.method === "DELETE" && !materialMatch[2]) {
          if (!["ready", "failed"].includes(job.status)) throw new HttpError(409, "분석 완료 후 삭제해 주세요.");
          const subject = subjects.get(job.subjectId);
          if (subject?.busy) throw new HttpError(409, "학습 작업 완료 후 삭제해 주세요.");
          analyses.delete(job.id);
          if (subject) {
            const valid = new Set(combineSubject(subject, analyses).concepts.map((concept) => concept.id));
            for (const id of subject.progress.keys()) if (!valid.has(id)) subject.progress.delete(id);
            subject.path = null;
            subject.questions.clear();
          }
          await workspace.save();
          send(response, 200, { deleted: true });
          return;
        }
        if (request.method === "POST" && materialMatch[2] === "analyze") {
          if (!["ready", "failed"].includes(job.status) || subjects.get(job.subjectId)?.busy) throw new HttpError(409, "현재 작업이 끝난 후 다시 시도해 주세요.");
          // Keep the last successful graph available if a reanalysis fails.
          const previous = job.status === "ready" ? { concepts: job.concepts, relations: job.relations, material: job.material } : null;
          job.status = "queued"; job.error = null; job.events = [];
          send(response, 202, { id: job.id });
          void analyze(job, job.filename, Buffer.from(job.bytes, "base64"), previous).catch(() => { process.stderr.write("Could not save reanalysis.\n"); });
          return;
        }
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
        if (!/\.(pdf|txt|md)$/i.test(name)) throw new HttpError(400, "PDF, TXT 또는 Markdown 파일을 선택해 주세요.");
        const subjectId = url.searchParams.get("subjectId") || undefined;
        if (!subjectId && !name.toLowerCase().endsWith(".pdf")) throw new HttpError(400, "Select a PDF file.");
        if (subjectId && !subjects.has(subjectId)) throw new HttpError(404, "과목을 찾을 수 없습니다.");
        if (subjectId && subjects.get(subjectId).busy) throw new HttpError(409, "학습 작업이 끝난 후 자료를 추가해 주세요.");
        const bytes = await body(request, 20 * 1024 * 1024);
        if (!bytes.length) throw new HttpError(400, "The PDF file is empty.");
        const job = { id: randomUUID(), subjectId, filename: name, bytes: bytes.toString("base64"), mode, status: "queued", busy: false, events: [], error: null, questions: new Map(), progress: new Map() };
        analyses.set(job.id, job);
        await workspace.save();
        send(response, 202, { id: job.id });
        void analyze(job, name, bytes).catch(() => { process.stderr.write("Could not save analysis.\n"); });
        return;
      }
      const match = /^\/api\/analyses\/([a-f0-9-]+)(?:\/(questions|evaluations|path|details))?$/.exec(url.pathname);
      if (!match) throw new HttpError(404, "Not found.");
      const subject = subjects.get(match[1]);
      const job = subject ? combineSubject(subject, analyses) : analyses.get(match[1]);
      if (!job) throw new HttpError(404, "Analysis not found. Upload the PDF again if the server restarted.");
      if (request.method === "GET" && !match[2]) { send(response, 200, snapshot(job)); return; }
      if (request.method !== "POST" || !match[2]) throw new HttpError(405, "Method not allowed.");
      if (job.status !== "ready" || job.busy) throw new HttpError(409, "Wait for the current operation to finish.");
      if (subject) job.events = subject.events ??= [];
      if (!job.client) job.client = clientFactory((event) => {
        job.events?.push({ kind: "request", ...event });
        if (subject && job.events.length > 200) job.events.splice(0, job.events.length - 200);
      });
      const input = await jsonBody(request);
      if (job.busy || subject?.busy) throw new HttpError(409, "Wait for the current operation to finish.");
      job.busy = true;
      if (subject) subject.busy = true;
      try {
        if (match[2] === "evaluations") {
          const stored = job.questions.get(text(input.questionId, "question ID"));
          if (!stored) throw new HttpError(400, "Unknown question ID.");
          if (stored.superseded) throw new HttpError(409, "새 문제 묶음이 생성되었습니다. 최신 문제를 풀어 주세요.");
          if (stored.evaluated) throw new HttpError(409, "이미 평가한 문제입니다. 새 문제를 생성해 주세요.");
          const concept = job.concepts.find((concept) => concept.id === stored.conceptId);
          const answer = text(input.answer, "answer");
          const submission = subject ? { id: randomUUID(), conceptId: concept.id, conceptName: concept.name, question: stored.question.question, answer, status: "PENDING", createdAt: new Date().toISOString() } : null;
          if (submission) { subject.history.push(submission); await workspace.save(); }
          let rawEvaluation;
          try { rawEvaluation = await evaluateAnswer(job.client, stored.target ?? concept, job.material, stored.question, answer, { concepts: job.concepts, relations: job.relations }); }
          catch (error) {
            if (submission) { submission.status = "FAILED"; submission.error = errorInfo(error); submission.feedback = "평가를 완료하지 못했습니다. 제출한 답안은 보관되며 이해도에는 반영하지 않았습니다."; await workspace.save(); }
            throw error;
          }
          const { result: evaluation, report: localization } = await localizeResult(job.client, rawEvaluation, { validate: (value) => evaluationSchema.parse(value) });
          const history = job.progress.get(concept.id) ?? { conceptId: concept.id, scores: [], recentMistakes: [] };
          history.scores = [...history.scores, evaluation.score].slice(-100);
          if (stored.setId) {
            if (history.assessment?.id !== stored.setId) history.assessment = { id: stored.setId, total: stored.total, scores: {} };
            history.assessment.scores[input.questionId] = evaluation.score;
          }
          history.recentMistakes = evaluation.weakPoints.map((id) => `${id}: ${evaluation.feedback}`.slice(0, 2000));
          job.progress.set(concept.id, history);
          stored.evaluated = true;
          if (submission) Object.assign(submission, evaluation, { status: "EVALUATED" });
          await workspace.save();
          send(response, 200, { evaluation, progress: learningProgress(history), localization });
        } else {
          const concept = job.concepts.find((concept) => concept.id === text(input.conceptId, "concept ID"));
          if (!concept) throw new HttpError(400, "Unknown concept ID.");
          if (match[2] === "questions") {
            const targets = questionTargets(concept, job.material);
            const setId = randomUUID();
            const generated = await mapBatches(targets, analysisOptionsFromEnv(env).concurrency, async (target) => {
              const rawQuestion = await generateQuestion(job.client, target, job.material, input.type ?? "SHORT_ANSWER", input.difficulty ?? "MEDIUM");
              const { result: question, report: localization } = await localizeResult(job.client, rawQuestion, { validate: validateQuestion });
              return { id: randomUUID(), target, question, localization };
            });
            for (const stored of job.questions.values()) if (stored.conceptId === concept.id) stored.superseded = true;
            for (const entry of generated) job.questions.set(entry.id, { conceptId: concept.id, question: entry.question, target: entry.target, setId, total: generated.length });
            await workspace.save();
            const questions = generated.map((entry) => ({ questionId: entry.id, conceptId: concept.id,
              topic: entry.target.name, question: publicQuestion(entry.question), localization: { status: entry.localization.status, detected: entry.localization.detected, translated: entry.localization.translated, warning: entry.localization.warning } }));
            send(response, 200, { ...questions[0], setId, total: questions.length, questions });
          } else if (match[2] === "details") {
            const [expanded] = await expandConceptDetails(job.client, [concept], job.material, undefined, { ...analysisOptionsFromEnv(env), force: true });
            const { result: localized, report: localization } = await localizeResult(job.client, expanded, {
              validate: (value) => {
                conceptCollectionSchema.parse({ concepts: [value] });
                if (!value.details?.every((detail) => isDetailedExplanation(detail.description))) throw new AiError("FORMAT", "상세 설명이 요약으로 축소되었습니다.");
              },
            });
            if (subject) {
              subject.detailOverrides ??= {};
              subject.detailOverrides[concept.id] = { signature: conceptContentKey(concept), details: localized.details };
            } else concept.details = localized.details;
            await workspace.save();
            send(response, 200, { concept: localized, localization });
          } else {
            const rawPath = await recommendPath(job.client, { concepts: job.concepts, relations: job.relations }, concept.id, [...job.progress.values()].map((history) => ({ conceptId: history.conceptId, scores: [learningProgress(history).score], recentMistakes: history.recentMistakes })));
            const { result: path, report: localization } = await localizeResult(job.client, rawPath, { validate: (value) => recommendationSchema.parse(value) });
            if (subject) subject.path = path;
            await workspace.save();
            send(response, 200, { path, localization });
          }
        }
      } finally { job.busy = false; if (subject) subject.busy = false; }
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
    const server = createDemoServer({ storagePath: resolve(".learnmap/workspace.json") });
    server.on("error", (error) => { process.stderr.write(error.code === "EADDRINUSE" ? `LearnMap 포트 ${port}가 이미 사용 중입니다. 기존 LearnMap 서버가 실행 중이면 http://127.0.0.1:${port}에 접속하거나, 기존 서버를 종료한 뒤 npm start를 실행해 주세요.\n` : "Could not start the demo server.\n"); process.exitCode = 1; });
    server.listen(port, "127.0.0.1", () => process.stdout.write(`LearnMap: http://127.0.0.1:${port}\n`));
  }
}
