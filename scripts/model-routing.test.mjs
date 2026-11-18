import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfiguredClient } from '../apps/api/src/ai/core/config.ts';
import { object, text } from '../apps/api/src/ai/core/schema.ts';
import { analysisCacheScope } from '../apps/api/src/features/material-analysis/cache.mjs';
import { UsageRequestQueue } from '../apps/api/src/ai/core/queue.ts';

const schema = object({ value: text });
const reasoningTasks = ['relation_analysis', 'relation_review', 'relation_adjudication'];
const fastTasks = ['concept_extraction', 'concept_detail_expansion', 'concept_organization',
  'question_generation', 'choice_question_review', 'answer_evaluation', 'evaluation_diagnosis',
  'evaluation_feedback', 'path_recommendation', 'korean_localization', 'evidence_digest', 'relation_candidates'];

for (const provider of ['openai', 'gemini', 'ollama']) {
  const prefix = provider.toUpperCase();
  const envelope = () => provider === 'openai'
    ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"value":"ok"}' }] }] }
    : provider === 'gemini'
      ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"value":"ok"}' }] } }] }
      : { done: true, done_reason: 'stop', message: { role: 'assistant', content: '{"value":"ok"}' } };

  test(`${provider}: only relationship analysis and review use the reasoning model`, async () => {
    const calls = [];
    const env = { AI_PROVIDER: provider, [`${prefix}_MODEL`]: 'reasoning-model',
      [`${prefix}_FAST_MODEL`]: 'fast-model', [`${prefix}_API_KEY`]: 'test-key' };
    const client = createConfiguredClient(env, { scheduler: new UsageRequestQueue({ tokens: 10000000, requests: 1000 }), fetcher: async (url, options) => {
      const body = JSON.parse(options.body);
      const model = provider === 'gemini' ? url.match(/\/models\/([^:]+):generateContent$/)[1] : body.model;
      calls.push({ model, body });
      return Response.json(envelope());
    } });
    for (const name of [...reasoningTasks, ...fastTasks, ...reasoningTasks]) {
      assert.deepEqual(await client.generate({ name, instructions: 'Return JSON.', data: {}, schema }), { value: 'ok' });
      const { model, body } = calls.at(-1);
      assert.equal(model, reasoningTasks.includes(name) ? 'reasoning-model' : 'fast-model');
      if (provider === 'ollama') assert.equal(body.think, reasoningTasks.includes(name) ? undefined : false);
    }
    assert.notEqual(analysisCacheScope(env, {}), analysisCacheScope({ ...env, [`${prefix}_FAST_MODEL`]: 'new-fast-model' }, {}));
  });

  test(`${provider}: absent fast model preserves single-model configurations`, async () => {
    const env = { AI_PROVIDER: provider, [`${prefix}_MODEL`]: 'single-model', [`${prefix}_API_KEY`]: 'test-key' };
    const client = createConfiguredClient(env, { scheduler: new UsageRequestQueue({ tokens: 10000000, requests: 1000 }), fetcher: async (url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(provider === 'gemini' ? url.match(/\/models\/([^:]+):generateContent$/)[1] : body.model, 'single-model');
      return Response.json(envelope());
    } });
    for (const name of [...reasoningTasks, ...fastTasks]) await client.generate({ name, instructions: 'Return JSON.', data: {}, schema });
  });
}
