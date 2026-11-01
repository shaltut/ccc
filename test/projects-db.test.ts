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
