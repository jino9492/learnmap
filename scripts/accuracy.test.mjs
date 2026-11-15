import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRelations } from '../apps/api/src/ai/relation-analysis/index.ts';
import { reviewRelations } from '../apps/api/src/ai/relation-analysis/review.ts';
import { relationEvidence } from '../apps/api/src/ai/relation-analysis/evidence.ts';
import { explicitHierarchyDirection } from '../apps/api/src/ai/relation-analysis/direction.ts';
import { expandConceptDetails } from '../apps/api/src/ai/concept-extraction/details.ts';
import { validateConceptExplanation } from '../apps/api/src/ai/concept-extraction/quality.ts';
import { validateGraph } from '../apps/api/src/features/knowledge-graph/index.ts';
import { combineSubject } from '../apps/api/src/features/workspace/index.mjs';
import { requestCharacters, REQUEST_CHARACTERS } from '../apps/api/src/ai/core/partition.ts';
import { AiError } from '../apps/api/src/ai/core/errors.ts';

const source = '머신러닝은 데이터에서 패턴을 학습하는 인공지능의 한 분야입니다. 딥러닝은 심층 신경망을 사용하는 머신러닝의 한 분야입니다.';
const material = { id: 'lecture02', title: '인공지능', sources: [{ location: 'page:16', text: source }] };
const concepts = [
  { id: 'ml', name: '머신러닝', description: '데이터에서 패턴을 학습하는 방법입니다.', sourceLocation: 'page:16', evidence: source },
  { id: 'dl', name: '딥러닝', description: '심층 신경망을 사용하는 머신러닝의 한 분야입니다.', sourceLocation: 'page:16', evidence: source },
];
const inverse = { source: 'dl', target: 'ml', type: 'PARENT_CHILD', reason: '딥러닝은 머신러닝의 한 형태이다.' };
const reviewSource = '머신러닝은 데이터에서 패턴을 학습합니다. 딥러닝은 심층 신경망을 사용합니다.';
const reviewMaterial = { ...material, sources: [{ location: 'page:16', text: reviewSource }] };
const reviewConcepts = concepts.map((concept) => ({ ...concept, evidence: reviewSource }));
const decision = (request, verdict = 'SUPPORTED') => ({ decisions: request.data.candidates.map((candidate) => ({
  candidateId: candidate.id, verdict, evidenceIds: [request.data.evidence[0].id], reason: '원문은 딥러닝이 머신러닝의 한 분야라고 정의합니다.',
  ...(candidate.type === 'PARENT_CHILD' ? { broaderConceptId: candidate.conceptIds[0], narrowerConceptId: candidate.conceptIds[1] }
    : { prerequisiteConceptId: candidate.conceptIds[0], dependentConceptId: candidate.conceptIds[1] }),
})) });

test('explicit subtype statements determine direction without hardcoded concept names', () => {
  const nodes = concepts.map((concept, index) => ({ ...concept, name: index ? '특수 개념' : '일반 개념' }));
  for (const statement of ['특수 개념은 일반 개념의 한 종류입니다.', '특수 개념은 일반 개념의 한 종류가 아닙니다.',
    '특수 개념과 일반 개념을 함께 학습합니다.', '특수 개념은 일반 개념의 한 종류라는 설명은 잘못된 주장입니다.']) {
    const input = { ...material, sources: [{ location: 'page:16', text: statement }] };
    const grounded = nodes.map((node) => ({ ...node, evidence: statement }));
    assert.deepEqual(explicitHierarchyDirection(input, ...grounded), statement.endsWith('종류입니다.') ? { source: 'ml', target: 'dl' } : undefined);
  }
  const ungrounded = concepts.map((concept) => ({ ...concept, evidence: reviewSource }));
  assert.equal(explicitHierarchyDirection(reviewMaterial, ...ungrounded), undefined, 'Generated summaries cannot establish direction');
});

test('role-based model review can reverse a pair and cannot introduce a third endpoint', async () => {
  const output = await reviewRelations({ async generate(request) {
    const response = decision(request);
    return { decisions: response.decisions.map((entry) => ({ ...entry, broaderConceptId: 'ml', narrowerConceptId: 'dl' })) };
  } }, reviewMaterial, reviewConcepts, [inverse]);
  assert.equal(output[0].source, 'ml');
  assert.equal(output[0].target, 'dl');
  const third = { ...reviewConcepts[0], id: 'third' };
  await assert.rejects(reviewRelations({ async generate(request) {
    return { decisions: decision(request).decisions.map((entry) => ({ ...entry, broaderConceptId: 'third' })) };
  } }, reviewMaterial, [...reviewConcepts, third], [inverse]), { code: 'FORMAT' });
});

