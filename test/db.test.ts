import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSql, migrate } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { testSql, TEST_DATABASE_URL } from './helpers.ts';

const sql = await testSql();
after(() => sql.end());

test('migrate applies every migration once', async () => {
  await sql.unsafe('drop schema if exists ccc cascade');
  assert.deepEqual(await migrate(sql), ['001_init.sql', '002_projects.sql']);
  assert.deepEqual(await migrate(sql), []);
});

test('two orchestrators rejected', async () => {
  await sql`insert into ccc.sessions (name, role) values ('o1', 'orchestrator')`;
  await assert.rejects(
    sql`insert into ccc.sessions (name, role) values ('o2', 'orchestrator')`,
    (e: unknown) => (e as { code?: string }).code === '23505',
  );
});

test('arabic round-trips', async () => {
  await sql`insert into ccc.devices (label, token_hash) values ('جهاز-١', 'h1')`;
  const [row] = await sql`select label from ccc.devices where token_hash = 'h1'`;
  assert.equal(row?.label, 'جهاز-١');
});

test('rows come back camelCase', async () => {
  const [row] = await sql`select token_hash from ccc.devices where token_hash = 'h1'`;
  assert.equal(row?.tokenHash, 'h1');
});

test('loadConfig names missing var', () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
});

test('loadConfig rejects short admin password', () => {
  assert.throws(
    () => loadConfig({ DATABASE_URL: TEST_DATABASE_URL, CCC_ADMIN_PASSWORD: 'short', CCC_PUBLIC_URL: 'http://x' }),
    /CCC_ADMIN_PASSWORD/,
  );
});

test('migrate is safe to run concurrently', async () => {
  await sql.unsafe('drop schema if exists ccc cascade');
  const other = createSql(TEST_DATABASE_URL);
  const results = await Promise.all([migrate(sql), migrate(other)]);
  await other.end();
  assert.deepEqual(results.flat(), ['001_init.sql', '002_projects.sql']);
});
