import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemoServer } from '../apps/api/src/demo-server.mjs';
import { createBrowserFetch } from './browser-fetch.mjs';
const fixture = JSON.parse(await readFile(new URL('../examples/fixture.json', import.meta.url), 'utf8'));
const fixtureClientFactory = () => ({ async generate(request) {
  let value = structuredClone(fixture[request.name]);
  if (request.name === 'concept_extraction') {
    const source = request.data.sources[0];
    value = { concepts: [{ ...value.concepts[0], sourceLocation: source.location, evidence: source.excerpts[0].id }] };
  }
  if (request.name === 'relation_analysis') value = { relations: [] };
  if (request.name === 'question_generation') value.type = request.data.type;
  return request.schema.parse(value);
} });
import { createAccounts } from '../apps/api/src/features/accounts/index.mjs';
import { createWorkspace } from '../apps/api/src/features/workspace/index.mjs';

const credentials = { email: 'learner@example.com', password: 'learnmap-password-123' };
async function start(storagePath, env = {}) {
  const server = createDemoServer({ storagePath, env, clientFactory: fixtureClientFactory });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: async () => { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; },
  };
}
const post = (browser, base, path, data) => browser.fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const get = async (browser, base, path) => (await browser.fetch(base + path)).json();
async function subject(browser, base, name) {
  const response = await post(browser, base, '/api/subjects', { name });
  assert.equal(response.status, 201);
  return response.json();
}
async function ready(browser, base, id) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await get(browser, base, `/api/analyses/${id}`);
    assert.notEqual(result.status, 'failed', JSON.stringify(result.error));
    if (result.status === 'ready') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Analysis timed out');
}

