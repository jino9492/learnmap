import test from 'node:test';
import assert from 'node:assert/strict';
import { equivalentGroups, inferEquivalentGroups, equivalenceSignature } from '../apps/api/src/ai/concept-organization/equivalence.ts';
import { conceptProjection, explorationGroups, radialGraphLayout, prerequisiteConcepts } from '../apps/web/src/features/knowledge-graph/graph-view.ts';
import { combineSubject } from '../apps/api/src/features/workspace/index.mjs';

const concept = (id, name, description = '데이터로 패턴을 학습하는 개념입니다.') => ({ id, name, description, sourceLocation: `${id}/page:1`, evidence: description });

test('identically named contextual concepts combine across files despite different lesson coverage', () => {
  const nodes = [concept('a', '콘텐츠 생성', '새로운 콘텐츠를 만드는 방법입니다.'), concept('b', '콘텐츠 생성', '텍스트와 이미지를 생성합니다.'), concept('c', '콘텐츠 생성', '활용과 보급 과정에 관한 설명입니다.')];
  const links = [{ source: 'a', target: 'b', type: 'RELATED', reason: '같은 주제' }, { source: 'c', target: 'a', type: 'RELATED', reason: '같은 주제' }];
  const projection = conceptProjection(nodes, links, equivalentGroups(nodes, links));
  assert.equal(projection.concepts.length, 1);
  assert.equal(projection.concepts[0].members.length, 3);
  assert.equal(projection.concepts[0].details.length, 3);
  assert.equal(projection.concepts[0].citations.length, 3);
  assert.equal(projection.relations.length, 0);
  const homonyms = [concept('d', '정규화', '데이터베이스의 테이블 구조를 분리하는 방법입니다.'), concept('e', '정규화', '벡터의 길이를 조정하는 연산입니다.')];
  assert.deepEqual(equivalentGroups(homonyms, []), []);
});

test('prerequisites include incoming links to every consolidated original without inventing hierarchy prerequisites', () => {
  const nodes = [concept('a', '개념'), concept('b', '개념'), concept('p', '선수'), concept('x', '상위')];
  const links = [{ source: 'p', target: 'b', type: 'PREREQUISITE', reason: '필요 지식' }, { source: 'x', target: 'a', type: 'PARENT_CHILD', reason: '분류' }];
  const projection = conceptProjection(nodes, links, [{ memberIds: ['a', 'b'] }]);
  assert.deepEqual(prerequisiteConcepts(projection, links, 'a').map((node) => node.id), ['p']);
  assert.deepEqual(prerequisiteConcepts(projection, links, 'b').map((node) => node.id), ['p']);
  assert.deepEqual(prerequisiteConcepts(projection, links, 'missing'), []);
});

test('a 93-node mostly-related graph uses bounded communities and compact non-overlapping positions', () => {
  const concepts = Array.from({ length: 93 }, (_, index) => concept(`c${index}`, `개념 ${index}`));
  const relations = concepts.slice(1).map((node, index) => ({ source: concepts[index].id, target: node.id, type: 'RELATED', reason: '연관' }));
  const groups = explorationGroups(concepts, relations);
  assert.equal(groups.length, 10);
  assert.ok(groups.every((group) => group.memberIds.length <= 10));
  assert.equal(new Set(groups.flatMap((group) => group.memberIds)).size, 93);
  assert.deepEqual(groups, explorationGroups(concepts, relations));
  const overview = radialGraphLayout(groups.map((group) => ({ id: group.id })), []);
  const radii = [...overview.positions.values()].map((point) => Math.hypot(point.x - overview.center.x, point.y - overview.center.y));
  assert.ok(radii.every((radius) => Math.abs(radius - radii[0]) < 0.001));
  const layout = radialGraphLayout(concepts, relations);
  assert.ok(layout.width < 4000 && layout.height < 4000);
  const positions = [layout.center, ...layout.positions.values()];
  for (const [index, point] of positions.entries()) for (const other of positions.slice(index + 1)) {
    assert.ok(Math.abs(point.x - other.x) >= 182 || Math.abs(point.y - other.y) >= 76);
  }
});

test('radial branches move directed descendants outward and let related hubs shape the placement', () => {
  const nodes = ['root', 'left', 'right', 'leaf', 'other'].map((id) => concept(id, id));
  const directed = [{ source: 'root', target: 'left', type: 'PARENT_CHILD' }, { source: 'root', target: 'right', type: 'PARENT_CHILD' }, { source: 'left', target: 'leaf', type: 'PREREQUISITE' }];
  const layout = radialGraphLayout(nodes, directed);
  const radius = (id) => { const point = layout.positions.get(id); return Math.hypot(point.x - layout.center.x, point.y - layout.center.y); };
  assert.ok(radius('root') < radius('left'));
  assert.ok(radius('left') < radius('leaf'));
  const related = nodes.filter((node) => node.id !== 'root').map((node) => ({ source: 'root', target: node.id, type: 'RELATED' }));
  const hub = radialGraphLayout(nodes, related);
  assert.notDeepEqual(hub.positions, radialGraphLayout(nodes, []).positions);
  const distance = (id) => { const point = hub.positions.get(id); return Math.hypot(point.x - hub.center.x, point.y - hub.center.y); };
  assert.ok(distance('root') < distance('leaf'));
  assert.deepEqual(hub, radialGraphLayout(nodes, related));
});

