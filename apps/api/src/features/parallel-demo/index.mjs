import { randomUUID } from "node:crypto";
import { analysisProgress } from "../material-analysis/progress.mjs";
import { combineSubject } from "../workspace/index.mjs";
import { usageTokens } from "../../ai/core/queue.ts";
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_MIB,
} from "../../../../shared/upload-limit.ts";

export const MAX_FILES = 8;
export const MAX_USERS = 64;
const reject = (status, message) =>
  Object.assign(new Error(message), { status });

export function createParallelDemo({
  analyze,
  analyses,
  subjects,
  reserveAnalysis,
}) {
  let current;
  function snapshot(owner) {
    if (!current || current.owner !== owner) return null;
    return {
      id: current.id,
      started: current.started,
      ended: current.ended,
      error: current.error?.message,
      stopping: current.controller.signal.aborted,
      users: current.users.map((user) => ({
        number: user.number,
        graph: user.graph,
        files: user.jobs.map((job) => {
          const progress = analysisProgress(job);
          const calls = job.events.filter(
            (event) => event.kind === "request" && !event.error,
          );
          return {
            name: job.filename,
            status: job.status,
            stage: progress.label,
            percent: progress.percent,
            completed: progress.completed,
            total: progress.total,
            active: job.queueState?.active ?? 0,
            waiting: job.queueState?.waiting ?? 0,
            calls: calls.length,
            tokens: calls.reduce(
              (sum, event) => sum + (usageTokens(event.usage) ?? 0),
              0,
            ),
            error: job.error?.message,
            incomplete: job.events.some(
              (e) => e.kind === "progress" && e.incomplete,
            ),
            warnings: job.events.filter(
              (e) => e.kind === "progress" && e.warning,
            ).length,
          };
        }),
      })),
    };
  }
  function stop(owner, id) {
    if (current?.owner !== owner || current.id !== id)
      throw reject(404, "실험을 찾을 수 없습니다.");
    current.controller.abort();
  }
  async function start(owner, form) {
    const count = Number(form.get("users"));
    const input = form.getAll("files");
    if (!Number.isInteger(count) || count < 1 || count > MAX_USERS)
      throw reject(400, "사용자 수는 1~64명입니다.");
    if (!input.length || input.length > MAX_FILES)
      throw reject(400, "한 묶음에 파일 1~8개를 선택하세요.");
    for (const file of input) {
      if (
        !(file instanceof File) ||
        !/\.(pdf|md|txt)$/i.test(file.name) ||
        !file.size ||
        file.size > MAX_UPLOAD_BYTES
      )
        throw reject(
          400,
          `PDF, TXT, Markdown 파일을 파일당 ${MAX_UPLOAD_MIB} MiB까지 사용할 수 있습니다.`,
        );
    }
    const files = await Promise.all(
      input.map(async (file) => ({
        name: file.name,
        bytes: Buffer.from(await file.arrayBuffer()),
      })),
    );
    if (current && !current.ended)
      throw reject(409, "진행 중인 실험이 끝난 뒤 다시 시작하세요.");
    const run = {
      id: randomUUID(),
      owner,
      started: Date.now(),
      ended: null,
      controller: new AbortController(),
      users: [],
    };
    current = run;
    for (let number = 1; number <= count; number++) {
      const subject = {
        id: randomUUID(),
        ownerId: randomUUID(),
        name: `사용자 ${number}`,
        questions: new Map(),
        progress: new Map(),
        history: [],
        path: null,
      };
      const jobs = files.map((file) => ({
        id: randomUUID(),
        filename: file.name,
        ownerId: subject.ownerId,
        subjectId: subject.id,
        mode: "detailed",
        status: "queued",
        events: [],
        error: null,
        questions: new Map(),
        progress: new Map(),
      }));
      run.users.push({ number, subject, jobs, graph: null });
    }
    function markStopped(job) {
      job.status = run.error ? "failed" : "cancelled";
      if (run.error) job.error = run.error;
    }
    let next = 0;
    async function worker() {
      while (next < run.users.length) {
        const user = run.users[next++];
        subjects.set(user.subject.id, user.subject);
        try {
          for (const [index, job] of user.jobs.entries()) {
            if (run.controller.signal.aborted) {
              markStopped(job);
              continue;
            }
            analyses.set(job.id, job);
            let release;
            try {
              release = reserveAnalysis(user.subject.ownerId);
              await analyze(
                job,
                job.filename,
                files[index].bytes,
                null,
                run.controller.signal,
              );
            } catch (error) {
              job.status = "failed";
              job.error = { message: error.message, reason: error.reason };
            } finally {
              release?.();
            }
            if (job.error?.reason === "QUOTA_EXHAUSTED" && !run.error) {
              run.error = job.error;
              run.controller.abort();
            }
            if (run.controller.signal.aborted && job.status !== "ready")
              markStopped(job);
          }
          const graph = combineSubject(user.subject, analyses);
          user.graph = {
            concepts: graph.concepts.length,
            relations: graph.relations.length,
          };
        } finally {
          subjects.delete(user.subject.id);
          for (const job of user.jobs) {
            analyses.delete(job.id);
            // Keep the measurements, release extracted text, model results and prompts.
            delete job.client;
            delete job.material;
            delete job.concepts;
            delete job.detailedConcepts;
            delete job.relations;
          }
        }
      }
    }
    void Promise.allSettled(
      Array.from({ length: Math.min(count, 16) }, worker),
    ).then(() => {
      run.ended = Date.now();
    });
    return run.id;
  }
  return { start, snapshot, stop };
}