test('a review reason cannot approve the inverse of its own explicit taxonomy statement', async () => {
  const result = await reviewRelations({ async generate(request) {
    return decision(request);
  } }, reviewMaterial, reviewConcepts, [inverse]);
  assert.deepEqual(result, []);
});

test('reversed hierarchy is corrected by grounded review and unsupported prerequisites are removed', async () => {
  const events = [];
  const related = { ...inverse, type: 'RELATED' };
  const result = await analyzeRelations({ async generate(request) {
    if (request.name === 'relation_analysis') return { relations: [inverse, { ...inverse, type: 'PREREQUISITE' }, related] };
    assert.equal(request.name, 'relation_review');
    assert.deepEqual(request.data.evidence.map((entry) => entry.text), [source]);
    assert.ok(request.data.concepts.every((entry) => !Object.hasOwn(entry, 'description')));
    assert.match(request.instructions, /KIND OF source/);
    return decision(request, 'REJECT');
  } }, material, concepts, (event) => events.push(event));
  assert.deepEqual(result.map(({ source, target, type }) => ({ source, target, type })), [
    { source: 'ml', target: 'dl', type: 'PARENT_CHILD' }, related,
  ].map(({ source, target, type }) => ({ source, target, type })));
  assert.ok(events.some((event) => event.detail?.includes('관계 검증에서 제외')));
});

test('semantic review fails closed on missing decisions, foreign IDs and invented evidence', async () => {
  for (const change of [
    (response) => ({ decisions: [] }),
    (response) => ({ decisions: [{ ...response.decisions[0], candidateId: 'invented' }] }),
    (response) => ({ decisions: [{ ...response.decisions[0], evidenceIds: ['invented'] }] }),
  ]) {
    await assert.rejects(reviewRelations({ async generate(request) { return change(decision(request)); } }, reviewMaterial, reviewConcepts, [inverse]), { code: 'FORMAT' });
  }
  const withoutEvidence = await reviewRelations({ async generate(request) {
    return { decisions: decision(request).decisions.map((entry) => ({ ...entry, evidenceIds: [] })) };
  } }, reviewMaterial, reviewConcepts, [inverse]);
  assert.deepEqual(withoutEvidence, []);
  await assert.rejects(reviewRelations({ async generate() { throw new AiError('CONNECTION', 'offline'); } }, reviewMaterial, reviewConcepts, [inverse]), { code: 'CONNECTION' });
});

test('review rejects duplicate candidate decisions and cannot substitute another pair’s evidence', async () => {
  const extra = { ...concepts[0], id: 'third', name: '다른 개념', sourceLocation: 'page:17', evidence: '다른 원문 근거입니다.' };
  const input = { ...reviewMaterial, sources: [...reviewMaterial.sources, { location: extra.sourceLocation, text: extra.evidence }] };
  const edges = [inverse, { ...inverse, source: 'third' }];
  for (const wrong of ['duplicate', 'foreign-evidence']) {
    await assert.rejects(reviewRelations({ async generate(request) {
      const response = decision(request);
      if (wrong === 'duplicate') {
        if (response.decisions.length > 1) response.decisions[1].candidateId = response.decisions[0].candidateId;
        else response.decisions.push(response.decisions[0]);
      }
      else if (request.data.candidates.some((candidate) => candidate.id === 'r1')) {
        const other = request.data.evidence.find((entry) => entry.text === extra.evidence);
        response.decisions[0].evidenceIds = [other?.id ?? 'invented'];
      }
      return response;
    } }, input, [...reviewConcepts, extra], edges), { code: 'FORMAT' });
  }
});

test('mixed-up batch review evidence is retried in isolated pairs without accepting the invalid review', async () => {
  const nodes = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id, description: `${id} 설명`, sourceLocation: id, evidence: `${id} 원문 근거` }));
  const input = { id: 'separate', title: '근거 분리', sources: nodes.map((node) => ({ location: node.sourceLocation, text: node.evidence })) };
  const edges = [
    { source: 'a', target: 'b', type: 'PREREQUISITE', reason: '초기 후보' },
    { source: 'c', target: 'd', type: 'PREREQUISITE', reason: '초기 후보' },
  ];
  const sizes = [];
  const output = await reviewRelations({ async generate(request) {
    sizes.push(request.data.candidates.length);
    return { decisions: request.data.candidates.map((candidate, index) => {
      const allowed = request.data.concepts.filter((node) => candidate.conceptIds.includes(node.id)).flatMap((node) => node.evidenceIds);
      assert.deepEqual(candidate.allowedEvidenceIds, [...new Set(allowed)]);
      return {
        candidateId: candidate.id, verdict: 'SUPPORTED',
        evidenceIds: request.data.candidates.length > 1 ? request.data.candidates[1 - index].allowedEvidenceIds : candidate.allowedEvidenceIds,
        prerequisiteConceptId: candidate.conceptIds[0], dependentConceptId: candidate.conceptIds[1],
        reason: request.data.candidates.length > 1 ? '잘못 섞인 검토' : '분리 검토에서 확인한 관계',
      };
    }) };
  } }, input, nodes, edges);
  assert.deepEqual(sizes, [2, 1, 1]);
  assert.deepEqual(output, edges.map((edge) => ({ ...edge, reason: '분리 검토에서 확인한 관계' })));
});