test('equivalent definitions consolidate display only while retaining every source, original ID and relation meaning', () => {
  const concepts = [concept('a', '딥러닝'), concept('b', '딥러닝의 정의'), concept('c', '역전파', '오차를 전달하는 방법입니다.')];
  const relations = [{ source: 'a', target: 'c', type: 'RELATED', reason: '관계' }, { source: 'b', target: 'c', type: 'RELATED', reason: '관계' }];
  const original = structuredClone({ concepts, relations });
  const groups = equivalentGroups(concepts, relations);
  const projected = conceptProjection(concepts, relations, groups);
  assert.equal(projected.concepts.length, 2);
  assert.equal(projected.relations.length, 1);
  assert.equal(projected.concepts[0].members.length, 2);
  assert.equal(projected.concepts[0].citations.length, 2);
  assert.equal(projected.canonicalIds.get('a'), projected.canonicalIds.get('b'));
  assert.deepEqual({ concepts, relations }, original);
});

test('display equivalence cannot collapse a taxonomy or an indirect learning dependency', () => {
  const concepts = [concept('a', '학습'), concept('b', '학습의 정의'), concept('c', '중간 단계')];
  const relations = [{ source: 'a', target: 'c', type: 'PREREQUISITE', reason: '선수' }, { source: 'c', target: 'b', type: 'PREREQUISITE', reason: '선수' }];
  assert.deepEqual(equivalentGroups(concepts, relations, [{ memberIds: ['a', 'b'], reason: '모델의 제안' }]), []);
});

test('global equivalence review reaches duplicates across batches and rejects missing or invented decisions', async () => {
  const concepts = [concept('a', '딥러닝'), ...Array.from({ length: 20 }, (_, index) => concept(`x${index}`, `독립 개념 ${index}`, `별도 목적 ${index}`)), concept('b', '딥러닝의 정의')];
  let seen = false;
  const result = await inferEquivalentGroups({ async generate(request) {
    assert.equal(request.name, 'concept_equivalence');
    assert.match(request.instructions, /same underlying concept identity/i);
    const ids = new Map(request.data.concepts.map((node) => [node.id, node.name]));
    return { decisions: request.data.pairs.map((pair) => {
      const same = [ids.get(pair.left), ids.get(pair.right)].every((name) => name.startsWith('딥러닝'));
      if (same) seen = true;
      return { pairId: pair.id, verdict: same ? 'EQUIVALENT' : 'DISTINCT', reason: same ? '같은 정의입니다.' : '별개의 평가 범위입니다.' };
    }) };
  } }, concepts, []);
  assert.ok(seen);
  assert.ok(result.some((group) => group.memberIds.includes('a') && group.memberIds.includes('b')));
  await assert.rejects(inferEquivalentGroups({ async generate() { return { decisions: [] }; } }, concepts, []), (error) => error.code === 'FORMAT');
});

test('stale equivalence decisions are ignored and learner records remain untouched', () => {
  const subject = { id: 's', name: '과목', questions: new Map([['q', { conceptId: 'j:b' }]]), progress: new Map([['j:b', { conceptId: 'j:b', scores: [80] }]]), history: [{ conceptId: 'j:b', answer: '답안' }] };
  const concepts = [concept('a', '가상 주소'), concept('b', '주소 표현')].map((node) => ({ ...node, sourceLocation: 'page:1' }));
  const jobs = new Map([['j', { id: 'j', subjectId: 's', filename: 'notes', status: 'ready', concepts, relations: [], material: { sources: [{ location: 'page:1', text: concepts[0].evidence }] } }]]);
  const initial = combineSubject(subject, jobs);
  subject.conceptEquivalences = { signature: equivalenceSignature(initial.concepts, initial.relations), groups: [{ memberIds: ['j:a', 'j:b'], reason: '확인된 동의어' }] };
  assert.equal(combineSubject(subject, jobs).equivalences.length, 1);
  const saved = structuredClone({ questions: subject.questions, progress: subject.progress, history: subject.history });
  concepts[1].description = '자료의 의미가 변경되었습니다.';
  assert.equal(combineSubject(subject, jobs).equivalences.length, 0);
  assert.deepEqual({ questions: subject.questions, progress: subject.progress, history: subject.history }, saved);
});
