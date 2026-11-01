import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.ts';

const t = await testApp();
after(() => t.sql.end());

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('healthz ok', async () => {
  const res = await t.app.request('/healthz');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('login wrong password 401, right password sets cookie', async () => {
  const bad = await t.app.request('/api/admin/login', json({ password: 'nope-nope-nope' }));
  assert.equal(bad.status, 401);
  const good = await t.app.request('/api/admin/login', json({ password: t.config.adminPassword }));
  assert.equal(good.status, 200);
  const cookie = good.headers.get('set-cookie') ?? '';
  assert.match(cookie, /ccc_admin=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
});

test('owner route without cookie 401', async () => {
  const res = await t.app.request('/api/admin/devices');
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, 'unauthorized');
});

test('owner can create and list devices; token shown once', async () => {
  const res = await t.owner('/api/admin/devices', json({ label: 'mac' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.token, /^ccc_[A-Za-z0-9_-]{43}$/);
  const list = await (await t.owner('/api/admin/devices')).json();
  const mac = list.devices.find((d: { label: string }) => d.label === 'mac');
  assert.ok(mac);
  assert.equal(mac.token, undefined);
  assert.equal(mac.tokenHash, undefined);
});

test('revoked token 401', async () => {
  const token = await t.newDevice('revoke-me');
  const agent = t.agent(token, 'W1');
  assert.equal((await agent('/api/sessions')).status, 200);
  const list = await (await t.owner('/api/admin/devices')).json();
  const dev = list.devices.find((d: { label: string }) => d.label === 'revoke-me');
  assert.equal((await t.owner(`/api/admin/devices/${dev.id}/revoke`, json({}))).status, 200);
  assert.equal((await agent('/api/sessions')).status, 401);
});

test('bad bearer token 401', async () => {
  const res = await t.agent('ccc_not-a-real-token', 'W1')('/api/sessions');
  assert.equal(res.status, 401);
});

test('agent call without X-CCC-Session is 400 session_header_required', async () => {
  const token = await t.newDevice('no-header');
  const res = await t.app.request('/api/sessions', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'session_header_required');
});

test('agent cannot reach owner routes', async () => {
  const token = await t.newDevice('nosy');
  const res = await t.agent(token, 'W1')('/api/admin/devices');
  assert.equal(res.status, 403);
});

test('mutating request without json content-type is 415', async () => {
  const res = await t.owner('/api/admin/devices', { method: 'POST', body: 'label=x' });
  assert.equal(res.status, 415);
});

test('unknown error is generic 500', async () => {
  const fresh = await testApp();
  fresh.app.get('/boom', () => {
    throw new Error('secret detail');
  });
  const original = console.error;
  console.error = () => {};
  try {
    const res = await fresh.app.request('/boom');
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: { code: 'internal_error', message: 'Internal error' } });
  } finally {
    console.error = original;
    await fresh.sql.end();
  }
});

test('11th failed login is 429', async () => {
  const fresh = await testApp();
  try {
    for (let i = 0; i < 10; i++) {
      const res = await fresh.app.request('/api/admin/login', json({ password: 'wrong-wrong-wrong' }));
      assert.equal(res.status, 401);
    }
    const res = await fresh.app.request('/api/admin/login', json({ password: fresh.config.adminPassword }));
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error.code, 'too_many_attempts');
  } finally {
    await fresh.sql.end();
  }
});

test('parallel wrong logins cannot exceed the limit', async () => {
  const fresh = await testApp();
  try {
    const statuses = await Promise.all(
      Array.from({ length: 20 }, async () => (await fresh.app.request('/api/admin/login', json({ password: 'wrong-wrong-wrong' }))).status),
    );
    assert.equal(statuses.filter((s) => s === 401).length, 10);
    assert.equal(statuses.filter((s) => s === 429).length, 10);
  } finally {
    await fresh.sql.end();
  }
});

test('logout expires the admin cookie', async () => {
  const res = await t.app.request('/api/admin/logout', json({}));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie') ?? '', /ccc_admin=;.*Max-Age=0/);
});
