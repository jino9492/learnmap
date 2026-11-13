import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { createDemoServer } from "../apps/api/src/demo-server.mjs";
import { combineSubject, learningProgress } from "../apps/api/src/features/workspace/index.mjs";
import { layoutGraph } from "../apps/web/graph.js";
import { fixtureClientFactory } from "./fixture-client.mjs";

const fixture = JSON.parse(await readFile(new URL("../examples/fixture.json", import.meta.url), "utf8"));
const pdf = await readFile(new URL("../examples/lecture.pdf", import.meta.url));
const lecture = await readFile(new URL("../examples/lecture.txt", import.meta.url));

async function start(storagePath, overrides = {}) {
  const server = createDemoServer({ storagePath, clientFactory: fixtureClientFactory, env: {}, ...overrides });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (path, options) => { const response = await fetch(base + path, options); const value = await response.json(); assert.ok(response.ok, `${response.status}: ${JSON.stringify(value)}`); return value; };
  const post = (path, value) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const close = async () => { const done = new Promise((resolve) => server.close(resolve)); server.closeAllConnections(); await done; };
  return { server, base, api, post, close };
}
async function waitReady(api, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const snapshot = await api(`/api/analyses/${id}`);
    if (snapshot.status === "failed") assert.fail(JSON.stringify(snapshot.error));
    if (snapshot.status === "ready") return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Analysis did not finish.");
}

test("website connects durable subjects, multiple materials, graph, grading, history, path and original files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "learnmap-check-"));
  const storagePath = join(directory, "workspace.json");
  let session = await start(storagePath);
  try {
    const { api, post, base } = session;
    const html = await (await fetch(base)).text();
    assert.match(html, /styles.css/);
    assert.match(html, /지식 그래프/);
    for (const asset of ["/web.js", "/graph.js", "/styles.css", "/assets/avatar.svg", "/demo"]) assert.equal((await fetch(base + asset)).status, 200);
    assert.equal((await fetch(base + "/.learnmap/workspace.json")).status, 404);
    const subject = await post("/api/subjects", { name: "운영체제" });
    const other = await post("/api/subjects", { name: "자료구조" });
    const { id } = await api(`/api/analyses?filename=lecture.pdf&subjectId=${subject.id}`, { method: "POST", body: pdf });
    await waitReady(api, id);
    const second = await api(`/api/analyses?filename=lecture.txt&subjectId=${subject.id}`, { method: "POST", body: lecture });
    await waitReady(api, second.id);
    let view = await api(`/api/subjects/${subject.id}`);
    assert.equal(view.materials.length, 2);
    assert.equal(view.graph.concepts.length, 3);
    assert.equal(view.graph.concepts[0].citations.length, 2);
    assert.equal(view.graph.relations.length, 2);
    assert.equal((await api(`/api/subjects/${other.id}`)).graph.concepts.length, 0);
    const original = Buffer.from(await (await fetch(`${base}/api/materials/${id}/file`)).arrayBuffer());
    assert.deepEqual(original, pdf);
    const conceptId = view.graph.concepts.at(-1).id;
    const question = await post(`/api/analyses/${subject.id}/questions`, { conceptId, type: "ESSAY" });
    assert.doesNotMatch(JSON.stringify(question), /referenceAnswer|evaluationCriteria/);
    const result = await post(`/api/analyses/${subject.id}/evaluations`, { questionId: question.questionId, answer: "요청한 페이지가 물리 메모리에 없을 때 발생합니다." });
    assert.equal(result.evaluation.score, 100);
    const choice = await post(`/api/analyses/${subject.id}/questions`, { conceptId, type: "MULTIPLE_CHOICE" });
    assert.equal(choice.question.options.length,4);
    assert.doesNotMatch(JSON.stringify(choice),/referenceAnswer|evaluationCriteria/);
    assert.equal((await fetch(`${base}/api/analyses/${subject.id}/evaluations`, { method: "POST", body: JSON.stringify({ questionId: question.questionId, answer: "again" }) })).status, 409);
    const path = await post(`/api/analyses/${subject.id}/path`, { conceptId });
    assert.equal(path.path.steps.length, 3);
    await session.close(); session = await start(storagePath);
    view = await session.api(`/api/subjects/${subject.id}`);
    assert.equal(view.progress[0].score, 100);
    assert.equal(view.progress[0].status, "MASTERED");
    assert.equal(view.history.length, 1);
    assert.equal(view.path.steps.length, 3);
    assert.equal(view.materials.length, 2);
    assert.doesNotMatch(await readFile(storagePath, "utf8"), /api_key|OPENAI_API_KEY/);
    await session.api(`/api/materials/${second.id}`, { method: "DELETE" });
    view = await session.api(`/api/subjects/${subject.id}`);
    assert.equal(view.graph.concepts.length, 3);
    assert.equal(view.materials.length, 1);
    assert.equal(view.history.length, 1);
    assert.equal(view.path, null);
  } finally {
    await session.close();
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("learnmap-check-"));
    await rm(directory, { recursive: true, force: true });
  }
});

