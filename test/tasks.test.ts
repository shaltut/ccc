import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, post } from './helpers.ts';
import { ensureSession, setRole } from '../src/sessions.ts';

const t = await testApp();
after(() => t.sql.end());
const token = await t.newDevice('vps');
const [dev] = await t.sql<{ id: string }[]>`select id from ccc.devices`;
for (const n of ['ORC', 'W1', 'W2']) await ensureSession(t.sql, n, dev!.id);
await setRole(t.sql, 'ORC', 'orchestrator');
const orc = t.agent(token, 'ORC');
const w1 = t.agent(token, 'W1');
const w2 = t.agent(token, 'W2');
const inbox = async (agent: typeof w1) => (await (await agent('/api/inbox')).json()).messages as { kind: string; body: string }[];

const assign = async (to: string, title: string) => (await (await orc('/api/tasks', post({ to, title, body: 'details' }))).json()).task;

test('orchestrator assigns → worker inbox has task message', async () => {
  const task = await assign('W1', 'write tests');
  assert.equal(task.status, 'open');
  assert.equal(task.assigneeName, 'W1');
  const msgs = await inbox(w1);
  assert.equal(msgs.at(-1)?.kind, 'task');
  assert.equal(msgs.at(-1)?.body, `Task T${task.id}: write tests\n\ndetails`);
});

test('worker cannot assign', async () => {
  const res = await w1('/api/tasks', post({ to: 'W2', title: 'x' }));
  assert.equal(res.status, 403);
});

test('reassign notifies both', async () => {
  const task = await assign('W1', 'move me');
  await inbox(w1);
  const res = await orc(`/api/tasks/${task.id}/assign`, post({ to: 'W2' }));
  assert.equal((await res.json()).task.assigneeName, 'W2');
  assert.equal((await inbox(w1)).at(-1)?.body, `T${task.id} was moved to W2. Stop working on it.`);
  assert.equal((await inbox(w2)).at(-1)?.kind, 'task');
});

test('cancel notifies assignee', async () => {
  const task = await assign('W1', 'cancel me');
  await inbox(w1);
  const res = await orc(`/api/tasks/${task.id}/cancel`, post({}));
  assert.equal((await res.json()).task.status, 'cancelled');
  assert.equal((await inbox(w1)).at(-1)?.body, `T${task.id} was cancelled. Stop working on it.`);
});

test('done sends note to orchestrator', async () => {
  const task = await assign('W1', 'finish me');
  await inbox(orc);
  await w1(`/api/tasks/${task.id}`, post({ status: 'in_progress' }));
  const res = await w1(`/api/tasks/${task.id}`, post({ status: 'done', result: 'all green' }));
  assert.equal((await res.json()).task.status, 'done');
  assert.equal((await inbox(orc)).at(-1)?.body, `T${task.id} done by W1: all green`);
});

test('blocked sends note to orchestrator', async () => {
  const task = await assign('W1', 'block me');
  await inbox(orc);
  await w1(`/api/tasks/${task.id}`, post({ status: 'blocked', blocker: 'need creds' }));
  assert.equal((await inbox(orc)).at(-1)?.body, `T${task.id} blocked by W1: need creds`);
});

test('non-assignee worker cannot update', async () => {
  const task = await assign('W1', 'mine');
  const res = await w2(`/api/tasks/${task.id}`, post({ status: 'done' }));
  assert.equal(res.status, 403);
});

test('update closed task 409', async () => {
  const task = await assign('W1', 'close me');
  await w1(`/api/tasks/${task.id}`, post({ status: 'done' }));
  const res = await w1(`/api/tasks/${task.id}`, post({ status: 'in_progress' }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, 'task_closed');
});

test('list tasks filters by assignee and status', async () => {
  const res = await w1('/api/tasks?assignee=W2&status=open');
  const tasks = (await res.json()).tasks as { assigneeName: string; status: string }[];
  assert.ok(tasks.length >= 1);
  assert.ok(tasks.every((x) => x.assigneeName === 'W2' && x.status === 'open'));
});

test('unknown task 404', async () => {
  assert.equal((await w1('/api/tasks/99999', post({ status: 'done' }))).status, 404);
});
