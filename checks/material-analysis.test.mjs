import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { extractPdfPages } from '../apps/api/src/features/materials/pdf.mjs';
import { organizeConcepts } from '../apps/api/src/ai/concept-organization/index.ts';
import { analyzeRelations } from '../apps/api/src/ai/relation-analysis/index.ts';
import { crossMaterialWindows } from '../apps/api/src/features/material-analysis/index.ts';

function imagePdf() {
  const stream = 'q 500 0 0 600 40 40 cm /Im Do Q\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 8 >>\nstream\nffffff>\nendstream',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return new Uint8Array(Buffer.from(`${pdf}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
}

test('image-based PDF pages are rendered for OCR; temporary images are removed afterwards', async () => {
  let imagePath;
  const pages = await extractPdfPages(imagePdf(), { async recognizeImages(paths) {
    [imagePath] = paths;
    assert.ok((await readFile(imagePath)).length > 0);
    return ['신경망은 학습을 통해 연결의 가중치를 조정하는 모델입니다.'];
  } });
  assert.match(pages[0], /신경망/);
  await assert.rejects(access(imagePath));
});

test('insufficient OCR output is rejected instead of being analyzed as a complete document', async () => {
  await assert.rejects(extractPdfPages(imagePdf(), { recognizeImages: async () => ['•'] }), (error) => error.code === 'OCR_REQUIRED');
});

const material = { id: 'lecture', title: '인공지능', sources: [
  { location: 'a/page:1', text: '신경망은 연결의 가중치를 통해 입력을 출력으로 변환합니다.' },
  { location: 'b/page:1', text: '역전파는 출력 오차를 전달해 신경망의 가중치를 갱신합니다.' },
  { location: 'c/page:1', text: '필터 버블은 개인화된 추천으로 접하는 정보가 제한되는 현상입니다.' },
] };
const concepts = material.sources.map((source, index) => ({ id: `c${index}`, name: ['신경망', '역전파', '필터 버블'][index],
  description: source.text, evidence: source.text, sourceLocation: source.location }));

test('incomplete organization cannot discard independent learning concepts', async () => {
  const result = await organizeConcepts({ async generate() { return { groups: [
    { name: '신경망', description: concepts[0].description, memberIds: ['c0'] },
  ] }; } }, material, concepts);
  assert.equal(result.length, 3);
  assert.deepEqual(result.flatMap((concept) => concept.memberConceptIds), ['c0', 'c1', 'c2']);
});

test('repeated overlapping groups retain originals with a warning after one correction attempt', async () => {
  let calls = 0;
  const progress = [];
  const result = await organizeConcepts({ async generate(request) {
    if (++calls === 2) assert.deepEqual(request.data.correction.duplicateMemberIds, ['c0']);
    return { groups: [
    { name: '신경망', description: '신경망', memberIds: ['c0'] },
    { name: '학습', description: '학습', memberIds: ['c0', 'c1'] },
  ] }; } }, material, concepts, (event) => progress.push(event));
  assert.equal(calls, 2);
  assert.equal(result.length, concepts.length);
  assert.deepEqual(result.flatMap((concept) => concept.memberConceptIds), concepts.map((concept) => concept.id));
  assert.deepEqual(result.map((concept) => concept.evidence), concepts.map((concept) => concept.evidence));
  assert.equal(progress.filter((event) => event.warning).length, 1);
});

test('a corrected grouping replaces an overlapping response without duplicate memberships', async () => {
  let calls = 0;
  const result = await organizeConcepts({ async generate() {
    return { groups: ++calls === 1 ? [
      { name: '잘못된 묶음', description: '중복', memberIds: ['c0', 'c0'] },
    ] : [
      { name: '신경망 학습', description: '가중치 갱신', memberIds: ['c0', 'c1'] },
      { name: '필터 버블', description: '정보 편향', memberIds: ['c2'] },
    ] };
  } }, material, concepts);
  assert.equal(calls, 2);
  assert.equal(result.length, 2);
  assert.equal(new Set(result.flatMap((concept) => concept.memberConceptIds)).size, concepts.length);
});

test('unknown IDs in a correction remain rejected by the grounding schema', async () => {
  let calls = 0;
  await assert.rejects(organizeConcepts({ async generate() {
    return { groups: [{ name: '묶음', description: '설명', memberIds: ++calls === 1 ? ['c0', 'c0'] : ['invented'] }] };
  } }, material, concepts), (error) => error.code === 'FORMAT');
  assert.equal(calls, 2);
});

test('cross-file windows include every concept pair, even beyond adjacent windows', () => {
  const nodes = ['a', 'b', 'c'].flatMap((origin) => Array.from({ length: 13 }, (_, i) => ({ id: `${origin}:${i}`, sourceLocation: `${origin}/page:1` })));
  const windows = crossMaterialWindows(nodes);
  assert.ok(windows.every((window) => window.length <= 8));
  for (const left of nodes) for (const right of nodes) {
    if (left.sourceLocation !== right.sourceLocation) assert.ok(windows.some((window) => window.includes(left) && window.includes(right)));
  }
});

test('cross-file candidates cannot introduce prerequisite cycles through existing local edges', async () => {
  const existing = [{ source: 'c0', target: 'c1', type: 'PREREQUISITE', reason: '가중치를 이해해야 갱신을 학습할 수 있습니다.' }];
  const result = await analyzeRelations({ async generate(request) {
    const ids = request.data.concepts.map((concept) => concept.id);
    return { relations: ids.includes('c0') && ids.includes('c1') ? [{ ...existing[0], source: 'c1', target: 'c0' }] : [] };
  } }, material, concepts, undefined, { crossMaterial: true, existingRelations: existing });
  assert.deepEqual(result, existing);
});
