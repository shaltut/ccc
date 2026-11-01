import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import { ZodError } from 'zod';
import type { Sql } from './db.ts';
import type { Config } from './config.ts';
import type { AppEnv } from './actor.ts';
import { AppError } from './errors.ts';
import { apiRoutes } from './api.ts';

const ROOT = new URL('../', import.meta.url);
const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
};

async function fileResponse(path: string, contentType: string): Promise<Response | null> {
  try {
    return new Response(await readFile(new URL(path, ROOT)), { headers: { 'content-type': contentType } });
  } catch {
    return null;
  }
}

const notFound = () => Response.json({ error: { code: 'not_found', message: 'Not found' } }, { status: 404 });

export function createApp(sql: Sql, config: Config): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    }
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
      return c.json({ error: { code: 'validation_error', message: `${where}${issue?.message ?? 'Invalid input'}` } }, 400);
    }
    console.error('[ccc] unhandled error', err);
    return c.json({ error: { code: 'internal_error', message: 'Internal error' } }, 500);
  });
  app.notFound(() => notFound());

  app.get('/healthz', async (c) => {
    await sql`select 1`;
    return c.json({ ok: true });
  });

  app.get('/cli/ccc.mjs', async () => (await fileResponse('cli/ccc.mjs', CONTENT_TYPES.js!)) ?? notFound());

  app.route('/api', apiRoutes(sql, config));

  app.get('/', async () => (await fileResponse('public/index.html', CONTENT_TYPES.html!)) ?? notFound());
  app.get('/:file{[a-z0-9-]+\\.(?:js|css|html)}', async (c) => {
    const file = c.req.param('file');
    const ext = file.split('.').pop() ?? '';
    return (await fileResponse(`public/${file}`, CONTENT_TYPES[ext] ?? 'text/plain')) ?? notFound();
  });

  return app;
}
