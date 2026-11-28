import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const SESSION_AGE = 30 * 24 * 60 * 60;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('hex');
const failure = (status, message) => Object.assign(new Error(message), { status });
const publicUser = (user) => user ? { id: user.id, email: user.email } : null;

export function createAccounts(workspace, { secure = false, allowLegacyImport = false } = {}) {
  const attempts = new Map();
  let pending = Promise.resolve();
  const cookie = (response, name, value, age = SESSION_AGE) => {
    const previous = response.getHeader('Set-Cookie') ?? [];
    response.setHeader('Set-Cookie', [...previous, `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`]);
  };
  function identify(request, response) {
    const cookies = Object.fromEntries((request.headers.cookie ?? '').split(';').map((part) => part.trim().split('=')));
    let guest = cookies['learnmap.guest'];
    if (!/^[a-f0-9]{64}$/.test(guest ?? '')) {
      guest = token();
      cookie(response, 'learnmap.guest', guest, 365 * 24 * 60 * 60);
    }
    const guestId = `guest:${hash(guest)}`;
    const sessionKey = hash(cookies['learnmap.session'] ?? '');
    const session = workspace.sessions.get(sessionKey);
    const user = session?.expiresAt > Date.now() ? workspace.users.get(session.userId) : null;
    return { guestId, ownerId: user?.id ?? guestId, user, sessionKey };
  }
  async function handle(path, request, response, identity, input, clientAddress = request.socket.remoteAddress) {
    if (path === '/api/account' && request.method === 'GET') return { user: publicUser(identity.user), legacySubjects: allowLegacyImport && !identity.user ? [...workspace.subjects.values()].filter((item) => !item.ownerId).length : 0 };
    if (request.method !== 'POST') throw failure(405, '지원하지 않는 요청입니다.');
    if (!['/api/account/register', '/api/account/login', '/api/account/logout', '/api/account/restore'].includes(path)) throw failure(404, '계정 기능을 찾을 수 없습니다.');
    // Serialize credential changes and ownership transfers, including concurrent tabs.
    const action = pending.catch(() => undefined).then(async () => {
      if (path === '/api/account/restore') {
        if (!allowLegacyImport) throw failure(404, '이전 학습 공간 불러오기는 로컬 전용 서버에서만 사용할 수 있습니다.');
        if (identity.user) throw failure(409, '로그아웃 후 이전 학습 공간을 불러와 주세요.');
        // Legacy data was a shared local workspace. Import it only after the
        // user explicitly chooses to reopen it; never expose this on public hosts.
        const restoredSubjects = [...workspace.subjects.values()].filter((item) => !item.ownerId);
        const changed = [...restoredSubjects, ...workspace.analyses.values()].filter((item) => !item.ownerId);
        const previousOwners = changed.map((item) => item.ownerId);
        for (const item of changed) item.ownerId = identity.guestId;
        try { await workspace.save(); }
        catch (error) { changed.forEach((item, index) => { item.ownerId = previousOwners[index]; }); throw error; }
        return { user: null, legacySubjects: 0, restoredSubjectId: restoredSubjects.find((item) => item.id === input.legacySubjectId)?.id ?? restoredSubjects[0]?.id };
      }
      if (path === '/api/account/logout') {
        const session = workspace.sessions.get(identity.sessionKey);
        workspace.sessions.delete(identity.sessionKey);
        try { await workspace.save(); }
        catch (error) { if (session) workspace.sessions.set(identity.sessionKey, session); throw error; }
        cookie(response, 'learnmap.session', '', 0);
        return { user: null };
      }
      if (identity.user) throw failure(409, '다른 계정으로 전환하려면 먼저 로그아웃해 주세요.');
      const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
      const password = input.password;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw failure(400, '올바른 이메일을 입력해 주세요.');
      if (typeof password !== 'string' || password.length < 10 || password.length > 128) throw failure(400, '비밀번호는 10~128자로 입력해 주세요.');
      const address = clientAddress;
      const now = Date.now();
      for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
      const attempt = attempts.get(address) ?? { count: 0, until: now + 15 * 60 * 1000 };
      if (attempt.count >= 20) throw failure(429, '시도가 너무 많습니다. 15분 후 다시 시도해 주세요.');
      attempt.count += 1;
      attempts.set(address, attempt);
      let user = [...workspace.users.values()].find((item) => item.email === email);
      const registering = path.endsWith('/register');
      if (registering && user) throw failure(409, '이미 가입된 이메일입니다. 로그인해 주세요.');
      const salt = registering ? randomBytes(16).toString('hex') : user?.salt ?? 'learnmap-unknown-account';
      const digest = Buffer.from(await scrypt(password, salt, 64));
      if (!registering && (!user || !timingSafeEqual(digest, Buffer.from(user.passwordHash, 'hex')))) throw failure(401, '이메일 또는 비밀번호가 일치하지 않습니다.');
      if (registering) user = { id: randomUUID(), email, salt, passwordHash: digest.toString('hex'), createdAt: new Date().toISOString() };
      // Pre-account local workspaces had no owner. Only the local-only server may
      // recover the subject whose unguessable ID was remembered by this browser.
      const legacy = allowLegacyImport && typeof input.legacySubjectId === 'string'
        ? workspace.subjects.get(input.legacySubjectId) : null;
      const changed = [...workspace.subjects.values(), ...workspace.analyses.values()].filter((item) =>
        item.ownerId === identity.guestId || (legacy && !legacy.ownerId && !item.ownerId && (item.id === legacy.id || item.subjectId === legacy.id)));
      const previousOwners = changed.map((item) => item.ownerId);
      for (const item of changed) item.ownerId = user.id;
      const sessionToken = token();
      const sessionKey = hash(sessionToken);
      for (const [key, value] of workspace.sessions) if (value.expiresAt <= now) workspace.sessions.delete(key);
      workspace.users.set(user.id, user);
      workspace.sessions.set(sessionKey, { userId: user.id, expiresAt: now + SESSION_AGE * 1000 });
      try { await workspace.save(); }
      catch (error) {
        changed.forEach((item, index) => { item.ownerId = previousOwners[index]; });
        workspace.sessions.delete(sessionKey);
        if (registering) workspace.users.delete(user.id);
        throw error;
      }
      cookie(response, 'learnmap.session', sessionToken);
      return { user: publicUser(user), importedSubjects: changed.filter((item) => workspace.subjects.has(item.id)).length };
    });
    pending = action;
    return action;
  }
  return { identify, handle };
}
