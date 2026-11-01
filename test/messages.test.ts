import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, post } from './helpers.ts';
import { ensureSession, listSessions, setRole } from '../src/sessions.ts';
import { sendMessage, takeUnread, peekUnread, waitForUnread, PAUSE_TEXT } from '../src/messages.ts';

const t = await testApp();
after(() => t.sql.end());
const token = await t.newDevice('mac');
const [dev] = await t.sql<{ id: string }[]>`select id from ccc.devices where label = 'mac'`;
const deviceId = dev!.id;
const session = (name: string) => ensureSession(t.sql, name, deviceId);

test('send then take marks read once', async () => {
  const to = await session('M1');
  await sendMessage(t.sql, { from: 'owner', to, kind: 'note', body: 'hello' });
  assert.equal((await takeUnread(t.sql, to.id)).length, 1);
  assert.equal((await takeUnread(t.sql, to.id)).length, 0);
});

test('peek does not mark read', async () => {
  const to = await session('M2');
  await sendMessage(t.sql, { from: 'owner', to, kind: 'note', body: 'x' });
  assert.equal((await peekUnread(t.sql, to.id)).length, 1);
  assert.equal((await peekUnread(t.sql, to.id)).length, 1);
  const res = await t.agent(token, 'M2')('/api/inbox?peek=1');
  assert.equal((await res.json()).messages.length, 1);
});

test('arabic and 64k body round-trip; 65537 chars is 400 validation_error', async () => {
  await session('M3');
  const sender = t.agent(token, 'M3s');
  const big = 'ع'.repeat(65536);
  const ok = await sender('/api/messages', post({ to: 'M3', body: big }));
  assert.equal(ok.status, 200);
  const inbox = await (await t.agent(token, 'M3')('/api/inbox')).json();
  assert.equal(inbox.messages[0].body, big);
  const tooBig = await sender('/api/messages', post({ to: 'M3', body: 'x'.repeat(65537) }));
  assert.equal(tooBig.status, 400);
  assert.equal((await tooBig.json()).error.code, 'validation_error');
});

test('wait returns when a message arrives', async () => {
  const to = await session('M4');
  const started = Date.now();
  const waiting = waitForUnread(t.sql, to.id, 5000);
  setTimeout(() => void sendMessage(t.sql, { from: 'owner', to, kind: 'note', body: 'wake' }), 100);
  const msgs = await waiting;
  assert.equal(msgs.length, 1);
  assert.ok(Date.now() - started < 1000);
});

test('wait over REST returns the message', async () => {
  await session('M4r');
  const waiting = t.agent(token, 'M4r')('/api/inbox/wait?timeoutMs=5000');
  setTimeout(() => void t.agent(token, 'M4s')('/api/messages', post({ to: 'M4r', body: 'ping' })), 100);
  const res = await waiting;
  assert.equal(res.status, 200);
  assert.equal((await res.json()).messages[0].body, 'ping');
});

test('wait times out with 204', async () => {
  await session('M5');
  const started = Date.now();
  const res = await t.agent(token, 'M5')('/api/inbox/wait?timeoutMs=1000');
  assert.equal(res.status, 204);
  assert.ok(Date.now() - started >= 900);
});

test('wait counts as heartbeat not activity', async () => {
  const s = await session('M6');
  await t.sql`update ccc.sessions set last_activity_at = '2026-01-01', last_heartbeat_at = null where id = ${s.id}`;
  await waitForUnread(t.sql, s.id, 50);
  const [row] = await t.sql`select last_wait_at, last_heartbeat_at, last_activity_at from ccc.sessions where id = ${s.id}`;
  assert.ok(row?.lastWaitAt);
  assert.ok(row?.lastHeartbeatAt);
  assert.equal((row?.lastActivityAt as Date).toISOString(), new Date('2026-01-01').toISOString());
});

test('broadcast fans out, excludes sender', async () => {
  await session('BO');
  await setRole(t.sql, 'BO', 'orchestrator');
  const [{ live } = { live: 0 }] = await t.sql<{ live: number }[]>`
    select count(*) as live from ccc.sessions where retired_at is null`;
  const res = await t.agent(token, 'BO')('/api/broadcast', post({ body: 'all hands' }));
  assert.equal((await res.json()).count, live - 1);
  const mine = await t.sql`select 1 from ccc.messages m join ccc.sessions s on s.id = m.to_session_id
    where s.name = 'BO' and m.body = 'all hands'`;
  assert.equal(mine.length, 0);
});

