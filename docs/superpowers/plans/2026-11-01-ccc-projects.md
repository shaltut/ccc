# CCC Projects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sessions belong to a project (from `CCC_PROJECT`). Each project has its own orchestrator and its own team, and the owner sees all projects.

**Architecture:**
- A `project` text column on `sessions`, `tasks` and `questions`. There is no projects table.
- The domain functions get a *scope project*: the caller's own project for agents, an optional
  owner-chosen one for the owner. `orchestrator`, `all` and the lists resolve inside that scope.
- REST and MCP share the domain checks, so they agree.

**Tech Stack:** Node ≥ 22.18 (runs `.ts` directly), Hono, postgres.js 3.4.9 (camelCase transform), zod 4, `@modelcontextprotocol/sdk`, `node:test`, vanilla-JS UI.

**Spec:** `docs/superpowers/specs/2026-11-01-ccc-projects-design.md` (extends `docs/superpowers/specs/2026-11-01-ccc-design.md`).

## Global Constraints

- **Project name format:** `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`, trimmed and lower-cased on every input. The default project is `default`.
- **`CCC_PROJECT` handling:**
  - An invalid value falls back to `default`. Hooks never fail because of it.
  - It is applied only when a name is first created, and ignored afterwards.
- **Session names** stay globally unique.
- **Migrations:** never edit `migrations/001_init.sql`. Add `002_projects.sql`.
- **TypeScript:** erasable syntax only (no enums, namespaces or parameter properties). Imports use `.ts` extensions.
- **No new dependencies.** `cli/ccc.mjs` stays one file with zero dependencies.
- **UI:** never use `innerHTML` or its relatives. Build every node with `h()`. UI JS files stay ≤ 800 lines.
- **Hooks fail open:** exit 0 with no stdout within about 2.5 s when CCC is down.
- **Errors** use `{error:{code,message}}`. Cross-project addressing returns 403 `other_project`.
- **Tests:**
  - Write a failing test first.
  - `testApp()` resets the shared schema, so use one per test file.
  - Run the whole suite plus `npm run check` before calling it done, and quote the pass count.

## Review Focus

1. **Existing production rows** (real sessions with `project` null today) must land in `default` after the migration. Pinned in Task 1.
2. **Old CLI copies** send no `X-CCC-Project`. Their sessions must work in `default`, not error. Pinned in Task 3: register without the header.
3. **Mixed case or messy input** (`iHop`, ` ihop `, `has space`) must map to one project or to `default`, never a 400 from a hook path. Pinned in Tasks 2 and 3.
4. **A stale UI selection:** a project remembered in `localStorage` that no longer exists must fall back to "All" instead of showing an empty board forever. Pinned in Task 8.
5. **Moving an orchestrator into a project that already has one** must not hit the unique index (500). It drops to worker. Pinned in Task 2.

---

### Task 0: Test environment

**Files:** none (local setup only)

- [ ] **Step 1: Start the test Postgres and install deps**

```bash
cd /opt/ccc-src
sudo docker run -d --name ccc-test-pg -e POSTGRES_PASSWORD=ccc -e POSTGRES_DB=ccc_test -p 127.0.0.1:5544:5432 postgres:17-alpine
npm ci
```

- [ ] **Step 2: Baseline**

Run: `npm run check && npm test`
Expected: tsc clean; every test passes. Note the pass count (baseline).

---

### Task 1: Migration `002_projects.sql`

**Files:**
- Create: `migrations/002_projects.sql`
- Test: `test/projects-db.test.ts`

**Interfaces:**
- Produces: columns `ccc.sessions.project` (not null, default `'default'`, check `sessions_project_name`), `ccc.tasks.project`, `ccc.questions.project` (not null, default `'default'`); unique index `sessions_one_orchestrator` now on `(project)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/projects-db.test.ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSql, migrate } from '../src/db.ts';
import { TEST_DATABASE_URL } from './helpers.ts';

const sql = createSql(TEST_DATABASE_URL);
after(() => sql.end());

test('002 back-fills rows written before projects existed', async () => {
  await sql.unsafe('set client_min_messages = warning');
  await sql.unsafe('drop schema if exists ccc cascade');
  await sql.unsafe('create schema ccc');
  await sql.unsafe('create table ccc.schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  await sql.unsafe(await readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'));
  await sql`insert into ccc.schema_migrations (name) values ('001_init.sql')`;
  await sql`insert into ccc.sessions (name, role) values ('old', 'orchestrator')`;
  await sql`insert into ccc.tasks (title, created_by) values ('t', 'owner')`;
  await sql`insert into ccc.questions (asked_by, addressed_to, body) values ('old', 'owner', 'q')`;

  assert.deepEqual(await migrate(sql), ['002_projects.sql']);

  // postgres.js results are Array subclasses: compare plain values, not the Result objects.
  const projects = async (table: string) => (await sql.unsafe(`select project from ccc.${table}`)).map((r) => r.project);
  assert.deepEqual(await projects('sessions'), ['default']);
  assert.deepEqual(await projects('tasks'), ['default']);
  assert.deepEqual(await projects('questions'), ['default']);
});

test('one orchestrator per project, and project names are checked', async () => {
  await sql`insert into ccc.sessions (name, role, project) values ('o2', 'orchestrator', 'ihop')`;
  await assert.rejects(sql`insert into ccc.sessions (name, role) values ('o3', 'orchestrator')`, /sessions_one_orchestrator/);
  await assert.rejects(sql`insert into ccc.sessions (name, project) values ('bad', 'has space')`, /sessions_project_name/);
  const [row] = await sql`insert into ccc.sessions (name) values ('plain') returning project`;
  assert.equal(row?.project, 'default');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/projects-db.test.ts`
Expected: FAIL. `migrate` returns `[]`, not `['002_projects.sql']`.

- [ ] **Step 3: Write the migration**

