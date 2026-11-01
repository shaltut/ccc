import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, post } from './helpers.ts';
import { ensureSession, setRole } from '../src/sessions.ts';

const t = await testApp();
after(() => t.sql.end());
const token = await t.newDevice('win');
const [dev] = await t.sql<{ id: string }[]>`select id from ccc.devices`;
for (const n of ['A', 'B', 'W1', 'W2']) await ensureSession(t.sql, n, dev!.id);
const w1 = t.agent(token, 'W1');
const w2 = t.agent(token, 'W2');
const inbox = async (name: string) =>
  (await (await t.agent(token, name)('/api/inbox')).json()).messages as { kind: string; body: string }[];

const ask = async (agent: typeof w1, q: Record<string, unknown>) => (await (await agent('/api/questions', post(q))).json()).question;

test('ask owner then owner answers with choice → asker inbox has answer with label', async () => {
  const q = await ask(w1, { to: 'owner', body: 'Merge #12?', options: [{ key: 'a', label: 'Yes' }, { key: 'b', label: 'No' }] });
  assert.equal(q.addressedTo, 'owner');
  assert.equal(q.status, 'open');
  const res = await t.owner(`/api/questions/${q.id}/answer`, post({ choice: 'a', text: 'go ahead' }));
  const answered = (await res.json()).question;
  assert.equal(answered.status, 'answered');
  assert.equal(answered.answeredBy, 'owner');
  assert.equal((await inbox('W1')).at(-1)?.body, `Answer to Q${q.id}: [Yes] go ahead`);
});

test('invalid choice 400 invalid_choice', async () => {
  const q = await ask(w1, { to: 'owner', body: 'pick', options: [{ key: 'a', label: 'A' }] });
  const res = await t.owner(`/api/questions/${q.id}/answer`, post({ choice: 'z' }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'invalid_choice');
});

test('answer with neither choice nor text is 400', async () => {
  const q = await ask(w1, { to: 'owner', body: 'empty?' });
  const res = await t.owner(`/api/questions/${q.id}/answer`, post({}));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'validation_error');
});

test('second answer 409', async () => {
  const q = await ask(w1, { to: 'owner', body: 'once' });
  await t.owner(`/api/questions/${q.id}/answer`, post({ text: 'first' }));
  const res = await t.owner(`/api/questions/${q.id}/answer`, post({ text: 'second' }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, 'already_closed');
});

test('question to orchestrator follows role move', async () => {
  await setRole(t.sql, 'A', 'orchestrator');
  const q = await ask(w1, { to: 'orchestrator', body: 'which branch?' });
  assert.equal(q.addressedTo, 'role:orchestrator');
  assert.equal((await inbox('A')).at(-1)?.kind, 'question');
  await setRole(t.sql, 'B', 'orchestrator');
  const denied = await t.agent(token, 'A')(`/api/questions/${q.id}/answer`, post({ text: 'main' }));
  assert.equal(denied.status, 403);
  const ok = await t.agent(token, 'B')(`/api/questions/${q.id}/answer`, post({ text: 'main' }));
  assert.equal(ok.status, 200);
});

test('question to a session can be answered by it', async () => {
  const q = await ask(w1, { to: 'W2', body: 'did you touch db.ts?' });
  assert.equal((await inbox('W2')).at(-1)?.kind, 'question');
  const res = await w2(`/api/questions/${q.id}/answer`, post({ text: 'no' }));
  assert.equal(res.status, 200);
});

test('unrelated worker cannot answer', async () => {
  const q = await ask(w1, { to: 'owner', body: 'owner only' });
  const res = await w2(`/api/questions/${q.id}/answer`, post({ text: 'me!' }));
  assert.equal(res.status, 403);
});

test('withdraw by asker; others cannot', async () => {
  const q = await ask(w1, { to: 'owner', body: 'never mind' });
  assert.equal((await w2(`/api/questions/${q.id}/withdraw`, post({}))).status, 403);
  const res = await w1(`/api/questions/${q.id}/withdraw`, post({}));
  assert.equal((await res.json()).question.status, 'withdrawn');
});

test('options must have unique keys', async () => {
  const res = await w1('/api/questions', post({ to: 'owner', body: 'dup', options: [{ key: 'a', label: 'x' }, { key: 'a', label: 'y' }] }));
  assert.equal(res.status, 400);
});

test('list order: open blocking first', async () => {
  await ask(w1, { to: 'owner', body: 'not blocking' });
  const blocking = await ask(w1, { to: 'owner', body: 'blocking!', isBlocking: true });
  const res = await t.owner('/api/questions?status=open');
  const list = (await res.json()).questions as { id: number; isBlocking: boolean; status: string }[];
  assert.equal(list[0]?.id, blocking.id);
  assert.ok(list.every((q) => q.status === 'open'));
});