test('worker cannot send instruction or broadcast', async () => {
  await session('M7');
  const w = t.agent(token, 'M7w');
  assert.equal((await w('/api/messages', post({ to: 'M7', body: 'do it', kind: 'instruction' }))).status, 403);
  assert.equal((await w('/api/broadcast', post({ body: 'x' }))).status, 403);
  assert.equal((await w('/api/control', post({ target: 'all', action: 'pause' }))).status, 403);
});

test('message to orchestrator alias reaches the holder', async () => {
  await session('ORC');
  await setRole(t.sql, 'ORC', 'orchestrator');
  await t.agent(token, 'M8')('/api/messages', post({ to: 'orchestrator', body: 'finding' }));
  const inbox = await (await t.agent(token, 'ORC')('/api/inbox')).json();
  assert.equal(inbox.messages.at(-1).body, 'finding');
  assert.equal(inbox.messages.at(-1).fromName, 'M8');
});

test('pause all → pausePending until delivered, then paused; skips orchestrator', async () => {
  const p = await session('P1');
  const res = await t.owner('/api/control', post({ target: 'all', action: 'pause' }));
  assert.ok((await res.json()).count >= 1);
  const view = (await listSessions(t.sql)).find((s) => s.name === 'P1');
  assert.equal(view?.pausePending, true);
  const orc = (await listSessions(t.sql)).find((s) => s.name === 'ORC');
  assert.equal(orc?.pausePending, false);
  const delivered = await takeUnread(t.sql, p.id);
  const pause = delivered.find((m) => m.kind === 'control');
  assert.equal(pause?.body, PAUSE_TEXT);
  assert.equal(PAUSE_TEXT, 'PAUSE: finish the current step, then stop and wait for RESUME.');
  const [row] = await t.sql`select paused, status from ccc.sessions where id = ${p.id}`;
  assert.equal(row?.paused, true);
  assert.equal(row?.status, 'paused');
});

test('resume one session clears paused on delivery', async () => {
  const res = await t.owner('/api/control', post({ target: 'P1', action: 'resume' }));
  assert.equal((await res.json()).count, 1);
  const inbox = await (await t.agent(token, 'P1')('/api/inbox')).json();
  assert.equal(inbox.messages[0].body, 'RESUME: you may continue your work.');
  const [row] = await t.sql`select paused, status from ccc.sessions where name = 'P1'`;
  assert.equal(row?.paused, false);
  assert.equal(row?.status, 'idle');
});

test('message to unknown session is 404', async () => {
  const res = await t.agent(token, 'M9')('/api/messages', post({ to: 'ghost', body: 'x' }));
  assert.equal(res.status, 404);
});

test("a superseded process cannot take the new holder's mail", async () => {
  const reg = (claude: string) => t.agent(token, 'G1', claude)('/api/sessions/register', post({ claudeSessionId: claude, cwd: null }));
  await reg('g1');
  await t.sql`update ccc.sessions set last_activity_at = now() - interval '3 minutes' where name = 'G1'`;
  await reg('g2');
  const to = await session('G1');
  await sendMessage(t.sql, { from: 'owner', to, kind: 'note', body: 'for the new holder' });
  assert.equal((await takeUnread(t.sql, to.id, { claudeSessionId: 'g1' })).length, 0);
  assert.equal((await takeUnread(t.sql, to.id, { claudeSessionId: 'g2' })).length, 1);
});

test('peek then ack marks only the acked ids read', async () => {
  const to = await session('K1');
  const a = await sendMessage(t.sql, { from: 'owner', to, kind: 'note', body: 'one' });
  await sendMessage(t.sql, { from: 'owner', to, kind: 'note', body: 'two' });
  const res = await t.agent(token, 'K1')('/api/inbox/ack', post({ ids: [a.id] }));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).acked, [a.id]);
  assert.deepEqual((await peekUnread(t.sql, to.id)).map((m) => m.body), ['two']);
});
