import { createSql, migrate, type Sql } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import type { Config } from '../src/config.ts';

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

type Fetch = (path: string, init?: RequestInit) => Promise<Response>;

function withHeaders(init: RequestInit | undefined, extra: Record<string, string>): RequestInit {
  return { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...extra } };
}

export const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * App over a fresh schema, driven through app.request (no network).
 * Every call resets the shared `ccc` schema, so use one per test file (or only after the file's last use of the first).
 */
export async function testApp() {
  const sql = await testSql();
  const config: Config = {
    databaseUrl: TEST_DATABASE_URL,
    adminPassword: 'test-password-123',
    publicUrl: 'http://localhost',
    port: 0,
  };
  const app = createApp(sql, config);

  let cookie: string | null = null;
  const owner: Fetch = async (path, init) => {
    if (!cookie) {
      const res = await app.request('/api/admin/login', post({ password: config.adminPassword }));
      cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    }
    return app.request(path, withHeaders(init, { cookie }));
  };

  const agent =
    (token: string, name: string, claudeSessionId?: string): Fetch =>
    async (path, init) =>
      app.request(
        path,
        withHeaders(init, {
          authorization: `Bearer ${token}`,
          'x-ccc-session': name,
          ...(claudeSessionId ? { 'x-ccc-claude-session': claudeSessionId } : {}),
        }),
      );

  const newDevice = async (label: string): Promise<string> => {
    const res = await owner('/api/admin/devices', post({ label }));
    const body = (await res.json()) as { token: string };
    return body.token;
  };

  return { app, sql, config, owner, agent, newDevice };
}
