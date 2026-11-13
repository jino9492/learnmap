import test from 'node:test';
import assert from 'node:assert/strict';
import { apiErrorMessage, createApiClient } from '../apps/demo/api.js';

test('organization validation errors identify the failed stage without blaming connectivity', () => {
  const message = apiErrorMessage({ code: 'SEMANTIC', stage: 'organization', message: 'A detailed concept cannot belong to multiple core concepts.' });
  assert.match(message, /핵심 개념 정리 단계/);
  assert.match(message, /검증에 실패/);
  assert.doesNotMatch(message, /서버 연결과 AI 설정/);
});

test('format, timeout, connectivity and OCR failures remain distinguishable', () => {
  assert.match(apiErrorMessage({ code: 'FORMAT', stage: 'concepts' }), /개념 추출 단계: AI 응답이 필요한 형식/);
  assert.match(apiErrorMessage({ code: 'TIMEOUT', stage: 'subject_relations' }), /파일 간 관계 분석 단계: AI 응답이 지연/);
  assert.match(apiErrorMessage({ code: 'CONNECTION' }), /AI 모델 서버의 응답/);
  assert.match(apiErrorMessage({ code: 'DEMO_CONNECTION' }), /서버에 연결/);
  assert.equal(apiErrorMessage({ code: 'OCR_REQUIRED', stage: 'text', message: '한국어 OCR을 확인해 주세요.' }), '본문 인식 단계: 한국어 OCR을 확인해 주세요.');
});

test('path validation failures ask to regenerate the path instead of reanalyzing materials', async () => {
  for (const code of ['SEMANTIC', 'FORMAT']) {
    const request = createApiClient(async () => ({ ok: false, status: 502, async json() { return { error: { code, message: 'Invalid path' } }; } }));
    await assert.rejects(request('/api/analyses/subject-id/path'), (error) => {
      const message = apiErrorMessage(error);
      assert.equal(error.stage, 'path');
      assert.match(message, /추천 학습 경로 생성을 다시 시도/);
      assert.doesNotMatch(message, /다시 분석/);
      return true;
    });
  }
});
