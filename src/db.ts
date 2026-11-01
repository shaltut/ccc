import { readdir, readFile } from 'node:fs/promises';
import postgres from 'postgres';

export type Sql = postgres.Sql;

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const MIGRATION_LOCK = 74280;

export function createSql(url: string): Sql {
  return postgres(url, { transform: postgres.camel, onnotice: () => {} });
}

/** Applies unapplied migrations in name order; returns the names applied. */
export async function migrate(sql: Sql): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  await sql.reserve().then(async (conn) => {
    try {
      await conn`select pg_advisory_lock(${MIGRATION_LOCK})`;
      await conn`create schema if not exists ccc`;
      await conn`create table if not exists ccc.schema_migrations (
        name text primary key, applied_at timestamptz not null default now())`;
      const done = new Set((await conn`select name from ccc.schema_migrations`).map((r) => String(r.name)));
      for (const file of files) {
        if (done.has(file)) continue;
        const body = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
        await conn.unsafe('begin');
        try {
          await conn.unsafe(body);
          await conn`insert into ccc.schema_migrations (name) values (${file})`;
          await conn.unsafe('commit');
        } catch (err) {
          await conn.unsafe('rollback');
          throw err;
        }
        applied.push(file);
      }
    } finally {
      await conn`select pg_advisory_unlock(${MIGRATION_LOCK})`;
      conn.release();
    }
  });
  return applied;
}
