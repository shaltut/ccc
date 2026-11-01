import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, post } from './helpers.ts';
import {
  ensureSession,

  resolveAddress,
  resumeContext,
  setRole,
  reportStatus,
} from '../src/sessions.ts';

const t = await testApp();
after(() => t.sql.end());
const token = await t.newDevice('win');
const [device] = await t.sql<{ id: string }[]>`select id from ccc.devices where label = 'win'`;
const deviceId = device!.id;

const register = async (name: string, claude: string, extra: Record<string, unknown> = {}) => {
  const res = await t.agent(token, name, claude)('/api/sessions/register', post({ claudeSessionId: claude, cwd: 'F:/x', ...extra }));
  return { status: res.status, body: await res.json() };
};
const ageActivity = (name: string, minutes: number) =>
  t.sql`update ccc.sessions set last_activity_at = now() - make_interval(mins => ${minutes}) where name = ${name}`;

test('register new name', async () => {
  const r = await register('W1', 'c1');
  assert.equal(r.status, 200);
  assert.equal(r.body.assignedName, 'W1');
  assert.equal(r.body.takeover, false);
  assert.equal(r.body.session.role, 'worker');
  assert.equal(typeof r.body.resume, 'string');
});

test('same claude id reattaches', async () => {
  const first = await register('R1', 'r1');
  const again = await register('R1', 'r1', { cwd: 'F:/other' });
  assert.equal(again.body.session.id, first.body.session.id);
  assert.equal(again.body.session.cwd, 'F:/other');
  assert.equal(again.body.assignedName, 'R1');
});

test('row created by an MCP call, then register, reattaches', async () => {
  await ensureSession(t.sql, 'M1', deviceId);
  const r = await register('M1', 'm1');
  assert.equal(r.body.assignedName, 'M1');
  assert.equal(r.body.takeover, false);
  assert.equal(r.body.session.claudeSessionId, 'm1');
});

test('active holder → newcomer gets A1-2', async () => {
  await register('A1', 'a1');
  await t.agent(token, 'A1', 'a1')('/api/heartbeat', post({ activity: true }));
  const r = await register('A1', 'a2');
  assert.equal(r.body.assignedName, 'A1-2');
  assert.equal(r.body.takeover, false);
});

test('stale holder → newest takes over', async () => {
  await register('S1', 's1');
  await ageActivity('S1', 3);
  const r = await register('S1', 's2');
  assert.equal(r.body.assignedName, 'S1');
  assert.equal(r.body.takeover, true);
  assert.deepEqual(r.body.session.supersededClaudeSessionIds, ['s1']);
  const [ev] = await t.sql`select type from ccc.events where type = 'takeover'`;
  assert.ok(ev);
});

test('superseded claude id is refused and cannot mark live holder offline', async () => {
  await register('X1', 'x1');
  await ageActivity('X1', 3);
  await register('X1', 'x2');
  const res = await t.agent(token, 'X1', 'x1')('/api/status', post({ status: 'offline' }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, 'superseded');
  const [row] = await t.sql`select status from ccc.sessions where name = 'X1'`;
  assert.notEqual(row?.status, 'offline');
});

test('concurrent register same name never 500s', async () => {
  const results = await Promise.all(['k1', 'k2', 'k3', 'k4', 'k5'].map((c) => register('K1', c)));
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));
  const names = results.map((r) => r.body.assignedName);
  assert.equal(new Set(names).size, names.length);
});

test('orchestrator cannot be self-claimed', async () => {
  const r = await register('O1', 'o1', { role: 'orchestrator' });
  assert.equal(r.body.session.role, 'worker');
  const [ev] = await t.sql`select type from ccc.events where type = 'orchestrator_request_denied'`;
  assert.ok(ev);
});

test('register may request a non-orchestrator role', async () => {
  const r = await register('H1', 'h1', { role: 'helper' });
  assert.equal(r.body.session.role, 'helper');
});

test('setRole moves orchestrator; resolveAddress follows', async () => {
  await assert.rejects(resolveAddress(t.sql, 'orchestrator', 'default'), /no_orchestrator|No session/);
  await ensureSession(t.sql, 'OA', deviceId);
  await ensureSession(t.sql, 'OB', deviceId);
  await setRole(t.sql, 'OA', 'orchestrator');
  await setRole(t.sql, 'OB', 'orchestrator');
  const rows = await t.sql`select name, role from ccc.sessions where name in ('OA', 'OB') order by name`;
  assert.deepEqual(rows.map((r) => [r.name, r.role]), [['OA', 'worker'], ['OB', 'orchestrator']]);
  assert.equal((await resolveAddress(t.sql, 'orchestrator', 'default')).name, 'OB');
  await assert.rejects(resolveAddress(t.sql, 'nobody-here'), /unknown_session|No session/);
});