test('guest graphs and learning state merge into an account, sync across devices, and survive restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'learnmap-accounts-'));
  const storagePath = join(directory, 'workspace.json');
  let server = await start(storagePath);
  const first = createBrowserFetch();
  const second = createBrowserFetch();
  const stranger = createBrowserFetch();
  try {
    const initial = await first.fetch(server.base + '/api/account');
    assert.equal((await initial.json()).user, null);
    assert.match(initial.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
    const one = await subject(first, server.base, '첫 기기 지도');
    const upload = await first.fetch(`${server.base}/api/analyses?filename=lecture.txt&subjectId=${one.id}`, { method: 'POST', body: await readFile(new URL('../examples/lecture.txt', import.meta.url)) });
    assert.equal(upload.status, 202);
    const { id: materialId } = await upload.json();
    await ready(first, server.base, materialId);
    let view = await get(first, server.base, `/api/subjects/${one.id}`);
    const questions = await post(first, server.base, `/api/analyses/${one.id}/questions`, { conceptId: view.graph.concepts[0].id, type: 'SHORT_ANSWER' });
    assert.equal(questions.status, 200);
    const set = await questions.json();
    const evaluation = await post(first, server.base, `/api/analyses/${one.id}/evaluations`, { questionId: set.questions[0].questionId, answer: '페이지가 메모리에 없어 디스크에서 불러오는 과정입니다.' });
    assert.equal(evaluation.status, 200);
    view = await get(first, server.base, `/api/subjects/${one.id}`);
    const register = await post(first, server.base, '/api/account/register', { ...credentials, email: ' Learner@Example.com ' });
    assert.equal(register.status, 200);
    assert.equal((await register.json()).importedSubjects, 1);
    const two = await subject(second, server.base, '둘째 기기 지도');
    assert.equal((await get(second, server.base, '/api/workspace')).subjects.length, 1);
    assert.equal((await stranger.fetch(`${server.base}/api/subjects/${one.id}`)).status, 404);
    assert.equal((await stranger.fetch(`${server.base}/api/materials/${materialId}/file`)).status, 404);
    assert.equal((await post(stranger, server.base, `/api/materials/${materialId}/analyze`, {})).status, 404);
    assert.equal((await stranger.fetch(`${server.base}/api/materials/${materialId}`, { method: 'DELETE' })).status, 404);
    assert.equal((await post(stranger, server.base, `/api/subjects/${one.id}/organize`, {})).status, 404);
    assert.equal((await stranger.fetch(`${server.base}/api/analyses/${materialId}`)).status, 404);
    assert.equal((await post(stranger, server.base, `/api/analyses/${one.id}/questions`, {})).status, 404);
    assert.equal((await stranger.fetch(`${server.base}/api/analyses?filename=x.txt&subjectId=${one.id}`, { method: 'POST', body: 'x' })).status, 404);
    const login = await post(second, server.base, '/api/account/login', credentials);
    assert.equal(login.status, 200);
    assert.equal((await login.json()).importedSubjects, 1);
    assert.deepEqual((await get(first, server.base, '/api/workspace')).subjects.map((item) => item.id).sort(), [one.id, two.id].sort());
    assert.deepEqual(await get(second, server.base, `/api/subjects/${one.id}`), view);
    await post(second, server.base, '/api/account/logout', {});
    assert.deepEqual((await get(second, server.base, '/api/workspace')).subjects, []);
    assert.equal((await second.fetch(`${server.base}/api/subjects/${one.id}`)).status, 404);
    const again = await post(second, server.base, '/api/account/login', credentials);
    assert.equal((await again.json()).importedSubjects, 0);
    await server.close();
    server = await start(storagePath);
    assert.equal((await get(first, server.base, '/api/account')).user.email, credentials.email);
    assert.deepEqual(await get(first, server.base, `/api/subjects/${one.id}`), view);
    const stored = await readFile(storagePath, 'utf8');
    assert.ok(!stored.includes(credentials.password));
    assert.ok(!stored.includes(first.cookies.get('learnmap.session')));
    assert.ok(!stored.includes(first.cookies.get('learnmap.guest')));
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('invalid credentials, duplicate accounts, revoked sessions and cross-origin requests are rejected', async () => {
  const server = await start();
  const browser = createBrowserFetch();
  try {
    assert.equal((await post(browser, server.base, '/api/account/register', { email: 'bad', password: 'short' })).status, 400);
    assert.equal((await post(browser, server.base, '/api/account/register', credentials)).status, 200);
    const stolen = createBrowserFetch(browser.cookies);
    assert.equal((await post(browser, server.base, '/api/account/logout', {})).status, 200);
    assert.equal((await get(stolen, server.base, '/api/account')).user, null);
    assert.equal((await post(browser, server.base, '/api/account/login', { ...credentials, password: 'wrong-password' })).status, 401);
    assert.equal((await post(browser, server.base, '/api/account/register', credentials)).status, 409);
    const crossed = await browser.fetch(server.base + '/api/account/login', { method: 'POST', headers: { Origin: 'https://attacker.example' }, body: JSON.stringify(credentials) });
    assert.equal(crossed.status, 403);
    for (let i = 0; i < 17; i++) await post(browser, server.base, '/api/account/login', { ...credentials, password: 'wrong-password' });
    assert.equal((await post(browser, server.base, '/api/account/login', credentials)).status, 429);
  } finally { await server.close(); }
});

test('failed persistence rolls back account creation and guest ownership', async () => {
  const workspace = createWorkspace();
  const item = { id: 'subject', ownerId: 'guest:before' };
  workspace.subjects.set(item.id, item);
  workspace.save = async () => { throw new Error('disk unavailable'); };
  const accounts = createAccounts(workspace);
  const response = { getHeader: () => [], setHeader: () => assert.fail('No cookie should be issued') };
  await assert.rejects(accounts.handle('/api/account/register', { method: 'POST', socket: { remoteAddress: 'test' } }, response, { guestId: 'guest:before' }, credentials), /disk unavailable/);
  assert.equal(item.ownerId, 'guest:before');
  assert.equal(workspace.users.size, 0);
  assert.equal(workspace.sessions.size, 0);
});

test('only the local-only server recovers an unowned legacy subject remembered in browser storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'learnmap-legacy-'));
  const path = join(directory, 'workspace.json');
  const legacyId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  try {
    for (const env of [{}, { APP_ORIGIN: 'https://learnmap.example' }]) {
      await writeFile(path, JSON.stringify({ subjects: [{ id: legacyId, name: '기존 지도', history: [], questions: [], progress: [] }], analyses: [] }));
      const server = await start(path, env);
      try {
        const browser = createBrowserFetch();
        const response = await post(browser, server.base, '/api/account/register', { ...credentials, legacySubjectId: legacyId });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).importedSubjects, env.APP_ORIGIN ? 0 : 1);
        if (env.APP_ORIGIN) assert.match(response.headers.get('set-cookie'), /Secure/);
      } finally { await server.close(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('local legacy workspaces reopen without login, retain original files, and import once on signup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'learnmap-restore-'));
  const path = join(directory, 'workspace.json');
  const firstId = '11111111-2222-3333-4444-555555555555';
  const secondId = '22222222-2222-3333-4444-555555555555';
  const materialId = '33333333-2222-3333-4444-555555555555';
  try {
    await writeFile(path, JSON.stringify({
      subjects: [firstId, secondId].map((id) => ({ id, name: id === firstId ? '이전 지도 1' : '이전 지도 2', history: [], questions: [], progress: [] })),
      analyses: [{ id: materialId, subjectId: firstId, filename: 'notes.txt', bytes: Buffer.from('original notes').toString('base64'), status: 'failed', events: [], questions: [], progress: [] }],
    }));
    const server = await start(path);
    try {
      const browser = createBrowserFetch();
      const other = createBrowserFetch();
      assert.equal((await get(browser, server.base, '/api/account')).legacySubjects, 2);
      assert.deepEqual((await get(browser, server.base, '/api/workspace')).subjects, []);
      const response = await post(browser, server.base, '/api/account/restore', { legacySubjectId: secondId });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).restoredSubjectId, secondId);
      assert.equal((await get(browser, server.base, '/api/account')).user, null);
      assert.equal((await get(browser, server.base, '/api/workspace')).subjects.length, 2);
      assert.equal(await (await browser.fetch(`${server.base}/api/materials/${materialId}/file`)).text(), 'original notes');
      assert.equal((await get(other, server.base, '/api/account')).legacySubjects, 0);
      assert.equal((await other.fetch(`${server.base}/api/subjects/${firstId}`)).status, 404);
      const signup = await post(browser, server.base, '/api/account/register', credentials);
      assert.equal((await signup.json()).importedSubjects, 2);
      assert.equal((await post(browser, server.base, '/api/account/restore', {})).status, 409);
    } finally { await server.close(); }
    const published = await start(path, { APP_ORIGIN: 'https://learnmap.example' });
    try {
      const browser = createBrowserFetch();
      assert.equal((await post(browser, published.base, '/api/account/restore', {})).status, 404);
    } finally { await published.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
