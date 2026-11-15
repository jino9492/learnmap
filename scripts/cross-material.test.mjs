import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRelations } from '../apps/api/src/ai/relation-analysis/index.ts';
import { crossMaterialRequests } from '../apps/api/src/ai/relation-analysis/cross-material.ts';
import { createConfiguredClient } from '../apps/api/src/ai/core/config.ts';
import { object, text } from '../apps/api/src/ai/core/schema.ts';
import { AiError } from '../apps/api/src/ai/core/errors.ts';
import { requestCharacters, REQUEST_CHARACTERS } from '../apps/api/src/ai/core/partition.ts';
import { createAnalysisCache } from '../apps/api/src/features/material-analysis/cache.mjs';

function input(count = 5) {
  const concepts = ['a', 'b', 'c'].flatMap((origin) => Array.from({ length: count }, (_, index) => ({
    id: `${origin}:${index}`, name: `주제 ${origin}${index}`, description: '관련 개념과의 의미를 설명하는 학습 단위입니다.',
    sourceLocation: `${origin}/page:${index + 1}`, evidence: `${origin}${index}에 관한 원문 근거입니다.`,
  })));
  return { concepts, material: { id: 's', title: '통합 자료', sources: concepts.map((concept) => ({ location: concept.sourceLocation, text: concept.evidence })) } };
}

function candidates(request) {
  return { selected: request.data.queries.flatMap((query) => query.allowedTargets.slice(0, 4).map((right) => ({ left: query.id, right, score: 80 }))).slice(0, 16) };
}

export function decisions(request, type = 'RELATED') {
  return { decisions: request.data.pairs.map((pair) => ({ pairId: pair.id, type,
    source: pair.left, target: pair.right,
    evidenceIds: type === 'NONE' ? [] : [...new Set(request.data.concepts.filter((node) => [pair.left, pair.right].includes(node.id)).flatMap((node) => node.evidenceIds))],
    reason: '두 개념의 구체적인 연관성이 원문에 제시되어 있습니다.',
  })) };
}

test('all changed-material pairs are screened exactly once; high inference uses only selected explicit pairs', async () => {
  const { concepts, material } = input();
  const screened = new Set();
  const judged = new Set();
  const previous = { source: 'a:0', target: 'b:0', type: 'RELATED', reason: '이전 관계입니다.' };
  const result = await analyzeRelations({ async generate(request) {
    assert.ok(requestCharacters(request) <= REQUEST_CHARACTERS);
    assert.equal(request.maxAttempts, 2);
    assert.ok(request.deadlineAt > Date.now());
    if (request.name === 'relation_candidates') {
      for (const query of request.data.queries) for (const target of query.allowedTargets) {
        const key = `${query.id}:${target}`; assert.ok(!screened.has(key)); screened.add(key);
      }
      return candidates(request);
    }
    assert.equal(request.name, 'relation_adjudication');
    assert.ok(request.data.pairs.length <= 12);
    for (const pair of request.data.pairs) { assert.ok(screened.has(`${pair.left}:${pair.right}`)); assert.ok(!judged.has(pair.id)); judged.add(pair.id); }
    for (const quote of request.data.evidence) assert.ok(material.sources.some((source) => source.location === quote.sourceLocation && source.text.includes(quote.text)));
    return decisions(request);
  } }, material, concepts, undefined, { crossMaterial: true, changedMaterialId: 'c', existingRelations: [previous], concurrency: 2 });
  assert.equal(screened.size, 50);
  assert.ok(judged.size > 0 && judged.size < screened.size);
  assert.ok(result.includes(previous));
});

test('original taxonomy evidence survives an empty shortlist and corrects direction without name-specific rules', async () => {
  const concepts = [
    { id: 'a:1', name: '머신러닝', description: '넓은 개념입니다.', sourceLocation: 'a/page:1', evidence: '머신러닝은 데이터에서 규칙을 학습합니다.' },
    { id: 'b:1', name: '딥러닝', description: '심층 신경망을 사용합니다.', sourceLocation: 'b/page:1', evidence: '딥러닝은 머신러닝의 한 분야입니다.' },
  ];
  const material = { id: 's', title: '자료', sources: concepts.map((concept) => ({ location: concept.sourceLocation, text: concept.evidence })) };
  const relations = await analyzeRelations({ async generate(request) {
    assert.equal(request.name, 'relation_candidates'); return { selected: [] };
  } }, material, concepts, undefined, { crossMaterial: true });
  assert.deepEqual(relations.map(({ source, target, type }) => ({ source, target, type })), [{ source: 'a:1', target: 'b:1', type: 'PARENT_CHILD' }]);
});