test('owner sets role over REST; agents cannot', async () => {
  await ensureSession(t.sql, 'RR', deviceId);
  const denied = await t.agent(token, 'RR')('/api/admin/sessions/RR/role', post({ role: 'helper' }));
  assert.equal(denied.status, 403);
  const ok = await t.owner('/api/admin/sessions/RR/role', post({ role: 'auditor' }));
  assert.equal((await ok.json()).session.role, 'auditor');
});

test('resumeContext contains standing rules and stays under 1500 chars', async () => {
  const s = await ensureSession(t.sql, 'CTX', deviceId);
  const text = await resumeContext(t.sql, s);
  assert.ok(text.length < 1500, `length ${text.length}`);
  assert.match(text, /CTX/);
  assert.match(text, /While idle, keep "ccc wait" running in the background so messages can wake you\./);
  assert.match(text, /Report what you are working on with report_status or "ccc status"\./);
  assert.match(text, /Send results and findings to the orchestrator\./);
});

test('paused session reporting working stays paused', async () => {
  const s = await ensureSession(t.sql, 'P1', deviceId);
  await t.sql`update ccc.sessions set paused = true, status = 'paused' where id = ${s.id}`;
  const after = await reportStatus(t.sql, { ...s, paused: true }, { status: 'working', workingOn: 'x' });
  assert.equal(after.status, 'paused');
  assert.equal(after.workingOn, 'x');
});

test('status and heartbeat over REST; list shows the session', async () => {
  const agent = t.agent(token, 'L1');
  const st = await agent('/api/status', post({ status: 'blocked', workingOn: 'tests', blocker: 'need DB' }));
  assert.equal((await st.json()).session.blocker, 'need DB');
  const list = await (await t.owner('/api/sessions')).json();
  const l1 = list.sessions.find((s: { name: string }) => s.name === 'L1');
  assert.equal(l1.status, 'blocked');
  assert.equal(l1.unread, 0);
  assert.equal(l1.pausePending, false);
  assert.equal(l1.currentTask, null);
});

test('waiting_permission is cleared by activity heartbeat', async () => {
  const agent = t.agent(token, 'WP');
  await agent('/api/status', post({ status: 'waiting_permission', blocker: 'Permission prompt: Bash' }));
  await agent('/api/heartbeat', post({ activity: true }));
  const [row] = await t.sql`select status, blocker from ccc.sessions where name = 'WP'`;
  assert.equal(row?.status, 'working');
  assert.equal(row?.blocker, null);
});

test('GET /api/me returns resume', async () => {
  const res = await t.agent(token, 'ME')('/api/me');
  const b = await res.json();
  assert.equal(b.session.name, 'ME');
  assert.match(b.resume, /ccc wait/);
});

test('owner retires a session', async () => {
  await ensureSession(t.sql, 'OLD', deviceId);
  const res = await t.owner('/api/admin/sessions/OLD/retire', post({}));
  assert.ok((await res.json()).session.retiredAt);
  await assert.rejects(resolveAddress(t.sql, 'OLD'));
});

test('a -2 newcomer acts as its own row, never the base name', async () => {
  await register('N1', 'n1');
  await t.agent(token, 'N1', 'n1')('/api/heartbeat', post({ activity: true }));
  assert.equal((await register('N1', 'n2')).body.assignedName, 'N1-2');
  // Its later calls still carry X-CCC-Session: N1 (the env var), plus its own Claude id.
  const me = await (await t.agent(token, 'N1', 'n2')('/api/me')).json();
  assert.equal(me.session.name, 'N1-2');
  await t.agent(token, 'N1', 'n2')('/api/status', post({ status: 'offline' }));
  const rows = await t.sql<{ name: string; status: string }[]>`select name, status from ccc.sessions where name like 'N1%' order by name`;
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [['N1', 'working'], ['N1-2', 'offline']]);
});

test('a resumed process that takes its name back is not locked out', async () => {
  await register('Z1', 'z1');
  await ageActivity('Z1', 3);
  await register('Z1', 'z2');
  await ageActivity('Z1', 3);
  const back = await register('Z1', 'z1');
  assert.equal(back.body.takeover, true);
  assert.deepEqual(back.body.session.supersededClaudeSessionIds, ['z2']);
  assert.equal((await t.agent(token, 'Z1', 'z1')('/api/status', post({ status: 'working' }))).status, 200);
});

test('leaving waiting_permission clears the permission blocker', async () => {
  const s = await ensureSession(t.sql, 'P9', deviceId);
  await reportStatus(t.sql, s, { status: 'waiting_permission', blocker: 'Permission prompt: Bash' });
  const after = await reportStatus(t.sql, s, { status: 'idle' });
  assert.equal(after.blocker, null);
  const blocked = await reportStatus(t.sql, s, { status: 'blocked', blocker: 'Needs DB access' });
  assert.equal((await reportStatus(t.sql, blocked, { workingOn: 'x' })).blocker, 'Needs DB access');
});
