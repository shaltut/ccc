import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, post } from './helpers.ts';
import { setRole } from '../src/sessions.ts';
import { runWatchdog } from '../src/watchdog.ts';

const t = await testApp();
after(() => t.sql.end());
const token = await t.newDevice('mac');
const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const as = (name: string, project?: string) => t.agent(token, name, `c-${name}`, project);
for (const [name, project] of [['IO', 'ihop'], ['IW', 'ihop'], ['KO', 'kiosk'], ['KW', 'kiosk']] as const) {
  await as(name, project)('/api/sessions/register', post({ claudeSessionId: `c-${name}` }));
}
await setRole(t.sql, 'IO', 'orchestrator');
await setRole(t.sql, 'KO', 'orchestrator');
type Msg = { body: string };
const inbox = async (name: string): Promise<Msg[]> => (await json(await as(name)('/api/inbox'))).body.messages;

test('an orchestrator assigns only inside its project, and the task records the project', async () => {
  const ok = await json(await as('IO')('/api/tasks', post({ to: 'IW', title: 'build' })));
  assert.equal(ok.body.task.project, 'ihop');
  const cross = await json(await as('IO')('/api/tasks', post({ to: 'KW', title: 'x' })));
  assert.equal(cross.body.error.code, 'other_project');
  const owner = await json(await t.owner('/api/tasks', post({ to: 'orchestrator', project: 'kiosk', title: 'plan' })));
  assert.equal(owner.body.task.project, 'kiosk');
  assert.equal(owner.body.task.assigneeName, 'KO');
});

test("a task result goes to that project's orchestrator only", async () => {
  await inbox('IO');
  await inbox('KO');
  const [task] = (await json(await as('IW')('/api/tasks'))).body.tasks;
  await as('IW')(`/api/tasks/${task.id}`, post({ status: 'done', result: 'shipped' }));
  assert.equal((await inbox('IO')).length, 1);
  assert.equal((await inbox('KO')).length, 0);
});

test('tasks are listed per project and guarded against other orchestrators', async () => {
  const koTasks = (await json(await as('KO')('/api/tasks?project=ihop'))).body.tasks as { project: string }[];
  assert.ok(koTasks.length > 0 && koTasks.every((x) => x.project === 'kiosk'));
  const open = await json(await as('IO')('/api/tasks', post({ to: 'IW', title: 'second' })));
  const id = open.body.task.id;
  assert.equal((await json(await as('KO')(`/api/tasks/${id}/cancel`, post({})))).body.error.code, 'other_project');
  assert.equal((await json(await as('KO')(`/api/tasks/${id}/assign`, post({ to: 'KW' })))).body.error.code, 'other_project');
  assert.equal((await json(await t.owner(`/api/tasks/${id}/assign`, post({ to: 'KW' })))).body.error.code, 'other_project');
  const ownerList = await json(await t.owner('/api/tasks?project=ihop'));
  assert.ok(ownerList.body.tasks.every((x: { project: string }) => x.project === 'ihop'));
});

test("questions to the orchestrator stay in the asker's project", async () => {
  await inbox('KO');
  const q = await json(await as('KW')('/api/questions', post({ to: 'orchestrator', body: 'which db?' })));
  assert.equal(q.body.question.project, 'kiosk');
  assert.equal((await inbox('KO')).length, 1);
  assert.equal((await json(await as('IW')('/api/questions'))).body.questions.length, 0);
  const id = q.body.question.id;
  assert.equal((await as('IO')(`/api/questions/${id}/answer`, post({ text: 'pg' }))).status, 403);
  assert.equal((await as('KO')(`/api/questions/${id}/answer`, post({ text: 'pg' }))).status, 200);
});

test("the watchdog tells the unreachable session's own orchestrator", async () => {
  await inbox('IO');
  await inbox('KO');
  await t.sql`update ccc.sessions set last_heartbeat_at = now() - interval '20 minutes' where name = 'KW'`;
  await runWatchdog(t.sql, new Date());
  assert.ok((await inbox('KO')).some((m) => m.body.includes('KW is unreachable')));
  assert.equal((await inbox('IO')).filter((m) => m.body.includes('unreachable')).length, 0);
});

test('agents get their own lists even with an empty or invalid ?project=', async () => {
  for (const q of ['', 'has%20space']) {
    const tasks = await json(await as('KW')(`/api/tasks?project=${q}`));
    assert.equal(tasks.status, 200);
    const questions = await json(await as('KW')(`/api/questions?project=${q}`));
    assert.equal(questions.status, 200);
  }
});
