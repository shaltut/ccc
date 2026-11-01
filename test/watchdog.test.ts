import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.ts';
import { ensureSession, heartbeat, setRole } from '../src/sessions.ts';
import { runWatchdog, PING_TEXT } from '../src/watchdog.ts';

const t = await testApp();
after(() => t.sql.end());
await t.newDevice('d');
const [dev] = await t.sql<{ id: string }[]>`select id from ccc.devices`;
const deviceId = dev!.id;
await ensureSession(t.sql, 'ORC', deviceId);
await setRole(t.sql, 'ORC', 'orchestrator');

const NOW = new Date('2027-01-01T12:00:00Z');
const minutesBefore = (m: number) => new Date(NOW.getTime() - m * 60_000);

async function fresh(name: string, opts: { heartbeatMin: number; activityMin: number; status?: string; paused?: boolean }) {
  const s = await ensureSession(t.sql, name, deviceId);
  await t.sql`
    update ccc.sessions set last_heartbeat_at = ${minutesBefore(opts.heartbeatMin)},
      last_activity_at = ${minutesBefore(opts.activityMin)}, created_at = ${minutesBefore(600)},
      status = ${opts.status ?? 'idle'}, paused = ${opts.paused ?? false}
    where id = ${s.id}`;
  return s;
}
// Keep the orchestrator fresh so it does not trip the watchdog itself.
const keepOrcFresh = () =>
  t.sql`update ccc.sessions set last_heartbeat_at = ${NOW}, last_activity_at = ${NOW}, last_ping_at = null where name = 'ORC'`;

const messagesTo = (name: string, kind: string) =>
  t.sql<{ body: string }[]>`select m.body from ccc.messages m join ccc.sessions s on s.id = m.to_session_id
    where s.name = ${name} and m.kind = ${kind} order by m.id`;

test('15 min without heartbeat → unreachable + one note to orchestrator; second run adds nothing', async () => {
  await keepOrcFresh();
  await fresh('U1', { heartbeatMin: 16, activityMin: 16 });
  const first = await runWatchdog(t.sql, NOW);
  assert.deepEqual(first.unreachable, ['U1']);
  const [row] = await t.sql`select status from ccc.sessions where name = 'U1'`;
  assert.equal(row?.status, 'unreachable');
  const notes = await messagesTo('ORC', 'note');
  assert.equal(notes.at(-1)?.body, 'U1 is unreachable: no heartbeat for 15 min. It needs a nudge in its terminal.');
  const second = await runWatchdog(t.sql, NOW);
  assert.deepEqual(second.unreachable, []);
  assert.equal((await messagesTo('ORC', 'note')).length, notes.length);
});

test('idle 61 min → one ping; 30 min later no new ping; 61 min later a second ping', async () => {
  await keepOrcFresh();
  await fresh('I1', { heartbeatMin: 1, activityMin: 61 });
  const r1 = await runWatchdog(t.sql, NOW);
  assert.ok(r1.pinged.includes('I1'));
  assert.equal((await messagesTo('I1', 'ping')).at(-1)?.body, PING_TEXT);
  assert.equal(PING_TEXT, 'PING from CCC: no activity for over 1 hour. Report your status: what you are working on and what you are waiting on.');
  await t.sql`update ccc.sessions set last_heartbeat_at = ${new Date(NOW.getTime() + 29 * 60_000)} where name = 'I1'`;
  const r2 = await runWatchdog(t.sql, new Date(NOW.getTime() + 30 * 60_000));
  assert.ok(!r2.pinged.includes('I1'));
  await t.sql`update ccc.sessions set last_heartbeat_at = ${new Date(NOW.getTime() + 60 * 60_000)} where name = 'I1'`;
  const r3 = await runWatchdog(t.sql, new Date(NOW.getTime() + 61 * 60_000));
  assert.ok(r3.pinged.includes('I1'));
  assert.equal((await messagesTo('I1', 'ping')).length, 2);
});

test('paused and offline sessions are not pinged', async () => {
  await keepOrcFresh();
  await fresh('PZ', { heartbeatMin: 1, activityMin: 120, status: 'paused', paused: true });
  await fresh('OF', { heartbeatMin: 120, activityMin: 120, status: 'offline' });
  const r = await runWatchdog(t.sql, NOW);
  assert.ok(!r.pinged.includes('PZ'));
  assert.ok(!r.pinged.includes('OF'));
  assert.ok(!r.unreachable.includes('OF'));
});

test('waiting session (wait heartbeat only) is still pinged after 60 min without activity', async () => {
  await keepOrcFresh();
  await fresh('WT', { heartbeatMin: 0, activityMin: 65 });
  const r = await runWatchdog(t.sql, NOW);
  assert.ok(r.pinged.includes('WT'));
  assert.ok(!r.unreachable.includes('WT'));
});

test('wait heartbeat brings unreachable back to idle', async () => {
  const s = await fresh('BK', { heartbeatMin: 30, activityMin: 30, status: 'unreachable' });
  await heartbeat(t.sql, s.id, { activity: false });
  const [row] = await t.sql`select status from ccc.sessions where id = ${s.id}`;
  assert.equal(row?.status, 'idle');
});

test('unreachable orchestrator does not message itself', async () => {
  await t.sql`update ccc.sessions set last_heartbeat_at = ${minutesBefore(20)}, status = 'idle' where name = 'ORC'`;
  const r = await runWatchdog(t.sql, NOW);
  assert.ok(r.unreachable.includes('ORC'));
  const notes = await messagesTo('ORC', 'note');
  assert.ok(!notes.some((n) => n.body.startsWith('ORC is unreachable')));
});
