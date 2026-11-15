import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createDemoServer } from '../apps/api/src/demo-server.mjs';
import { analyzeRelations, generateQuestion, AiError } from '../apps/api/src/ai/index.ts';

test('on-demand publishing eliminates upfront lesson requests and preserves the graph on failed expansion', async () => {
  for (const mode of ['on-demand', 'eager']) {
    const calls = [];
    let fail = false;
    const server = createDemoServer({ env: { AI_DETAIL_MODE: mode }, clientFactory: () => ({ async generate(request) {
      calls.push(request.name);
      if (request.name === 'concept_extraction') {
        const source = request.data.sources[0];
        return { concepts: [1, 2, 3].map((number) => ({ id: `c${number}`, name: `학습 개념 ${number}`,
          description: '페이징은 가상 주소 공간을 고정된 크기의 페이지로 나누는 방식입니다.',
          sourceLocation: source.location, evidence: source.excerpts[0].id })) };
      }
      if (request.name === 'relation_analysis') return { relations: [] };
      assert.equal(request.name, 'concept_detail_expansion');
      if (fail) throw new AiError('PROVIDER', 'Unavailable');
      return { description: '페이지 테이블은 가상 페이지 번호와 물리 프레임 번호의 대응을 저장하는 자료 구조입니다.' };
    } }) });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (path, body) => {
      const response = await fetch(base + path, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) });
      assert.equal(response.status, body === undefined || path !== '/api/subjects' ? 200 : 201);
      return response.json();
    };
    try {
      const subject = await api('/api/subjects', { name: '운영체제' });
      const uploaded = await fetch(`${base}/api/analyses?filename=notes.txt&subjectId=${subject.id}`, {
        method: 'POST', body: '페이징은 가상 주소 공간을 고정 크기 페이지로 나눕니다. 페이지 테이블은 주소 변환에 사용됩니다.',
      });
      assert.equal(uploaded.status, 202);
      const { id } = await uploaded.json();
      let state;
      for (let attempt = 0; attempt < 100; attempt++) {
        state = await api(`/api/analyses/${id}`);
        if (['ready', 'failed'].includes(state.status)) break;
        await delay(10);
      }
      assert.equal(state.status, 'ready');
      assert.equal(state.graph.concepts.length, 3);
      const lessonCalls = () => calls.filter((name) => name === 'concept_detail_expansion').length;
      assert.equal(lessonCalls(), mode === 'eager' ? 3 : 0);
      assert.ok(state.graph.concepts.every((concept) => concept.detailsState === (mode === 'eager' ? 'ready' : 'pending')));
      if (mode === 'eager') continue;
      const path = `/api/analyses/${subject.id}/details`;
      const before = await api(`/api/subjects/${subject.id}`);
      const conceptId = before.graph.concepts[0].id;
      const expanded = await api(path, { conceptId });
      assert.equal(expanded.concept.detailsState, 'ready');
      assert.equal(lessonCalls(), 1);
      const after = await api(`/api/subjects/${subject.id}`);
      assert.equal(after.graph.concepts[0].detailsState, 'ready');
      assert.ok(after.graph.concepts.slice(1).every((concept) => concept.detailsState === 'pending'));
      assert.deepEqual(after.graph.relations, before.graph.relations);
      fail = true;
      const failed = await fetch(base + path, { method: 'POST', body: JSON.stringify({ conceptId }) });
      assert.equal(failed.status, 502);
      assert.deepEqual((await api(`/api/subjects/${subject.id}`)).graph, after.graph);
    } finally {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    }
  }
});

test('incremental relations preserve unchanged edges without skipping any pair involving the new material', async () => {
  const concepts = ['a', 'b', 'c'].flatMap((origin) => Array.from({ length: 5 }, (_, index) => ({
    id: `${origin}:${index}`, name: `개념 ${origin}${index}`, description: '학습 개념의 정의입니다.',
    sourceLocation: `${origin}/page:${index + 1}`, evidence: `원문 ${origin}${index}`,
  })));
  const material = { id: 's', title: '통합 자료', sources: concepts.map((concept) => ({ location: concept.sourceLocation, text: concept.evidence })) };
  const existing = { source: 'a:0', target: 'b:0', type: 'RELATED', reason: '기존 관계입니다.' };
  const windows = [];
  const client = { async generate(request) {
    assert.equal(request.name, 'relation_candidates');
    windows.push(...request.data.queries.flatMap((query) => query.allowedTargets.map((target) => [query.id, target])));
    return { selected: [] };
  } };
  const result = await analyzeRelations(client, material, concepts, undefined,
    { crossMaterial: true, changedMaterialId: 'c', existingRelations: [existing] });
  assert.deepEqual(result, [existing]);
  assert.equal(windows.length, 50);
  const aliases = new Map(concepts.map((concept, index) => [concept.id, `n${index + 1}`]));
  for (const left of concepts.filter((concept) => concept.id.startsWith('c:'))) {
    for (const right of concepts.filter((concept) => !concept.id.startsWith('c:'))) {
      assert.ok(windows.some((window) => window.includes(aliases.get(left.id)) && window.includes(aliases.get(right.id))));
    }
  }
  assert.ok(windows.every((window) => window.some((id) => Number(id.slice(1)) > 10)));
});

test('persistent question-quality failures stop after three candidates instead of hanging', async () => {
  const concept = { id: 'c1', name: '페이징', description: '주소 공간을 페이지로 나누는 방식입니다.', sourceLocation: 'page:1', evidence: '페이징은 주소 공간을 페이지로 나눕니다.' };
  const material = { id: 'm1', title: '자료', sources: [{ location: concept.sourceLocation, text: concept.evidence }] };
  let calls = 0;
  await assert.rejects(generateQuestion({ async generate() {
    calls++;
    throw new AiError('SEMANTIC', 'Invalid question');
  } }, concept, material), (error) => error.code === 'SEMANTIC');
  assert.equal(calls, 3);
});
