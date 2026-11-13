import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

export function createWorkspace(storagePath) {
  const analyses = new Map();
  const subjects = new Map();
  let pending = Promise.resolve();
  const initialized = (async () => {
    if (!storagePath) return;
    let data;
    try { data = JSON.parse(await readFile(storagePath, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const item of data.analyses ?? []) {
      const job = { ...item, questions: new Map(item.questions), progress: new Map(item.progress), busy: false };
      if (!["ready", "failed"].includes(job.status)) {
        job.status = "failed";
        job.error = { code: "INTERRUPTED", message: "서버가 재시작되어 분석이 중단되었습니다. 다시 분석해 주세요." };
      }
      analyses.set(job.id, job);
    }
    for (const item of data.subjects ?? []) {
      const history = item.history.map((entry) => entry.status === "PENDING" ? { ...entry, status: "FAILED", feedback: "서버 재시작으로 평가가 중단되었습니다. 제출한 답안은 보관했습니다." } : entry);
      subjects.set(item.id, { ...item, history, busy: false, questions: new Map(item.questions), progress: new Map(item.progress) });
    }
  })();
  void initialized.catch(() => { process.stderr.write("Could not load the local LearnMap workspace. Existing data was not overwritten.\n"); });
  function save() {
    if (!storagePath) return Promise.resolve();
    const serialize = (item) => ({ ...item, client: undefined, questions: [...item.questions], progress: [...item.progress] });
    const data = JSON.stringify({ analyses: [...analyses.values()].map(serialize), subjects: [...subjects.values()].map(serialize) });
    const next = pending.catch(() => undefined).then(async () => {
      await mkdir(dirname(storagePath), { recursive: true });
      await writeFile(`${storagePath}.tmp`, data, { mode: 0o600 });
      await rename(`${storagePath}.tmp`, storagePath);
    });
    pending = next;
    return next;
  }
  return { analyses, subjects, initialized, save };
}

export function combineSubject(subject, analyses) {
  const jobs = [...analyses.values()].filter((job) => job.subjectId === subject.id);
  const concepts = [];
  const relations = [];
  const sources = [];
  const identities = new Map();
  for (const job of jobs.filter((item) => item.status === "ready")) {
    const ids = new Map();
    for (const concept of job.concepts) {
      const identity = JSON.stringify([concept.name.trim().toLowerCase(), concept.description.trim()]);
      const sourceLocation = `${job.id}/${concept.sourceLocation}`;
      const citations = (concept.citations ?? [{ sourceLocation: concept.sourceLocation, evidence: concept.evidence }]).map((citation) => ({ ...citation, sourceLocation: `${job.id}/${citation.sourceLocation}` }));
      let target = identities.get(identity);
      if (!target) {
        target = { ...concept, id: `${job.id}:${concept.id}`, sourceLocation, citations };
        identities.set(identity, target);
        concepts.push(target);
      } else target.citations.push(...citations);
      ids.set(concept.id, target.id);
    }
    for (const relation of job.relations) {
      const source = ids.get(relation.source);
      const target = ids.get(relation.target);
      if (source === target || relations.some((item) => item.type === relation.type && ((item.source === source && item.target === target) || (relation.type === "RELATED" && item.source === target && item.target === source)))) continue;
      if (relation.type === "PREREQUISITE") {
        const pending = [target];
        const visited = new Set();
        while (pending.length) {
          const id = pending.pop();
          if (visited.has(id)) continue;
          visited.add(id);
          for (const link of relations) if (link.type === "PREREQUISITE" && link.source === id) pending.push(link.target);
        }
        if (visited.has(source)) continue;
      }
      relations.push({ ...relation, source, target });
    }
    sources.push(...job.material.sources.map((source) => ({ ...source, location: `${job.id}/${source.location}` })));
  }
  return {
    ...subject, status: concepts.length ? "ready" : "empty", concepts, relations,
    material: { id: subject.id, title: subject.name, sources },
    materials: jobs.map((job) => ({ id: job.id, title: job.filename, status: job.status, mode: job.mode, error: job.error })),
  };
}

export function learningProgress(history) {
  const scores = history.scores.slice(-5);
  const score = Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length);
  return { conceptId: history.conceptId, score, status: score >= 80 ? "MASTERED" : score >= 50 ? "REVIEW_REQUIRED" : "WEAK" };
}