test("mastery uses the last five scores and graph layout preserves every concept", () => {
  assert.deepEqual(learningProgress({ conceptId: "x", scores: [0, 100, 100, 100, 100, 100] }), { conceptId: "x", score: 100, status: "MASTERED" });
  assert.equal(learningProgress({ conceptId: "x", scores: [40, 80] }).status, "REVIEW_REQUIRED");
  const concepts = fixture.concept_extraction.concepts;
  const layout = layoutGraph(concepts, fixture.relation_analysis.relations);
  assert.equal(layout.positions.size, concepts.length);
  assert.ok(layout.positions.get("c1").y < layout.positions.get("c2").y);
  assert.ok(layout.positions.get("c2").y < layout.positions.get("c3").y);
});

test("failed grading preserves the answer without changing mastery; failed reanalysis preserves the successful graph", async () => {
  let failure;
  const session = await start(undefined, { env: { AI_ANALYSIS_CACHE: "0" }, clientFactory: () => ({ async generate(request) {
    if (request.name === failure) throw new Error("Simulated provider outage");
    return fixtureClientFactory().generate(request);
  } }) });
  try {
    const subject = await session.post("/api/subjects", { name: "학습 공간" });
    const uploaded = await session.api(`/api/analyses?filename=lecture.pdf&subjectId=${subject.id}`, { method: "POST", body: pdf });
    await waitReady(session.api,uploaded.id);
    const original = await session.api(`/api/subjects/${subject.id}`);
    const conceptId = original.graph.concepts.at(-1).id;
    const question = await session.post(`/api/analyses/${subject.id}/questions`, { conceptId });
    failure = "answer_evaluation";
    const response = await fetch(`${session.base}/api/analyses/${subject.id}/evaluations`, { method: "POST", body: JSON.stringify({ questionId: question.questionId, answer: "보관할 답안" }) });
    assert.equal(response.status,500);
    let view = await session.api(`/api/subjects/${subject.id}`);
    assert.equal(view.history[0].answer,"보관할 답안");
    assert.equal(view.history[0].status,"FAILED");
    assert.equal(view.progress.length,0);
    failure = "concept_extraction";
    await session.post(`/api/materials/${uploaded.id}/analyze`, {});
    await waitReady(session.api,uploaded.id);
    view = await session.api(`/api/subjects/${subject.id}`);
    assert.deepEqual(view.graph,original.graph);
    assert.equal(view.materials[0].status,"ready");
    assert.ok(view.materials[0].error);
    assert.equal(view.materials[0].error.stage, 'concepts');
  } finally { await session.close(); }
});

test('overlapping core groups finish with preserved concepts and warnings, including cached reanalysis', async () => {
  let organizationCalls = 0;
  const session = await start(undefined, { clientFactory: () => ({ async generate(request) {
    if (request.name === 'concept_extraction') {
      const source = request.data.sources[0];
      return { concepts: ['신경망', '역전파'].map((name, index) => ({ id: `c${index + 1}`, name,
        description: source.excerpts[0].text, sourceLocation: source.location, evidence: source.excerpts[0].id })) };
    }
    if (request.name === 'concept_organization') {
      organizationCalls++;
      const ids = request.data.concepts.map((concept) => concept.id);
      return { groups: [{ name: '학습', description: '신경망 학습', memberIds: ids },
        { name: '중복', description: '중복 배정', memberIds: [ids[0]] }] };
    }
    assert.equal(request.name, 'relation_analysis');
    return { relations: [] };
  } }) });
  try {
    const subject = await session.post('/api/subjects', { name: '인공지능' });
    const uploaded = await session.api(`/api/analyses?filename=notes.txt&subjectId=${subject.id}&mode=conceptual`, {
      method: 'POST', body: '신경망은 연결 가중치를 사용합니다. 역전파는 출력 오차를 전달하여 가중치를 갱신합니다.',
    });
    const first = await waitReady(session.api, uploaded.id);
    assert.equal(first.error, null);
    assert.equal(first.graph.concepts.length, 2);
    assert.equal(first.warnings.length, 1);
    assert.match(first.warnings[0], /세부 개념과 원문 근거/);
    await session.post(`/api/materials/${uploaded.id}/analyze`, {});
    const second = await waitReady(session.api, uploaded.id);
    assert.equal(second.error, null);
    assert.equal(second.graph.concepts.length, 2);
    assert.deepEqual(second.warnings, first.warnings);
    assert.equal(organizationCalls, 2);
    assert.ok(second.events.some((event) => event.kind === 'cache' && event.stage === 'organization' && event.status === 'hit'));
  } finally { await session.close(); }
});

