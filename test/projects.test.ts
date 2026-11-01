import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.ts';
import {
  ensureSession,
  listProjects,
  listSessions,
  moveSession,
  normalizeProject,
  orchestratorHolder,
  resolveAddress,
  resumeContext,
  setRole,
} from '../src/sessions.ts';

const t = await testApp();
after(() => t.sql.end());
await t.newDevice('vps');
const [dev] = await t.sql<{ id: string }[]>`select id from ccc.devices where label = 'vps'`;
const s = (name: string, project?: string) => ensureSession(t.sql, name, dev!.id, project);

test('normalizeProject trims, lower-cases, and falls back to default', () => {
  assert.equal(normalizeProject('iHop'), 'ihop');
  assert.equal(normalizeProject(' ihop '), 'ihop');
  assert.equal(normalizeProject('has space'), 'default');
  assert.equal(normalizeProject(''), 'default');
  assert.equal(normalizeProject(undefined), 'default');
  assert.equal(normalizeProject('x'.repeat(65)), 'default');
});

test('ensureSession sets the project only when it creates the name', async () => {
  assert.equal((await s('P1', 'ihop')).project, 'ihop');
  assert.equal((await s('P1', 'kiosk')).project, 'ihop');
  assert.equal((await s('P2')).project, 'default');
});

test('each project holds its own orchestrator', async () => {
  await s('IA', 'ihop');
  await s('IB', 'ihop');
  await s('KA', 'kiosk');
  await setRole(t.sql, 'IA', 'orchestrator');
  await setRole(t.sql, 'KA', 'orchestrator');
  assert.equal((await orchestratorHolder(t.sql, 'ihop'))?.name, 'IA');
  assert.equal((await orchestratorHolder(t.sql, 'kiosk'))?.name, 'KA');
  await setRole(t.sql, 'IB', 'orchestrator');
  assert.equal((await orchestratorHolder(t.sql, 'ihop'))?.name, 'IB');
  assert.equal((await orchestratorHolder(t.sql, 'kiosk'))?.name, 'KA');
});

test('resolveAddress stays inside the given project', async () => {
  assert.equal((await resolveAddress(t.sql, 'orchestrator', 'kiosk')).name, 'KA');
  await assert.rejects(resolveAddress(t.sql, 'IA', 'kiosk'), /is in project ihop/);
  assert.equal((await resolveAddress(t.sql, 'IA')).name, 'IA');
  await assert.rejects(resolveAddress(t.sql, 'orchestrator'), /which project/);
  await assert.rejects(resolveAddress(t.sql, 'orchestrator', 'nobody'), /No session holds the orchestrator role in project nobody/);
});

test('moving an orchestrator into a project that has one demotes it instead of failing', async () => {
  const moved = await moveSession(t.sql, 'IB', 'kiosk');
  assert.equal(moved.project, 'kiosk');
  assert.equal(moved.role, 'worker');
  assert.equal(await orchestratorHolder(t.sql, 'ihop'), null);
  assert.equal((await orchestratorHolder(t.sql, 'kiosk'))?.name, 'KA');
  assert.equal((await moveSession(t.sql, 'KA', 'kiosk')).role, 'orchestrator');
  await assert.rejects(moveSession(t.sql, 'ghost', 'kiosk'), /No session named ghost/);
});

test('listSessions and listProjects filter by project', async () => {
  assert.deepEqual((await listSessions(t.sql, 'kiosk')).map((x) => x.name).sort(), ['IB', 'KA']);
  const kiosk = (await listProjects(t.sql)).find((p) => p.name === 'kiosk');
  assert.deepEqual({ ...kiosk }, { name: 'kiosk', sessions: 2, orchestrator: 'KA', openTasks: 0, openQuestions: 0 });
  assert.deepEqual((await listProjects(t.sql, 'ihop')).map((p) => p.name), ['ihop']);
});

test('resume text names the project', async () => {
  assert.match(await resumeContext(t.sql, await s('KA')), /in project "kiosk"/);
});
