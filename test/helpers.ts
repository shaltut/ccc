import { createSql, migrate, type Sql } from '../src/db.ts';

export const TEST_DATABASE_URL =
  process.env.CCC_TEST_DATABASE_URL ?? 'postgres://postgres:ccc@127.0.0.1:5544/ccc_test';

/** Fresh `ccc` schema with all migrations applied. */
export async function testSql(): Promise<Sql> {
  const sql = createSql(TEST_DATABASE_URL);
  await sql.unsafe('set client_min_messages = warning');
  await sql.unsafe('drop schema if exists ccc cascade');
  await migrate(sql);
  return sql;
}
