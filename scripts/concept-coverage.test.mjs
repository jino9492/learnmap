import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { extractConcepts, organizeConcepts } from '../apps/api/src/ai/index.ts';
import { expandConceptDetails } from '../apps/api/src/ai/concept-extraction/details.ts';
import { AiError } from '../apps/api/src/ai/core/errors.ts';
import { explanationBlocks } from '../apps/web/explanation.js';
import { questionTargets } from '../apps/api/src/ai/question-generation/index.ts';
import { createWorkspace, combineSubject, learningProgress, conceptContentKey } from '../apps/api/src/features/workspace/index.mjs';
import { createDemoServer } from '../apps/api/src/demo-server.mjs';

const lesson = JSON.parse(await readFile(new URL('../examples/fixture.json', import.meta.url), 'utf8')).concept_detail_expansion.description;
const hasExplanation = (value) => typeof value === 'string' && Boolean(value.trim());

const details = ['정의', '작동 원리', '예외 조건'].map((name, index) => ({
  name, description: `${name}에 관한 자세한 설명입니다.`, sourceLocation: 'page:1', evidence: `${index + 1}번째 학습 범위의 원문입니다.`,
}));
const concept = { ...details[0], id: 'c1', name: '학습 개념', description: '사이드바 요약입니다.', details };
const material = { id: 'm1', title: '학습 자료', sources: [{ location: 'page:1', text: details.map((detail) => detail.evidence).join('\n') }] };

test('extraction and organization preserve detailed explanations and omitted source passages', async () => {
  const input = { ...material, sources: [{ location: 'page:1', text: '원문 학습 내용입니다. '.repeat(90) }] };
  const extracted = await extractConcepts({ async generate(request) {
    const excerpt = request.data.sources[0].excerpts[0];
    return { concepts: [{ id: 'c1', name: '학습 개념', description: '짧은 요약입니다.', sourceLocation: 'page:1', evidence: excerpt.id,
      details: [{ name: '세부 원리', description: '정의와 예외, 절차를 모두 설명하는 상세 내용입니다.', evidenceIds: [excerpt.id] }] }] };
  } }, input);
  assert.equal(extracted[0].details[0].description, '정의와 예외, 절차를 모두 설명하는 상세 내용입니다.');
  assert.equal(extracted[0].details.map((detail) => detail.evidence).join(''), input.sources[0].text);
  const organized = await organizeConcepts({ async generate(request) {
    return { groups: [{ name: '정리된 개념', description: '핵심 요약입니다.', memberIds: request.data.concepts.map((item) => item.id) }] };
  } }, input, extracted);
  assert.deepEqual(organized[0].details, extracted[0].details);
});

test('question targets cover every subtopic, split long evidence, and support legacy graphs', () => {
  assert.equal(questionTargets(concept, material).length, 3);
  const long = '긴 원문 근거입니다. '.repeat(400);
  const source = { ...material, sources: [{ location: 'page:1', text: long }] };
  const targets = questionTargets({ ...concept, evidence: long, details: [{ ...details[0], evidence: long }] }, source);
  assert.ok(targets.length > 1);
  assert.equal(targets.map((target) => target.evidence).join(''), long);
  const { details: omitted, ...legacy } = concept;
  assert.equal(questionTargets(legacy, material).length, 1);
  assert.throws(() => questionTargets({ ...concept, details: [{ ...details[0], evidence: '없는 원문' }] }, material));
});

test('combined materials retain the location and full detail of each source', () => {
  const subject = { id: 'subject', name: '과목' };
  const combined = combineSubject(subject, new Map(['a', 'b'].map((id) => [id, { id, subjectId: subject.id, status: 'ready', concepts: [concept], relations: [], material }])));
  assert.equal(combined.concepts.length, 1);
  assert.equal(combined.concepts[0].details.length, 6);
  assert.deepEqual(new Set(combined.concepts[0].details.map((detail) => detail.sourceLocation)), new Set(['a/page:1', 'b/page:1']));
});

test('mastery uses all assessment questions, including questions beyond the old five-score window', () => {
  const scores = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index, index < 3 ? 0 : 100]));
  const progress = learningProgress({ conceptId: 'c1', scores: [100, 100, 100, 100, 100], assessment: { total: 8, scores } });
  assert.equal(progress.score, 63);
  assert.equal(progress.status, 'REVIEW_REQUIRED');
  const partial = learningProgress({ conceptId: 'c1', assessment: { total: 8, scores: { first: 100 } } });
  assert.equal(partial.accuracy, 100);
  assert.equal(partial.score, 13);
  assert.notEqual(partial.status, 'MASTERED');
});

