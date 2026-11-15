import test from 'node:test';
import assert from 'node:assert/strict';
import { representativeConceptGroups, collapseConceptFacets } from '../apps/api/src/features/knowledge-graph/core-groups.ts';
import { conceptProjection } from '../apps/web/src/features/knowledge-graph/graph-view.ts';
import { organizeConcepts } from '../apps/api/src/ai/concept-organization/index.ts';
import { combineSubject } from '../apps/api/src/features/workspace/index.mjs';

const node = (id, name) => ({ id, name, description: `${name}에 대한 근거 있는 설명입니다.`, sourceLocation: `page:${id}`, evidence: `${name} 원문입니다.` });
const facets = ['전문가 시스템의 지식베이스와 추론', '전문가 시스템의 산업 적용', '전문가 시스템의 규칙 유지보수와 충돌', '전문가 시스템의 지식 획득 병목'].map((name, index) => node(`e${index}`, name));

test('core abstraction collects a named system’s facets but preserves subtypes and historical transitions', () => {
  const other = [node('t', '지식 기반에서 데이터 기반으로의 전환'), node('h', '전문가 시스템 시대의 국가·산업 경쟁'), node('s', '머신러닝의 지도 학습'), node('u', '머신러닝의 비지도 학습')];
  const input = [...facets, ...other];
  const original = structuredClone(input);
  const groups = representativeConceptGroups(input);
  assert.deepEqual(groups.map((group) => [group.name, group.memberIds]), [['전문가 시스템', facets.map((item) => item.id)]]);
  const projection = conceptProjection(input, [], [], groups);
  const expert = projection.concepts.find((item) => item.name === '전문가 시스템');
  assert.equal(expert.members.length, 4);
  assert.equal(expert.details.length, 4);
  assert.equal(expert.citations.length, 4);
  assert.ok(other.every((item) => projection.concepts.some((projected) => projected.id === item.id)));
  assert.deepEqual(input, original);
  assert.deepEqual(representativeConceptGroups([node('f1', '함수의 정의역'), node('f2', '함수의 정의')]), []);
  assert.deepEqual(representativeConceptGroups([node('m1', '방법의 구성'), node('m2', '방법의 한계와 다른 방법의 비교')]), []);
});

test('a prerequisite path between facets prevents abstraction while parent-child composition is allowed', () => {
  const path = [{ source: 'e0', target: 'between', type: 'PREREQUISITE' }, { source: 'between', target: 'e3', type: 'PREREQUISITE' }];
  assert.deepEqual(representativeConceptGroups(facets, path), []);
  assert.equal(representativeConceptGroups(facets, [{ source: 'e0', target: 'e3', type: 'PARENT_CHILD' }]).length, 1);
});

test('global facet reconciliation crosses model batches without extra requests or losing any original learning item', async () => {
  const input = [facets[0], ...Array.from({ length: 16 }, (_, index) => node(`x${index}`, `별개 주제 ${index}`)), ...facets.slice(1)];
  const material = { id: 'm', title: '강의', sources: input.map((item) => ({ location: item.sourceLocation, text: item.evidence })) };
  let calls = 0;
  const result = await organizeConcepts({ async generate(request) {
    calls++;
    assert.match(request.instructions, /Being separately assessable is NOT sufficient/);
    return { groups: request.data.concepts.map((item) => ({ name: item.name, description: item.description, memberIds: [item.id] })) };
  } }, material, input);
  assert.equal(calls, 2);
  const expert = result.find((item) => item.name === '전문가 시스템');
  assert.equal(expert.details.length, 4);
  assert.equal(expert.citations.length, 4);
  assert.deepEqual(new Set(expert.memberConceptIds), new Set(facets.map((item) => item.id)));
  assert.equal(result.length, 17);
});

test('existing maps abstract only conceptual-mode items and keep original IDs and learner records', () => {
  const subject = { id: 's', name: '과목', progress: new Map([['a:e3', { score: 90 }]]), questions: new Map([['q', { conceptId: 'a:e3' }]]), history: [{ conceptId: 'a:e3', answer: '답' }] };
  const job = { id: 'a', subjectId: 's', mode: 'conceptual', status: 'ready', concepts: facets, relations: [], material: { sources: facets.map((item) => ({ location: item.sourceLocation, text: item.evidence })) } };
  const before = structuredClone({ subject, job });
  const combined = combineSubject(subject, new Map([['a', job]]));
  assert.equal(combined.coreGroups[0].name, '전문가 시스템');
  assert.equal(combined.concepts.length, 4);
  assert.deepEqual({ subject, job }, before);
  const detailed = combineSubject(subject, new Map([['a', { ...job, mode: 'detailed' }]]));
  assert.deepEqual(detailed.coreGroups, []);
});

test('equivalent aliases and core facets project together without losing alias-only sources or original links', () => {
  const alias = node('alias', facets[0].name);
  const input = [...facets, alias];
  const projection = conceptProjection(input, [], [{ memberIds: ['e0', 'alias'] }], representativeConceptGroups(input));
  assert.equal(projection.concepts.length, 1);
  assert.equal(projection.concepts[0].name, '전문가 시스템');
  assert.equal(projection.concepts[0].members.length, 5);
  assert.equal(new Set([...projection.canonicalIds.values()]).size, 1);
  const collapsed = collapseConceptFacets(facets);
  assert.equal(collapsed[0].details.length, 4);
});