test("merging independently valid materials removes symmetric duplicates and prevents prerequisite cycles", () => {
  const concepts = fixture.concept_extraction.concepts;
  const relation = (source,target,type) => ({source,target,type,reason:"reason"});
  const makeJob = (id, relations) => [id, { id, subjectId: "s", filename: "file.pdf", status: "ready", concepts, relations, material: { sources: [{ location: "page:1", text: "text" }] } }];
  const analyses = new Map([makeJob("a", [relation("c1","c2","PREREQUISITE"),relation("c1","c2","RELATED")]), makeJob("b", [relation("c2","c1","PREREQUISITE"),relation("c2","c1","RELATED")])]);
  const result = combineSubject({id:"s"},analyses);
  assert.equal(result.concepts.length,3);
  assert.equal(result.relations.length,2);
});

test('sequential uploads analyze cross-file prerequisites, persist them, and remove deleted endpoints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'learnmap-links-'));
  const storagePath = join(directory, 'workspace.json');
  const clientFactory = () => ({ async generate(request) {
    if (request.name === 'concept_extraction') {
      const source = request.data.sources[0];
      return { concepts: [{ id: 'c1', name: source.excerpts[0].text.includes('역전파') ? '역전파' : '인공신경망',
        description: source.excerpts[0].text, sourceLocation: source.location, evidence: source.excerpts[0].id }] };
    }
    assert.equal(request.name, 'relation_analysis');
    const nodes = request.data.concepts;
    if (nodes.length === 1) return { relations: [] };
    const source = nodes.find((concept) => concept.name === '인공신경망');
    const target = nodes.find((concept) => concept.name === '역전파');
    assert.ok(source.sourceLocation.split('/')[0] !== target.sourceLocation.split('/')[0]);
    return { relations: [{ source: source.id, target: target.id, type: 'PREREQUISITE', reason: '신경망의 연결 가중치를 이해한 뒤 역전파의 가중치 갱신을 학습합니다.' }] };
  } });
  let session = await start(storagePath, { clientFactory });
  try {
    const subject = await session.post('/api/subjects', { name: '인공지능' });
    const upload = (name, body) => session.api(`/api/analyses?filename=${name}.txt&subjectId=${subject.id}`, { method: 'POST', body });
    const first = await upload('02', '인공신경망은 연결의 가중치를 통해 입력을 출력으로 변환합니다.');
    await waitReady(session.api, first.id);
    assert.equal((await session.api(`/api/subjects/${subject.id}`)).graph.relations.length, 0);
    const second = await upload('03', '역전파는 신경망의 출력 오차를 전달하여 연결 가중치를 갱신합니다.');
    await waitReady(session.api, second.id);
    const graph = (await session.api(`/api/subjects/${subject.id}`)).graph;
    assert.equal(graph.relations.length, 1);
    assert.equal(graph.relations[0].type, 'PREREQUISITE');
    await session.close();
    session = await start(storagePath, { clientFactory });
    assert.deepEqual((await session.api(`/api/subjects/${subject.id}`)).graph, graph);
    await session.api(`/api/materials/${second.id}`, { method: 'DELETE' });
    const remaining = (await session.api(`/api/subjects/${subject.id}`)).graph;
    assert.equal(remaining.concepts.length, 1);
    assert.equal(remaining.relations.length, 0);
  } finally {
    await session.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('learnmap-links-'));
    await rm(directory, { recursive: true, force: true });
  }
});