test('hierarchy cycles are rejected independently of prerequisite cycles, including after reversal', async () => {
  const third = { ...concepts[0], id: 'third' };
  const nodes = [...concepts, third];
  for (const type of ['PARENT_CHILD', 'PREREQUISITE']) {
    const edges = [['ml', 'dl'], ['dl', 'third'], ['third', 'ml']].map(([source, target]) => ({ source, target, type, reason: 'test' }));
    assert.throws(() => validateGraph({ concepts: nodes, relations: edges }), { code: 'SEMANTIC' });
  }
  const edges = [inverse, { ...inverse, source: 'ml', target: 'dl' }];
  const reviewed = await analyzeRelations({ async generate(request) {
    return request.name === 'relation_analysis' ? { relations: edges } : decision(request);
  } }, material, concepts);
  assert.equal(reviewed.length, 1);
  validateGraph({ concepts, relations: reviewed });
});

test('merging materials cannot introduce a hierarchy cycle through equivalent concepts', () => {
  const job = (id, relation) => [id, { id, subjectId: 's', status: 'ready', material, concepts, relations: [relation] }];
  const result = combineSubject({ id: 's' }, new Map([job('a', inverse), job('b', { ...inverse, source: 'ml', target: 'dl' })]));
  assert.equal(result.relations.length, 1);
  validateGraph(result);
});

test('relation retrieval includes additional definition evidence and keeps review requests bounded', async () => {
  const noise = '부가 자료입니다. '.repeat(2000);
  const input = { ...material, sources: [...material.sources, { location: 'page:1', text: noise }] };
  const node = { ...concepts[0], sourceLocation: 'page:1', evidence: noise, citations: [{ sourceLocation: 'page:16', evidence: source }] };
  assert.ok(relationEvidence(node, input).some((citation) => citation.evidence === source));
  const nodes = Array.from({ length: 12 }, (_, index) => ({ ...node, id: `n${index}` }));
  const edges = nodes.slice(1).map((target) => ({ ...inverse, source: 'n0', target: target.id }));
  await reviewRelations({ async generate(request) {
    assert.ok(requestCharacters(request) <= REQUEST_CHARACTERS);
    return decision(request);
  } }, input, nodes, edges);
});

test('detail generation rewrites lesson announcements instead of accepting an overview as instruction', async () => {
  let calls = 0;
  const before = structuredClone(concepts);
  const output = await expandConceptDetails({ async generate(request) {
    calls++;
    if (calls === 1) return { description: '이 단원에서는 딥러닝의 정의, 특성, 그리고 그 중요성을 살펴보고, 심층 신경망의 기본적인 작동 방식과 그 응용을 배우겠습니다.' };
    assert.match(request.data.correction, /actual definition/);
    return { description: concepts[1].description };
  } }, [concepts[1]], material);
  assert.equal(calls, 2);
  assert.equal(output[0].details[0].description, concepts[1].description);
  assert.equal(output[0].details[0].evidence, source);
  assert.deepEqual(concepts, before);
});

test('quality retries stop at three and leave existing lessons untouched on failure', async () => {
  let calls = 0;
  const nodes = [{ ...concepts[1], details: [{ ...concepts[1] }] }];
  const before = structuredClone(nodes);
  await assert.rejects(expandConceptDetails({ async generate() {
    calls++;
    return { description: '이 레슨은 딥러닝의 정의를 설명합니다.' };
  } }, nodes, material), { code: 'SEMANTIC' });
  assert.equal(calls, 3);
  assert.deepEqual(nodes, before);
});

test('quality validation permits compact definitions and code but rejects placeholders and repetition', () => {
  for (const invalid of ['짧은 요약', '새로운 설명입니다.', '이 레슨은 머신러닝이란 무엇이며, 어떻게 작동하는지 설명합니다.',
    '페이징은 페이지로 나누는 방식입니다.\n\n페이징은 페이지로 나누는 방식입니다.',
    'We will learn about deep learning.']) assert.throws(() => validateConceptExplanation(invalid), { code: 'SEMANTIC' });
  for (const valid of [concepts[1].description, '조건문은 조건에 따라 실행할 분기를 선택합니다.\n\n```js\nconsole.log("살펴보겠습니다");\n```',
    '입력은 결과를 계산하는 데 사용되는 값입니다.\n\n> 이 단원에서는 입력을 살펴보겠습니다.']) assert.equal(validateConceptExplanation(valid), valid);
});
