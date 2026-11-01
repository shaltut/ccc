import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, post } from './helpers.ts';
import { setRole } from '../src/sessions.ts';

const t = await testApp();
after(() => t.sql.end());
const token = await t.newDevice('win');
type Named = { name: string };
const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const as = (name: string, project?: string) => t.agent(token, name, `c-${name}`, project);
const register = async (name: string, project?: string) =>
  (await json(await as(name, project)('/api/sessions/register', post({ claudeSessionId: `c-${name}` })))).body;

test('register takes X-CCC-Project on first registration only; old CLIs land in default', async () => {
  assert.equal((await register('I1', 'iHop')).session.project, 'ihop');
  assert.equal((await register('I1', 'kiosk')).session.project, 'ihop');
  assert.equal((await register('D1')).session.project, 'default');
  assert.equal((await register('B1', 'not valid!')).session.project, 'default');
});

test('first contact through any route creates the session in its project', async () => {
  const r = await json(await as('K1', 'kiosk')('/api/me'));
  assert.equal(r.status, 200);
  assert.equal(r.body.session.project, 'kiosk');
});

test('agents see only their project; the owner sees all or filters', async () => {
  await register('I2', 'ihop');
  const mine = await json(await as('I1')('/api/sessions?project=kiosk'));
  assert.deepEqual(mine.body.sessions.map((s: Named) => s.name).sort(), ['I1', 'I2']);
  const all = await json(await t.owner('/api/sessions'));
  assert.ok(all.body.sessions.some((s: Named) => s.name === 'K1'));
  const kiosk = await json(await t.owner('/api/sessions?project=KIOSK'));
  assert.deepEqual(kiosk.body.sessions.map((s: Named) => s.name), ['K1']);
  const projects = await json(await as('K1')('/api/projects'));
  assert.deepEqual(projects.body.projects.map((p: Named) => p.name), ['kiosk']);
  const ownerProjects = await json(await t.owner('/api/projects'));
  assert.deepEqual(ownerProjects.body.projects.map((p: Named) => p.name), ['default', 'ihop', 'kiosk']);
});

test('agents cannot message another project; orchestrator resolves per project', async () => {
  await setRole(t.sql, 'K1', 'orchestrator');
  const cross = await json(await as('I1')('/api/messages', post({ to: 'K1', body: 'hi' })));
  assert.equal(cross.status, 403);
  assert.equal(cross.body.error.code, 'other_project');
  const none = await json(await as('I1')('/api/messages', post({ to: 'orchestrator', body: 'hi' })));
  assert.equal(none.body.error.code, 'no_orchestrator');
  const owner = await json(await t.owner('/api/messages', post({ to: 'orchestrator', project: 'kiosk', body: 'hi' })));
  assert.equal(owner.status, 200);
  const ownerNoProject = await json(await t.owner('/api/messages', post({ to: 'orchestrator', body: 'hi' })));
  assert.equal(ownerNoProject.body.error.code, 'project_required');
});

test('only the owner moves a session; the name is normalised and checked', async () => {
  const r = await json(await t.owner('/api/admin/sessions/K1/project', post({ project: ' iHop ' })));
  assert.equal(r.status, 200);
  assert.equal(r.body.session.project, 'ihop');
  assert.equal(r.body.session.role, 'worker');
  assert.equal((await as('I1')('/api/admin/sessions/I2/project', post({ project: 'kiosk' }))).status, 403);
  assert.equal((await t.owner('/api/admin/sessions/I2/project', post({ project: 'no spaces' }))).status, 400);
});

test("broadcast and pause-all stay inside the orchestrator's project", async () => {
  await register('X1', 'xp');
  await register('X2', 'xp');
  await register('Y1', 'yp');
  await setRole(t.sql, 'X1', 'orchestrator');
  const b = await json(await as('X1')('/api/broadcast', post({ body: 'standup' })));
  assert.equal(b.body.count, 1);
  const p = await json(await as('X1')('/api/control', post({ target: 'all', action: 'pause' })));
  assert.equal(p.body.count, 1);
  const cross = await json(await as('X1')('/api/control', post({ target: 'Y1', action: 'pause' })));
  assert.equal(cross.body.error.code, 'other_project');
  assert.equal((await json(await as('Y1')('/api/inbox'))).body.messages.length, 0);

  const ownerYp = await json(await t.owner('/api/broadcast', post({ body: 'yp only', project: 'yp' })));
  assert.equal(ownerYp.body.count, 1);
  const live = (await json(await t.owner('/api/sessions'))).body.sessions.length;
  const ownerAll = await json(await t.owner('/api/broadcast', post({ body: 'everyone' })));
  assert.equal(ownerAll.body.count, live);
});