test('judgments reject unlisted endpoint pairs, absent decisions and borrowed evidence', async () => {
  const { concepts, material } = input(2);
  for (const corrupt of ['endpoint', 'missing', 'quote']) {
    let invalidSeen = false;
    const client = { async generate(request) {
      if (request.name === 'relation_candidates') return candidates(request);
      const response = decisions(request);
      invalidSeen = true;
      if (corrupt === 'endpoint') response.decisions[0].target = response.decisions[0].source;
      if (corrupt === 'missing') response.decisions = [];
      if (corrupt === 'quote') {
        const pair = request.data.pairs[0];
        const allowed = new Set(request.data.concepts.filter((node) => [pair.left, pair.right].includes(node.id)).flatMap((node) => node.evidenceIds));
        response.decisions[0].evidenceIds = [request.data.evidence.find((quote) => !allowed.has(quote.id))?.id ?? 'invented'];
      }
      return response;
    } };
    await assert.rejects(analyzeRelations(client, material, concepts, undefined, { crossMaterial: true }), (error) => error.code === 'FORMAT');
    assert.ok(invalidSeen);
  }
});

test('high-model decisions cannot reverse a taxonomy described by their own reason or introduce a prerequisite cycle', async () => {
  const { concepts, material } = input(1);
  const previous = { source: 'a:0', target: 'b:0', type: 'PREREQUISITE', reason: '기존 선수 관계입니다.' };
  for (const mode of ['cycle', 'contradiction']) {
    const result = await analyzeRelations({ async generate(request) {
      if (request.name === 'relation_candidates') return candidates(request);
      const response = decisions(request, 'NONE');
      for (const decision of response.decisions) {
        const pair = request.data.pairs.find((pair) => pair.id === decision.pairId);
        const source = request.data.concepts.find((node) => node.id === pair.right);
        const target = request.data.concepts.find((node) => node.id === pair.left);
        if (mode === 'cycle' && ![pair.left, pair.right].includes('n3')) {
          Object.assign(decision, { type: 'PREREQUISITE', source: source.id, target: target.id,
            evidenceIds: [...source.evidenceIds, ...target.evidenceIds] });
        } else if (mode === 'contradiction') {
          Object.assign(decision, { type: 'PARENT_CHILD', source: source.id, target: target.id,
            reason: `${source.name}은 ${target.name}의 한 분야입니다.`, evidenceIds: [...source.evidenceIds, ...target.evidenceIds] });
        }
      }
      return response;
    } }, material, concepts, undefined, { crossMaterial: true, existingRelations: [previous] });
    assert.deepEqual(result, [previous]);
  }
});

test('subdivision splits explicit pairs without inventing new combinations or retrying successful siblings', async () => {
  const { concepts, material } = input(2);
  const completed = new Set();
  const client = { async generate(request) {
    if (request.name === 'relation_candidates') return candidates(request);
    if (request.data.pairs.length > 1) throw new AiError('TIMEOUT', 'Split this batch');
    const pair = request.data.pairs[0];
    assert.ok(!completed.has(pair.id)); completed.add(pair.id);
    return decisions(request, 'NONE');
  } };
  const result = await analyzeRelations(client, material, concepts, undefined, { crossMaterial: true });
  assert.equal(completed.size, 12);
  assert.deepEqual(result, []);
});

test('a merged concept with an older primary location is re-screened when its new evidence changes', () => {
  const { concepts, material } = input(1);
  const merged = [{ ...concepts[0], citations: [{ sourceLocation: concepts[2].sourceLocation, evidence: concepts[2].evidence }] }, concepts[1]];
  const plan = crossMaterialRequests(material, merged, 'c');
  assert.equal(plan.pairs.length, 1);
});

test('subdivision stops at 48 high-model calls and reports incomplete work instead of expanding indefinitely', async () => {
  const { concepts, material } = input();
  let calls = 0;
  const events = [];
  await analyzeRelations({ async generate(request) {
    if (request.name === 'relation_candidates') return candidates(request);
    calls++;
    if (request.data.pairs.length > 1) throw new AiError('TIMEOUT', 'Split');
    return decisions(request, 'NONE');
  } }, material, concepts, (event) => events.push(event), { crossMaterial: true, concurrency: 2 });
  assert.equal(calls, 48);
  assert.ok(events.some((event) => event.warning && event.incomplete));
});

test('request deadlines abort in-flight network work and prevent retrying after the budget', async () => {
  let calls = 0;
  const client = createConfiguredClient({ AI_PROVIDER: 'ollama', OLLAMA_MODEL: 'test' }, { timeoutMs: 10000,
    fetcher: async (_url, options) => { calls++; return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    }); },
  });
  const started = Date.now();
  await assert.rejects(client.generate({ name: 'relation_candidates', instructions: 'Return JSON.', data: {}, schema: object({ value: text }),
    deadlineAt: Date.now() + 25, maxAttempts: 1 }), (error) => error.code === 'TIMEOUT');
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 1000);
});

test('partial relation stages are not cached as complete results', async () => {
  const cache = createAnalysisCache();
  let calls = 0;
  const produce = async () => ({ partial: ++calls === 1 });
  const shouldCache = (value) => !value.partial;
  await cache.run('key', produce, undefined, shouldCache);
  await cache.run('key', produce, undefined, shouldCache);
  await cache.run('key', produce, undefined, shouldCache);
  assert.equal(calls, 2);
});
