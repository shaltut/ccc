import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { testApp } from './helpers.ts';

const t = await testApp();
after(() => t.sql.end());
const PUBLIC = new URL('../public/', import.meta.url);

test('ui never uses innerHTML', async () => {
  const files = (await readdir(PUBLIC)).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 0);
  for (const f of files) {
    const src = await readFile(new URL(f, PUBLIC), 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, f);
  }
});

test('live updates never remount over a half-typed draft', async () => {
  const src = await readFile(new URL('app.js', PUBLIC), 'utf8');
  assert.match(src, /function hasDraft\(/);
  // Only owner actions force a remount; SSE and the 30 s repaint go through the draft guard.
  assert.match(src, /const liveRefresh = debounce\(\(\) => void refresh\(\{ live: true \}\), 300\);/);
  assert.match(src, /!dialog\.open && !hasDraft\(\)\) render\(\);/);
});

test('ui js files stay under 800 lines', async () => {
  for (const f of (await readdir(PUBLIC)).filter((x) => x.endsWith('.js'))) {
    const lines = (await readFile(new URL(f, PUBLIC), 'utf8')).split('\n').length;
    assert.ok(lines <= 800, `${f}: ${lines} lines`);
  }
});

test('index served at /', async () => {
  const res = await t.app.request('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await res.text(), /<script type="module" src="\/app.js">/);
});

test('app.js and style.css served', async () => {
  assert.equal((await t.app.request('/app.js')).status, 200);
  assert.equal((await t.app.request('/style.css')).status, 200);
  assert.equal((await t.app.request('/nope.js')).status, 404);
});

test('stream requires owner', async () => {
  assert.equal((await t.app.request('/api/stream')).status, 401);
});

test('stream opens for owner as event-stream', async () => {
  const controller = new AbortController();
  const res = await t.owner('/api/stream', { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  controller.abort();
  await res.body?.cancel().catch(() => {});
});

test('events endpoint is owner only and filters by session', async () => {
  const token = await t.newDevice('ui');
  await t.agent(token, 'EV1')('/api/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"activity":true}' });
  await t.agent(token, 'EV1')('/api/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"workingOn":"x"}' });
  assert.equal((await t.agent(token, 'EV1')('/api/events')).status, 403);
  const res = await t.owner('/api/events?session=EV1&limit=10');
  const events = (await res.json()).events as { sessionName: string }[];
  assert.ok(events.length >= 1);
  assert.ok(events.every((e) => e.sessionName === 'EV1'));
});