```sql
-- migrations/002_projects.sql
-- Projects: every session, task and question belongs to one. Rows from before land in 'default'.
update ccc.sessions set project = 'default'
  where project is null or project !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$';
alter table ccc.sessions
  alter column project set default 'default',
  alter column project set not null,
  add constraint sessions_project_name check (project ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$');

alter table ccc.tasks add column project text not null default 'default';
alter table ccc.questions add column project text not null default 'default';

-- At most one live orchestrator per project.
drop index ccc.sessions_one_orchestrator;
create unique index sessions_one_orchestrator on ccc.sessions (project)
  where role = 'orchestrator' and retired_at is null;

create index tasks_project on ccc.tasks (project, id desc);
create index questions_project on ccc.questions (project);
```

- [ ] **Step 4: Run test to verify it passes, then the old db test**

Run: `node --test test/projects-db.test.ts test/db.test.ts`
Expected: PASS (db.test's one-orchestrator check still fails the second insert: both rows are in `default`).

- [ ] **Step 5: Commit**

```bash
git add migrations/002_projects.sql test/projects-db.test.ts
git commit -m "feat(projects): migration 002 adds project to sessions, tasks, questions"
```

---

### Task 2: Sessions domain is project-aware

**Files:**
- Modify: `src/sessions.ts` (`Session` type, `COLUMNS`, `ensureSession`, `RegisterInput`/`registerSession`, `orchestratorHolder`, `resolveAddress`, `setRole`, `listSessions`, `resumeContext`; add `DEFAULT_PROJECT`, `normalizeProject`, `moveSession`, `listProjects`, `ProjectSummary`)
- Modify: `test/sessions.test.ts:101,108` (`resolveAddress(t.sql, 'orchestrator')` → pass `'default'`)
- Test: `test/projects.test.ts`

**Interfaces:**
- Produces (exact):
  - `export const DEFAULT_PROJECT = 'default'`
  - `export function normalizeProject(raw: string | null | undefined): string`
  - `ensureSession(sql: Sql, name: string, deviceId: string, project?: string): Promise<Session>` (default `DEFAULT_PROJECT`)
  - `RegisterInput.project?: string`
  - `orchestratorHolder(sql: Sql, project: string): Promise<Session | null>`
  - `resolveAddress(sql: Sql, to: string, project?: string): Promise<Session>`. With `project`: `orchestrator` means that project's holder, and a name must be in that project (403 `other_project`). Without it (owner scope): any live name, while `orchestrator` gives 400 `project_required`.
  - `moveSession(sql: Sql, name: string, project: string): Promise<Session>`
  - `listSessions(sql: Sql, project?: string): Promise<SessionView[]>`
  - `type ProjectSummary = { name: string; sessions: number; orchestrator: string | null; openTasks: number; openQuestions: number }`
  - `listProjects(sql: Sql, project?: string): Promise<ProjectSummary[]>`
  - `Session.project: string`

- [ ] **Step 1: Write the failing test**

```ts
// test/projects.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/projects.test.ts`
Expected: FAIL with `normalizeProject` / `moveSession` / `listProjects` not exported (SyntaxError on import).

- [ ] **Step 3: Implement in `src/sessions.ts`**

After `export const SESSION_NAME = …` add:

```ts
export const DEFAULT_PROJECT = 'default';

/** CCC_PROJECT as sent by agents: trimmed and lower-cased; anything invalid is 'default' (hooks fail open). */
export function normalizeProject(raw: string | null | undefined): string {
  const p = (raw ?? '').trim().toLowerCase();
  return SESSION_NAME.test(p) ? p : DEFAULT_PROJECT;
}
```

In `type Session`, after `cwd: string | null;` add `project: string;`.
In `COLUMNS`, change `cwd, status,` to `cwd, project, status,`.

Replace `ensureSession`:

```ts
/** Creates the session as a worker if missing and un-retires it; the project applies only on creation. */
export async function ensureSession(sql: Sql, name: string, deviceId: string, project: string = DEFAULT_PROJECT): Promise<Session> {
  await sql`
    insert into ccc.sessions (name, device_id, project) values (${name}, ${deviceId}, ${project})
    on conflict (name) do nothing`;
  return one(
    await sql<Session[]>`update ccc.sessions set retired_at = null where name = ${name} returning ${sql.unsafe(COLUMNS)}`,
    'ensureSession',
  );
}
```

In `RegisterInput` add `project?: string;`. In `registerSession`'s insert branch replace the insert with:

```ts
            insert into ccc.sessions (name, role, device_id, claude_session_id, cwd, project, last_heartbeat_at, last_activity_at)
            values (${name}, ${role}, ${input.deviceId}, ${input.claudeSessionId}, ${input.cwd},
              ${input.project ?? DEFAULT_PROJECT}, now(), now())
```

(The update branch is unchanged: an existing name keeps its project.) In the final `register`/`takeover` event payload add `project: session.project`.

Replace `orchestratorHolder` and `resolveAddress`:

```ts
export async function orchestratorHolder(sql: Sql, project: string): Promise<Session | null> {
  const [s] = await sql<Session[]>`
    select ${sql.unsafe(COLUMNS)} from ccc.sessions
    where role = 'orchestrator' and retired_at is null and project = ${project}`;
  return s ?? null;
}

/**
 * With `project` (an agent's own, or one the owner named): 'orchestrator' is that project's holder and a
 * name must belong to it. Without (owner): any live name; 'orchestrator' then needs a project.
 */
export async function resolveAddress(sql: Sql, to: string, project?: string): Promise<Session> {
  if (to === 'orchestrator') {
    if (!project) throw httpError(400, 'project_required', 'Say which project: each project has its own orchestrator');
    const holder = await orchestratorHolder(sql, project);
    if (!holder) throw httpError(409, 'no_orchestrator', `No session holds the orchestrator role in project ${project}`);
    return holder;
  }
  const s = await findSession(sql, to);
  if (!s) throw httpError(404, 'unknown_session', `No session named ${to}`);
  if (project && s.project !== project) throw httpError(403, 'other_project', `${to} is in project ${s.project}`);
  return s;
}
```

In `setRole`, replace the demote statement with:

```ts
      await tx`
        update ccc.sessions set role = 'worker'
        where role = 'orchestrator' and name <> ${name}
          and project = (select project from ccc.sessions where name = ${name})`;
```

After `retireSession` add:

```ts
/** Owner only. An orchestrator moving to another project becomes a worker there (one per project). */
export async function moveSession(sql: Sql, name: string, project: string): Promise<Session> {
  // SET expressions see the old row, so `project <> ${project}` compares against where it was.
  const [s] = await sql<Session[]>`
    update ccc.sessions set
      role = case when role = 'orchestrator' and project <> ${project} then 'worker' else role end,
      project = ${project}
    where name = ${name} and retired_at is null
    returning ${sql.unsafe(COLUMNS)}`;
  if (!s) throw httpError(404, 'unknown_session', `No session named ${name}`);
  await recordEvent(sql, { sessionId: s.id, sessionName: s.name, actor: 'owner', type: 'project', payload: { project } });
  return s;
}
```

In `listSessions`, change the signature to `listSessions(sql: Sql, project?: string)` and the tail of the query to:

```ts
    where s.retired_at is null and ${project ? sql`s.project = ${project}` : sql`true`}
    order by s.project, s.role = 'orchestrator' desc, s.name`;
```

After `listSessions` add:

```ts
export type ProjectSummary = { name: string; sessions: number; orchestrator: string | null; openTasks: number; openQuestions: number };

/** Projects exist while something references them: a live session, an open task or an open question. */
export async function listProjects(sql: Sql, project?: string): Promise<ProjectSummary[]> {
  return [
    ...(await sql<ProjectSummary[]>`
      with names as (
        select project from ccc.sessions where retired_at is null
        union select project from ccc.tasks where status in ('open', 'in_progress', 'blocked')
        union select project from ccc.questions where status = 'open'
      )
      select n.project as name,
        (select count(*) from ccc.sessions s where s.project = n.project and s.retired_at is null) as sessions,
        (select s.name from ccc.sessions s
          where s.project = n.project and s.role = 'orchestrator' and s.retired_at is null) as orchestrator,
        (select count(*) from ccc.tasks t
          where t.project = n.project and t.status in ('open', 'in_progress', 'blocked')) as open_tasks,
        (select count(*) from ccc.questions q where q.project = n.project and q.status = 'open') as open_questions
      from names n
      where ${project ? sql`n.project = ${project}` : sql`true`}
      order by n.project`),
  ];
}
```

In `resumeContext`, change the first line to:

```ts
    `CCC: you are session "${session.name}" in project "${session.project}" (role: ${session.role}). Unread messages: ${unread}.`,
```

- [ ] **Step 4: Update the callers so `npm run check` passes**

`orchestratorHolder` now needs a project. Make these minimal edits (Task 5 refines them):
- `src/tasks.ts` `updateTask`: `orchestratorHolder(sql, task.project)`. Add `project: string;` to `type Task`.
- `src/questions.ts` `canAnswer`: `orchestratorHolder(sql, actor.session.project)`.
- `src/watchdog.ts`: move `const holder = await orchestratorHolder(sql, s.project);` inside the `for (const s of unreachable)` loop.
- `test/sessions.test.ts:101`: `resolveAddress(t.sql, 'orchestrator', 'default')`. `:108`: same.

- [ ] **Step 5: Run tests**

Run: `npm run check && node --test test/projects.test.ts test/sessions.test.ts test/watchdog.test.ts test/tasks.test.ts test/questions.test.ts`
Expected: tsc clean; PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sessions.ts src/tasks.ts src/questions.ts src/watchdog.ts test/projects.test.ts test/sessions.test.ts
git commit -m "feat(projects): project-aware sessions domain (orchestrator per project, move, list)"
```

---

### Task 3: Identity and API — header, register, lists, move, messages

**Files:**
- Modify: `src/http.ts` (add `PROJECT` schema)
- Modify: `src/actor.ts` (`AppEnv`, `resolveActor`, add `scopeProject`)
- Modify: `src/api.ts` (`/sessions/register`, `/sessions`, new `/projects`, new `/admin/sessions/:name/project`, `/messages`)
- Modify: `test/helpers.ts` (`agent()` gains `project?`)
- Test: `test/projects-api.test.ts`

**Interfaces:**
- Consumes: `normalizeProject`, `ensureSession(…, project)`, `RegisterInput.project`, `listSessions(sql, project?)`, `listProjects`, `moveSession`, `resolveAddress(sql, to, project?)` from Task 2.
- Produces:
  - `export const PROJECT` in `src/http.ts`: a zod string, trimmed, lower-cased, matching the name pattern.
  - `export function scopeProject(actor: Actor): string | undefined` in `src/actor.ts`. It returns the session's project for agents and `undefined` for the owner.
  - `AppEnv.Variables.project: string`.
  - Test helper `agent(token, name, claudeSessionId?, project?)`.

- [ ] **Step 1: Extend the test helper**

In `test/helpers.ts` replace the `agent` factory with:

```ts
  const agent =
    (token: string, name: string, claudeSessionId?: string, project?: string): Fetch =>
    async (path, init) =>
      app.request(
        path,
        withHeaders(init, {
          authorization: `Bearer ${token}`,
          'x-ccc-session': name,
          ...(claudeSessionId ? { 'x-ccc-claude-session': claudeSessionId } : {}),
          ...(project ? { 'x-ccc-project': project } : {}),
        }),
      );
```

- [ ] **Step 2: Write the failing test**

```ts
// test/projects-api.test.ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/projects-api.test.ts`
Expected: FAIL. The first test gets `project: 'default'` for `I1`, because the header is ignored.

- [ ] **Step 4: Implement**

`src/http.ts`. Change the type-only zod import to a value import and add the schema:

```ts
import { z } from 'zod';
import { SESSION_NAME } from './sessions.ts';
…
/** Owner-supplied project names: same pattern as session names, trimmed and lower-cased. */
export const PROJECT = z.string().trim().toLowerCase().regex(SESSION_NAME, 'Invalid project name');
```

(Keep `body`'s generic as `T extends z.ZodType`. The import change only matters for `PROJECT`.)

`src/actor.ts`:
- Import `normalizeProject` from `./sessions.ts`.
- Add `project: string` to `AppEnv.Variables`.
- In `resolveActor`, after `const claudeSessionId = …;` add:

```ts
    const project = normalizeProject(c.req.header('x-ccc-project'));
    c.set('project', project);
```

and change `ensureSession(sql, own, device.id)` to `ensureSession(sql, own, device.id, project)`. After `actorName` add:

```ts
/** The project an agent is confined to; undefined for the owner, who may name any project. */
export const scopeProject = (a: Actor): string | undefined => (a.kind === 'session' ? a.session.project : undefined);
```

`src/api.ts`:
- Import `PROJECT` from `./http.ts`, `scopeProject` from `./actor.ts`, and `listProjects` and `moveSession` from `./sessions.ts`.
- Inside `apiRoutes`, after `nameParam`:

```ts
  /** Agents are always confined to their own project; the owner may filter with ?project=. */
  const scoped = (c: Context<AppEnv>) => scopeProject(c.get('actor')) ?? PROJECT.optional().parse(c.req.query('project'));
```

- In `/sessions/register`'s `registerSession` call add `project: c.get('project'),`.
- Replace the `/sessions` route and add `/projects`:

```ts
  api.get('/sessions', async (c) => c.json({ sessions: await listSessions(sql, scoped(c)) }));
  api.get('/projects', async (c) => c.json({ projects: await listProjects(sql, scoped(c)) }));
```

- Replace `/messages`:

```ts
  api.post('/messages', async (c) => {
    const actor = c.get('actor');
    const m = await body(
      c,
      z.object({ to: address, body: BODY, kind: z.enum(['note', 'instruction']).default('note'), project: PROJECT.optional() }),
    );
    if (m.kind === 'instruction') requireOrchestrator(actor);
    const to = await resolveAddress(sql, m.to, scopeProject(actor) ?? m.project);
    return c.json({ message: await sendMessage(sql, { from: actorName(actor), to, kind: m.kind, body: m.body }) });
  });
```

- After the `/admin/sessions/:name/retire` route:

```ts
  api.post('/admin/sessions/:name/project', async (c) => {
    requireOwner(c.get('actor'));
    const { project } = await body(c, z.object({ project: PROJECT }));
    return c.json({ session: await moveSession(sql, nameParam(c), project) });
  });
```

- [ ] **Step 5: Run tests**

Run: `npm run check && node --test test/projects-api.test.ts test/sessions.test.ts test/messages.test.ts test/auth.test.ts`
Expected: tsc clean; PASS. If `http.ts` ↔ `sessions.ts` causes an import cycle at load time (`SESSION_NAME` undefined), move `PROJECT` into `src/sessions.ts` with its own `import { z } from 'zod'`, and import it from there instead.

- [ ] **Step 6: Commit**

```bash
git add src/http.ts src/actor.ts src/api.ts test/helpers.ts test/projects-api.test.ts
git commit -m "feat(projects): X-CCC-Project identity, scoped lists, /api/projects, owner move"
```

---

### Task 4: Broadcast and pause/resume stay inside a project

**Files:**
- Modify: `src/messages.ts` (`liveSessions`, `broadcast`, `control`)
- Modify: `src/api.ts` (`/broadcast`, `/control` bodies)
- Test: append to `test/projects-api.test.ts`

**Interfaces:**
- Consumes: `scopeProject` (Task 3), `resolveAddress(sql, to, project?)` (Task 2), `PROJECT` (Task 3).
- Produces: `broadcast(sql, actor, body, project?: string): Promise<number>`, `control(sql, actor, target, action, project?: string): Promise<number>`. Agents always use their own project; `project` matters only for the owner, and leaving it out means every project.

- [ ] **Step 1: Write the failing test (append)**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/projects-api.test.ts`
Expected: FAIL: `b.body.count` is the number of all live sessions, not 1.

- [ ] **Step 3: Implement in `src/messages.ts`**

Import `scopeProject` alongside `actorName` from `./actor.ts`. Replace `liveSessions`, `broadcast`, `control`:

```ts
async function liveSessions(
  sql: Sql,
  opts: { excludeId: string | null; excludeOrchestrator: boolean; project: string | undefined },
): Promise<Session[]> {
  return [
    ...(await sql<Session[]>`
      select * from ccc.sessions
      where retired_at is null
        and ${opts.excludeId ? sql`id <> ${opts.excludeId}` : sql`true`}
        and ${opts.excludeOrchestrator ? sql`role <> 'orchestrator'` : sql`true`}
        and ${opts.project ? sql`project = ${opts.project}` : sql`true`}
      order by name`),
  ];
}

/** One `instruction` row per live session in scope (agents: their project; owner: `project` or all), sender excluded. */
export async function broadcast(sql: Sql, actor: Actor, body: string, project?: string): Promise<number> {
  requireOrchestrator(actor);
  const targets = await liveSessions(sql, {
    excludeId: actor.kind === 'session' ? actor.session.id : null,
    excludeOrchestrator: false,
    project: scopeProject(actor) ?? project,
  });
  for (const to of targets) await sendMessage(sql, { from: actorName(actor), to, kind: 'instruction', body });
  return targets.length;
}

/** 'all' targets every live non-orchestrator session in scope; anything else is an address in scope. */
export async function control(sql: Sql, actor: Actor, target: string, action: ControlAction, project?: string): Promise<number> {
  requireOrchestrator(actor);
  const scope = scopeProject(actor) ?? project;
  const targets =
    target === 'all'
      ? await liveSessions(sql, { excludeId: null, excludeOrchestrator: true, project: scope })
      : [await resolveAddress(sql, target, scope)];
  const body = action === 'pause' ? PAUSE_TEXT : RESUME_TEXT;
  for (const to of targets) {
    await sendMessage(sql, { from: actorName(actor), to, kind: 'control', controlAction: action, body });
  }
  return targets.length;
}
```

In `src/api.ts` replace `/broadcast` and `/control`:

```ts
  api.post('/broadcast', async (c) => {
    const r = await body(c, z.object({ body: BODY, project: PROJECT.optional() }));
    return c.json({ count: await broadcast(sql, c.get('actor'), r.body, r.project) });
  });

  api.post('/control', async (c) => {
    const r = await body(c, z.object({ target: address, action: z.enum(['pause', 'resume']), project: PROJECT.optional() }));
    return c.json({ count: await control(sql, c.get('actor'), r.target, r.action, r.project) });
  });
```

- [ ] **Step 4: Run tests**

Run: `npm run check && node --test test/projects-api.test.ts test/messages.test.ts test/mcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/messages.ts src/api.ts test/projects-api.test.ts
git commit -m "feat(projects): broadcast and pause/resume are scoped to a project"
```

---

### Task 5: Tasks, questions and the watchdog follow the project

**Files:**
- Modify: `src/tasks.ts`, `src/questions.ts`, `src/watchdog.ts` (from the Task 2 minimal edit), `src/work-routes.ts`
- Test: `test/projects-work.test.ts`

**Interfaces:**
- Consumes: `scopeProject`, `PROJECT`, `resolveAddress(sql, to, project?)`, `orchestratorHolder(sql, project)`, `DEFAULT_PROJECT`.
- Produces:
  - `Task.project: string` and `Question.project: string` in the JSON responses.
  - `createTask(sql, actor, t: { to: string; title: string; body?: string; project?: string })`.
  - `listTasks(sql, f: { assignee?: string; status?: TaskStatus; project?: string | undefined })`.
  - `listQuestions(sql, f: { status?: QuestionStatus; to?: string; project?: string | undefined })`.

- [ ] **Step 1: Write the failing test**

```ts
// test/projects-work.test.ts
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
  assert.equal((await json(await as('KO')('/api/tasks?project=ihop'))).body.tasks.length, 0);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/projects-work.test.ts`
Expected: FAIL: `ok.body.task.project` is `'default'`, and the cross-project assign succeeds.

- [ ] **Step 3: Implement `src/tasks.ts`**

Import `scopeProject` from `./actor.ts`. `type Task` already has `project: string` from Task 2. Add after `requireOpen`:

```ts
/** An agent (orchestrator included) acts only on its own project's tasks. */
function requireTaskScope(actor: Actor, task: Task): void {
  if (actor.kind === 'session' && actor.session.project !== task.project) {
    throw httpError(403, 'other_project', `T${task.id} belongs to project ${task.project}`);
  }
}
```

`createTask`:

```ts
export async function createTask(
  sql: Sql,
  actor: Actor,
  t: { to: string; title: string; body?: string; project?: string },
): Promise<Task> {
  requireOrchestrator(actor);
  const to = await resolveAddress(sql, t.to, scopeProject(actor) ?? t.project);
  const [row] = await sql<{ id: number }[]>`
    insert into ccc.tasks (title, body, assignee_id, created_by, project)
    values (${t.title}, ${t.body ?? ''}, ${to.id}, ${actorName(actor)}, ${to.project}) returning id`;
```

(The rest of the function is unchanged.)

`reassignTask`: after `const before = await getTask(sql, id);` add `requireTaskScope(actor, before);`, and change the resolve to `const to = await resolveAddress(sql, toName, before.project);`. The task's project binds the owner too.

`cancelTask`: replace `requireOpen(await getTask(sql, id));` with:

```ts
  const before = await getTask(sql, id);
  requireTaskScope(actor, before);
  requireOpen(before);
```

`updateTask`: replace the permission line with:

```ts
  const inScope = actor.kind === 'owner' || actor.session.project === before.project;
  if (!isAssignee && !(isOrchestrator(actor) && inScope)) throw httpError(403, 'forbidden', 'Only the assignee or the orchestrator');
```

`listTasks`:

```ts
export async function listTasks(sql: Sql, f: { assignee?: string; status?: TaskStatus; project?: string | undefined }): Promise<Task[]> {
  return [
    ...(await sql<Task[]>`
      select t.*, s.name as assignee_name from ccc.tasks t left join ccc.sessions s on s.id = t.assignee_id
      where ${f.assignee ? sql`s.name = ${f.assignee}` : sql`true`}
        and ${f.status ? sql`t.status = ${f.status}` : sql`true`}
        and ${f.project ? sql`t.project = ${f.project}` : sql`true`}
      order by t.id desc limit 500`),
  ];
}
```

- [ ] **Step 4: Implement `src/questions.ts`**

Import `scopeProject` from `./actor.ts` and `DEFAULT_PROJECT` from `./sessions.ts`. Add `project: string;` to `type Question`. In `askQuestion` replace the first two lines and the insert:

```ts
  const scope = scopeProject(actor);
  const target = n.to === 'owner' ? null : await resolveAddress(sql, n.to, scope);
  const project = scope ?? target?.project ?? DEFAULT_PROJECT;
  const addressedTo = n.to === 'owner' ? 'owner' : n.to === 'orchestrator' ? ROLE_ORCHESTRATOR : n.to;
  const options = n.options?.length ? sql.json(n.options as postgres.JSONValue) : null;
  const [q] = await sql<Question[]>`
    insert into ccc.questions (asked_by, addressed_to, body, context, options, is_blocking, project)
    values (${actorName(actor)}, ${addressedTo}, ${n.body}, ${n.context ?? null}, ${options}, ${n.isBlocking ?? false}, ${project})
    returning *`;
```

Replace `canAnswer`:

```ts
async function canAnswer(sql: Sql, actor: Actor, q: Question): Promise<boolean> {
  if (actor.kind === 'owner') return true;
  if (actor.session.project !== q.project) return false;
  const holder = await orchestratorHolder(sql, q.project);
  if (holder?.id === actor.session.id) return true;
  return q.addressedTo === actor.session.name;
}
```

`listQuestions`: the signature becomes `f: { status?: QuestionStatus; to?: string; project?: string | undefined }`. Add this to the `where`:

```ts
        and ${f.project ? sql`project = ${f.project}` : sql`true`}
```

- [ ] **Step 5: Confirm `src/watchdog.ts`**

The loop must read:

```ts
  for (const s of unreachable) {
    await recordEvent(sql, { sessionId: s.id, sessionName: s.name, actor: 'system', type: 'unreachable' });
    const holder = await orchestratorHolder(sql, s.project);
    if (holder && holder.id !== s.id) {
```

(The old `const holder = await orchestratorHolder(sql);` above the loop is gone.)

- [ ] **Step 6: Implement `src/work-routes.ts`**

Import `PROJECT` from `./http.ts` and `scopeProject` from `./actor.ts`. Replace `GET /tasks`:

```ts
  api.get('/tasks', async (c) => {
    const f = z
      .object({ assignee: z.string().max(64).optional(), status: z.enum(TASK_STATUSES).optional(), project: PROJECT.optional() })
      .parse(c.req.query());
    return c.json({ tasks: await listTasks(sql, { ...f, project: scopeProject(c.get('actor')) ?? f.project }) });
  });
```

In `POST /tasks`, add `project: PROJECT.optional()` to the body schema. Pass `...(t.project ? { project: t.project } : {})` into `createTask`.

Replace `GET /questions`:

```ts
  api.get('/questions', async (c) => {
    const f = z
      .object({
        status: z.enum(['open', 'answered', 'withdrawn']).optional(),
        to: z.string().max(64).optional(),
        project: PROJECT.optional(),
      })
      .parse(c.req.query());
    return c.json({ questions: await listQuestions(sql, { ...f, project: scopeProject(c.get('actor')) ?? f.project }) });
  });
```

- [ ] **Step 7: Run tests**

Run: `npm run check && node --test test/projects-work.test.ts test/tasks.test.ts test/questions.test.ts test/watchdog.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/tasks.ts src/questions.ts src/watchdog.ts src/work-routes.ts test/projects-work.test.ts
git commit -m "feat(projects): tasks, questions and watchdog notes follow the project"
```

---

### Task 6: MCP tools are scoped

**Files:**
- Modify: `src/mcp.ts`
- Test: `test/mcp.test.ts` (append; it already creates `ORC` and `W1` in `default`)

**Interfaces:**
- Consumes: `listSessions(sql, project?)`, `resolveAddress(sql, to, project?)`, `listTasks`/`listQuestions` with `project`, and `ensureSession(…, project)`.

- [ ] **Step 1: Write the failing test (append to `test/mcp.test.ts`)**

```ts
test('MCP lists and sends only inside the caller project', async () => {
  await ensureSession(t.sql, 'OTHER', dev!.id, 'kiosk');
  const c = await connect('W1');
  const sessions = JSON.parse(text(await call(c, 'list_sessions'))) as { name: string }[];
  assert.ok(!sessions.some((s) => s.name === 'OTHER'));
  const cross = await call(c, 'send_message', { to: 'OTHER', body: 'hi' });
  assert.equal(cross.isError, true);
  assert.match(text(cross), /^other_project:/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mcp.test.ts`
Expected: FAIL. `OTHER` shows up in `list_sessions`.

- [ ] **Step 3: Implement in `src/mcp.ts`**

- `ADDRESS` description: `'Session name in your project, or "orchestrator" for your project\'s orchestrator'`.
- `send_message`: `to: await resolveAddress(sql, a.to, session.project)`.
- `list_sessions`: description `'Anyone: every live session in your project with status, current task and unread count.'`, body `toolResult(() => listSessions(sql, session.project))`.
- `list_tasks`: `listTasks(sql, { project: session.project, ...(a.assignee ? { assignee: a.assignee } : {}), ...(a.status ? { status: a.status } : {}) })`.
- `list_questions`: `listQuestions(sql, { project: session.project, ...(a.status ? { status: a.status } : {}), ...(a.to ? { to: a.to } : {}) })`.
- `broadcast` description: `'Orchestrator only: send an instruction to every live session in your project.'`
- `control` description: `'Orchestrator only: pause or resume a session or "all" in your project; lands when its current turn ends.'`

`assign_task`, `reassign_task`, `cancel_task`, `ask_question` and `answer_question` are already scoped by the domain (Task 5).

- [ ] **Step 4: Run tests**

Run: `npm run check && node --test test/mcp.test.ts`
Expected: PASS (the "lists all 15 tools" test is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/mcp.ts test/mcp.test.ts
git commit -m "feat(projects): MCP tools scoped to the caller's project"
```

---

### Task 7: CLI sends `CCC_PROJECT` and shows the project

**Files:**
- Modify: `cli/ccc.mjs` (header comment, `api()`, `cmdRegister`, `cmdStatus`, `cmdSessions`, `cmdMcpHeaders`, `USAGE`)
- Modify: `test/cli.test.ts` (`run()` also deletes `CCC_PROJECT`; new tests)

- [ ] **Step 1: Write the failing test**

In `test/cli.test.ts` `run()`, after `delete env.CCC_ROLE;` add `delete env.CCC_PROJECT;`. Append:

```ts
test('register sends CCC_PROJECT and prints the project; sessions shows it', async () => {
  const h = await home();
  const r = await run(['register'], { home: h, session: 'PJ1', env: { CCC_PROJECT: 'iHop' } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Registered as PJ1 in project ihop/);
  const list = await run(['sessions'], { home: h, session: 'PJ1', env: { CCC_PROJECT: 'ihop' } });
  assert.match(list.stdout, /PJ1\s+ihop\s+/);
});

test('session-start hook registers into CCC_PROJECT and still fails open', async () => {
  const h = await home();
  const r = await run(['hook', 'session-start'], { home: h, session: 'PJ2', input: hookInput({ session_id: 'pj2' }), env: { CCC_PROJECT: 'kiosk' } });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /in project "kiosk"/);
  const dead = await home('http://127.0.0.1:1');
  const d = await run(['hook', 'session-start'], { home: dead, session: 'PJ3', input: hookInput({ session_id: 'pj3' }), env: { CCC_PROJECT: 'kiosk' } });
  assert.equal(d.code, 0);
  assert.equal(d.stdout, '');
});

test('mcp-headers includes the project', async () => {
  const h = await home();
  const r = await run(['mcp-headers'], { home: h, session: 'PJ4', env: { CCC_PROJECT: 'kiosk' } });
  assert.equal(JSON.parse(r.stdout)['X-CCC-Project'], 'kiosk');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cli.test.ts`
Expected: FAIL on `/Registered as PJ1 in project ihop/`.

- [ ] **Step 3: Implement in `cli/ccc.mjs`**

Line 3 comment: `// Config: ~/.ccc/config.json {url, token} (written by \`ccc setup\`). Session name: env CCC_SESSION; project: env CCC_PROJECT.`

In `api()`, after `if (name) headers['x-ccc-session'] = name;`:

```js
  if (process.env.CCC_PROJECT) headers['x-ccc-project'] = process.env.CCC_PROJECT;
```

`cmdRegister` output:

```js
  out(`Registered as ${r.assignedName} in project ${r.session.project} (role ${r.session.role})${r.takeover ? ' — took over from an older process' : ''}`);
```

`cmdStatus` output:

```js
  out(`${r.session.name} [${r.session.project}]: ${r.session.status}${r.session.workingOn ? ` — ${r.session.workingOn}` : ''}`);
```

`cmdSessions` row:

```js
      .map((s) => `${s.name.padEnd(14)} ${String(s.project).padEnd(12)} ${s.role.padEnd(12)} ${s.status.padEnd(18)} ${s.workingOn ?? ''}${s.unread ? ` (${s.unread} unread)` : ''}`)
```

`cmdMcpHeaders`, after the `X-CCC-Session` line:

```js
  if (process.env.CCC_PROJECT) headers['X-CCC-Project'] = process.env.CCC_PROJECT;
```

`USAGE` register line:

```
  register [--role R]            register this session (name from CCC_SESSION, project from CCC_PROJECT)
```

- [ ] **Step 4: Run tests**

Run: `node --test test/cli.test.ts`
Expected: PASS, including the existing fail-open timing tests.

- [ ] **Step 5: Commit**

```bash
git add cli/ccc.mjs test/cli.test.ts
git commit -m "feat(projects): CLI and hooks send CCC_PROJECT; register/status/sessions show it"
```

---

### Task 8: Owner UI — project picker, chips, move, scoped controls

**Files:**
- Modify: `public/index.html` (header picker)
- Modify: `public/app.js` (state, `load`, `render`, `strip`, `renderDetail`, `taskRow`, `controlsView`, picker wiring)
- Modify: `public/style.css` (`.project`, `.project-pick`)
- Test: `test/ui.test.ts` (append)

- [ ] **Step 1: Write the failing test (append to `test/ui.test.ts`)**

```ts
test('project picker: remembered safely, falls back to All when its project is gone', async () => {
  const src = await readFile(new URL('app.js', PUBLIC), 'utf8');
  assert.match(src, /api\('GET', '\/api\/projects'\)/);
  assert.match(src, /try \{\s*return localStorage\.getItem\(PROJECT_KEY\)/);
  assert.match(src, /state\.project && !state\.projects\.some\(\(p\) => p\.name === state\.project\)/);
  assert.match(src, /\/project`, \{ project: /);
  const html = await readFile(new URL('index.html', PUBLIC), 'utf8');
  assert.match(html, /<select id="project"/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ui.test.ts`
Expected: FAIL on the first `assert.match`.

- [ ] **Step 3: `public/index.html`**

Between `</nav>` and `<span class="live" …>` insert:

```html
      <label class="project-pick">Project <select id="project" aria-label="Project"></select></label>
```

- [ ] **Step 4: `public/app.js`**

Replace the `state` line and add helpers just below it:

```js
const PROJECT_KEY = 'ccc.project';
function readProject() {
  try {
    return localStorage.getItem(PROJECT_KEY) ?? '';
  } catch {
    return '';
  }
}
function saveProject(p) {
  try {
    localStorage.setItem(PROJECT_KEY, p);
  } catch {}
}
const state = { tab: 'board', project: readProject(), projects: [], sessions: [], devices: [], questions: [], tasks: [], detail: null, newToken: null };
/** Adds ?project= when one project is selected; '' means all projects. */
const scoped = (path) => (state.project ? `${path}${path.includes('?') ? '&' : '?'}project=${encodeURIComponent(state.project)}` : path);
const inProject = () => (state.project ? { project: state.project } : {});
```

Replace `load()`:

```js
async function load() {
  const projects = await api('GET', '/api/projects');
  state.projects = projects.projects;
  // A remembered project with nothing left in it: show everything rather than an empty board.
  if (state.project && !state.projects.some((p) => p.name === state.project)) {
    state.project = '';
    saveProject('');
  }
  const [sessions, questions, tasks, devices] = await Promise.all([
    api('GET', scoped('/api/sessions')),
    api('GET', scoped('/api/questions')),
    api('GET', scoped('/api/tasks')),
    api('GET', '/api/admin/devices'),
  ]);
  state.sessions = sessions.sessions;
  state.questions = questions.questions;
  state.tasks = tasks.tasks;
  state.devices = devices.devices;
}
```

Add above `render()`:

```js
const projectPick = document.getElementById('project');

function renderProjectPicker() {
  mount(
    projectPick,
    h('option', { value: '', selected: state.project === '' }, 'All projects'),
    state.projects.map((p) => h('option', { value: p.name, selected: p.name === state.project }, `${p.name} (${p.sessions})`)),
  );
}
```

At the top of `render()`, add `renderProjectPicker();`.

After the tab-button `addEventListener` loop near the bottom, add:

```js
projectPick.addEventListener('change', () => {
  state.project = projectPick.value;
  saveProject(state.project);
  void refresh();
});
```

`strip(s)`: in `strip-head`, after the role span, add:

```js
        h('span', { class: 'project' }, s.project),
```

`renderDetail`: in `detail-head`, after `h('h2', { id: 'detail-title' }, s.name),` add:

```js
        h('span', { class: 'project' }, s.project),
```

`taskRow(t)`: change the meta line to:

```js
    h('div', { class: 'meta' }, `${state.project ? '' : `${t.project}, `}${t.assigneeName ?? 'unassigned'}, updated ${ago(t.updatedAt)}`),
```

`controlsView()` changes:
- The `Everyone` heading:

```js
      h('h2', null, state.project ? `Everyone in ${state.project}` : 'Everyone (all projects)'),
```

- Broadcast call: `api('POST', '/api/broadcast', { body: message.value, ...inProject() })`.
- Pause all: `api('POST', '/api/control', { target: 'all', action: 'pause', ...inProject() })`. Resume all: the same with `action: 'resume'`.
- In the Sessions panel's `liveSessions().map((s) => { … })`, after `const role = …;` add:

```js
              const move = h('input', { type: 'text', list: 'project-names', maxlength: 64, placeholder: s.project, 'aria-label': `Move ${s.name} to project` });
```

and in the row, after the `Set role` button:

```js
                h('button', {
                  type: 'button',
                  onclick: () => {
                    const project = move.value.trim();
                    if (project) void act(() => api('POST', `/api/admin/sessions/${encodeURIComponent(s.name)}/project`, { project }), `${s.name} moved to ${project.toLowerCase()}`);
                  },
                }, 'Move'),
```

- In the same panel, after `h('h2', null, 'Sessions'),` add:

```js
      h('datalist', { id: 'project-names' }, state.projects.map((p) => h('option', { value: p.name }))),
```

- [ ] **Step 5: `public/style.css` (append)**

```css
.project {
  padding: 0 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  font-size: 13px;
}

.project-pick {
  display: flex;
  gap: 6px;
  align-items: center;
  color: var(--muted);
  font-size: 14px;
}
```

- [ ] **Step 6: Run tests**

Run: `node --test test/ui.test.ts`
Expected: PASS (no `innerHTML`; `app.js` ≤ 800 lines; the draft-guard regexes are unchanged).

- [ ] **Step 7: Manual check**

Run `npm start` against the test DB, or test after deploy:
- The picker lists projects.
- Choosing one filters the board, questions and tasks.
- After a reload the choice is still selected.
- Moving a session updates its chip.

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/app.js public/style.css test/ui.test.ts
git commit -m "feat(projects): owner UI project picker, chips, move, scoped broadcast/pause"
```

---

### Task 9: Docs and full verification

**Files:**
- Modify: `README.md`, `docs/knowledge-base.md`, `docs/agent-prompts.md`, `docs/deploy.md`, `docs/use-cases.md`

- [ ] **Step 1: README.** In "Launching a named session", change the examples to:

```powershell
# Windows (PowerShell)
$env:CCC_PROJECT = 'ihop'; $env:CCC_SESSION = 'W1'; claude
```

```sh
# macOS / Linux
CCC_PROJECT=ihop CCC_SESSION=W1 claude
```

Then add after them:

> `CCC_PROJECT` puts the session in a project (lower-cased; default `default`). Each project has its own orchestrator; `orchestrator` and `all` mean "in my project". The project is set the first time a name registers; move a session later under **Controls → Sessions**.

- [ ] **Step 2: `docs/knowledge-base.md`.**
- §2 Identity table: add the row `| Project | \`X-CCC-Project\` header, from \`CCC_PROJECT\`; applied only when the name is created | \`src/actor.ts\`, \`src/sessions.ts\` |`.
- §6 Data: change the heading to `migrations/001_init.sql`, `002_projects.sql`, and add `project` to the `sessions`, `tasks` and `questions` rows.
- Add a new section after §3: "## Projects", containing the isolation table from spec §5 verbatim.

- [ ] **Step 3: `docs/agent-prompts.md`.** In "Before you paste" step 2, use the `CCC_PROJECT=… CCC_SESSION=…` launch lines from Step 1. Step 3 becomes "give that name the `orchestrator` role (one per project)".

- [ ] **Step 4: `docs/deploy.md`.** In the pass-through header list, add `X-CCC-Project`.

- [ ] **Step 5: `docs/use-cases.md`.** Add a use case:

> **Two projects at once.**
> 1. Launch `CCC_PROJECT=ihop CCC_SESSION=orch-ihop claude` and `CCC_PROJECT=kiosk CCC_SESSION=orch-kiosk claude`.
> 2. Grant each the orchestrator role.
> 3. Start workers with the matching `CCC_PROJECT`.
> 4. Use the header picker to watch one project, or **All**.

- [ ] **Step 6: Full verification**

Run: `npm run check && npm test`
Expected: tsc clean. All tests pass, with the count = baseline + the new tests. Quote the count.

- [ ] **Step 7: Commit**

```bash
git add README.md docs/
git commit -m "docs(projects): launch with CCC_PROJECT, isolation rules, headers"
```