test('question sets grade cumulatively, survive restart, reject duplicate and superseded answers, and feed paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'learnmap-coverage-'));
  const storagePath = join(directory, 'workspace.json');
  const workspace = createWorkspace(storagePath);
  await workspace.initialized;
  const id = '11111111-1111-4111-8111-111111111111';
  const subjectId = '22222222-2222-4222-8222-222222222222';
  workspace.subjects.set(subjectId, { id: subjectId, name: '과목', questions: new Map(), progress: new Map(), history: [], path: null });
  workspace.analyses.set(id, { id, subjectId, status: 'ready', material, concepts: [concept], relations: [], questions: new Map(), progress: new Map() });
  await workspace.save();
  let failGeneration = false;
  let failExpansion = false;
  let expectedPathScore = 100;
  const clientFactory = () => ({ async generate(request) {
    if (request.name === 'concept_detail_expansion') return { description: failExpansion ? '짧은 요약' : lesson };
    if (request.name === 'question_generation') {
      if (failGeneration) throw new Error('provider unavailable');
      return { type: request.data.type, question: `${request.data.concept.name}의 내용을 설명하세요.`, options: [], referenceAnswer: '핵심 설명입니다.', evaluationCriteria: ['핵심 내용을 설명합니다.'] };
    }
    if (request.name === 'answer_evaluation') {
      const score = Number(request.data.answer);
      return { score, feedback: '핵심 조건을 모범 답안과 비교해 복습하세요.', weakPoints: score === 100 ? [] : ['c1'] };
    }
    if (request.name === 'path_recommendation') {
      assert.deepEqual(request.data.progress[0].scores, [expectedPathScore]);
      return { steps: [{ conceptId: 'c1', reason: '평가 범위를 복습합니다.' }], possibleCause: '일부 조건을 혼동했을 가능성이 있습니다.' };
    }
    assert.fail(`Unexpected request: ${request.name}`);
  } });
  let server;
  let base;
  async function start() {
    server = createDemoServer({ storagePath, clientFactory, env: {} });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}/api/analyses/${id}`;
  }
  async function stop() {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections(); await closed;
  }
  async function post(action, data, status = 200) {
    const response = await fetch(`${base}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  try {
    await start();
    const set = await post('questions', { conceptId: 'c1' });
    assert.equal(set.total, 3);
    assert.doesNotMatch(JSON.stringify(set), /referenceAnswer|evaluationCriteria/);
    const grade = (question, answer, status) => post('evaluations', { questionId: question.questionId, answer: String(answer) }, status);
    const first = await grade(set.questions[0], 100);
    assert.equal(first.progress.score, 33);
    assert.equal(first.progress.accuracy, 100);
    await grade(set.questions[0], 100, 409);
    await stop(); await start();
    await grade(set.questions[1], 0);
    const final = await grade(set.questions[2], 50);
    assert.equal(final.progress.score, 50);
    assert.equal(final.progress.accuracy, 50);
    expectedPathScore = 50;
    await post('path', { conceptId: 'c1' });
    const next = await post('questions', { conceptId: 'c1' });
    assert.equal((await (await fetch(base)).json()).progress[0].score, 50);
    await grade(set.questions[2], 100, 409);
    failGeneration = true;
    await post('questions', { conceptId: 'c1' }, 500);
    failGeneration = false;
    for (const question of next.questions) await grade(question, 100);
    const snapshot = await (await fetch(base)).json();
    assert.equal(snapshot.progress[0].status, 'MASTERED');
    assert.equal(snapshot.progress[0].score, 100);
    expectedPathScore = 100;
    await post('path', { conceptId: 'c1' });
    const expanded = await post('details', { conceptId: 'c1' });
    assert.ok(expanded.concept.details.every((detail) => hasExplanation(detail.description)));
    await stop(); await start();
    assert.ok((await (await fetch(base)).json()).graph.concepts[0].details.every((detail) => hasExplanation(detail.description)));
    assert.equal((await (await fetch(base)).json()).progress[0].score, 100);
    const subjectBase = base.replace(id, subjectId);
    const conceptId = `${id}:c1`;
    base = subjectBase;
    await post('details', { conceptId });
    failExpansion = true;
    const compact = await post('details', { conceptId });
    assert.ok(compact.concept.details.every((detail) => detail.description === '짧은 요약'));
    failExpansion = false;
    await stop(); await start();
    const savedSubject = await (await fetch(base.replace(id, subjectId))).json();
    assert.ok(savedSubject.graph.concepts[0].details.every((detail) => detail.description === '짧은 요약'));
    const stored = JSON.parse(await readFile(storagePath, 'utf8'));
    assert.ok(stored.subjects[0].detailOverrides[conceptId].signature);

  } finally {
    if (server?.listening) await stop();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('learnmap-coverage-'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('explanation depth is prompt-guided and compact answers preserve sources without quality retries', async () => {
  const calls = [];
  const original = structuredClone(concept);
  const expanded = await expandConceptDetails({ async generate(request) {
    calls.push(request);
    return { description: '개념의 의미를 간결하게 설명합니다.' };
  } }, [concept], material, undefined, { concurrency: 1 });
  assert.equal(calls.length, details.length);
  assert.ok(calls.every((call) => !call.data.correction));
  assert.match(calls[0].instructions, /topic's complexity/);
  assert.match(calls[0].instructions, /silently review/);
  assert.equal(calls[0].schema.json.properties.description.minLength, 1);
  assert.equal(expanded[0].description, concept.description);
  assert.deepEqual(expanded[0].details.map((detail) => detail.evidence), details.map((detail) => detail.evidence));
  assert.ok(expanded[0].details.every((detail) => detail.description === '개념의 의미를 간결하게 설명합니다.'));
  assert.deepEqual(concept, original);
});

test('explanations regenerate without using length to classify existing or legacy descriptions', async () => {
  const rich = { ...concept, details: [{ ...details[0], description: lesson }] };
  let calls = 0;
  const client = { async generate() { calls++; return { description: '새로운 설명입니다.' }; } };
  const [regenerated] = await expandConceptDetails(client, [rich], material);
  assert.equal(calls, 1);
  assert.equal(regenerated.details[0].description, '새로운 설명입니다.');
  const { details: omitted, ...legacy } = concept;
  const [expanded] = await expandConceptDetails(client, [legacy], material);
  assert.equal(expanded.details[0].description, '새로운 설명입니다.');
  assert.notEqual(expanded.details[0].description, legacy.description);
});

test('unreadable detail responses retain the existing explanation and continue remaining topics', async () => {
  const events = []; let attempts = 0;
  const [expanded] = await expandConceptDetails({ async generate(request) {
    attempts++;
    return request.data.topic === details[0].name ? { description: '' } : { description: '생성된 설명' };
  } }, [concept], material, (event) => events.push(event), { concurrency: 1 });
  assert.equal(attempts, 5);
  assert.equal(expanded.details[0].description, details[0].description);
  assert.ok(expanded.details.slice(1).every((detail) => detail.description === '생성된 설명'));
  assert.ok(events.some((event) => event.warning));
  assert.equal(events.at(-1).completed, details.length);
  assert.deepEqual(expanded.details.map((detail) => detail.evidence), details.map((detail) => detail.evidence));
  await assert.rejects(expandConceptDetails({ async generate() {
    throw new AiError('CONNECTION', '모델 연결 실패');
  } }, [concept], material), { code: 'CONNECTION' });
});

test('regenerated subject lessons apply only while their original sources match', () => {
  const subject = { id: 'subject', name: '과목' };
  const jobs = new Map([['a', { id: 'a', subjectId: 'subject', status: 'ready', concepts: [concept], relations: [], material }]]);
  const combined = combineSubject(subject, jobs);
  const current = combined.concepts[0];
  const expanded = current.details.map((detail) => ({ ...detail, description: lesson }));
  subject.detailOverrides = { [current.id]: { signature: conceptContentKey(current), details: expanded } };
  assert.deepEqual(combineSubject(subject, jobs).concepts[0].details, expanded);
  jobs.get('a').concepts = [{ ...concept, description: '자료가 변경되었습니다.' }];
  assert.notDeepEqual(combineSubject(subject, jobs).concepts[0].details, expanded);
});

test('lesson headings, paragraphs and code are separated without interpreting generated HTML', () => {
  const blocks = explanationBlocks('### 원리\n첫 번째 설명입니다.\n\n두 번째 설명입니다.\n\n```js\nconst example = "<script>";\n```');
  assert.deepEqual(blocks.map((block) => block.type), ['heading', 'paragraph', 'paragraph', 'code']);
  assert.equal(blocks[0].text, '원리');
  assert.equal(blocks[3].text, 'const example = "<script>";');
  assert.deepEqual(explanationBlocks('의미와 배경\n충분한 설명을 표시합니다.').map((block) => block.type), ['heading', 'paragraph']);
});
