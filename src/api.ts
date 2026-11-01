import { Hono, type Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Sql } from './db.ts';
import type { Config } from './config.ts';
import { ADMIN_COOKIE, requireOwner, resolveActor, type AppEnv } from './actor.ts';
import {
  checkPassword,
  createDevice,
  createLoginLimiter,
  issueAdminCookie,
  listDevices,
  revokeDevice,
} from './auth.ts';
import { httpError } from './errors.ts';

export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw httpError(400, 'invalid_json', 'Request body must be JSON');
  }
  return schema.parse(raw);
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function apiRoutes(sql: Sql, config: Config): Hono<AppEnv> {
  const api = new Hono<AppEnv>();
  const limiter = createLoginLimiter();

  // JSON-only writes: with SameSite=Strict this keeps cross-site form posts out.
  api.use('*', async (c, next) => {
    if (MUTATING.has(c.req.method) && !(c.req.header('content-type') ?? '').startsWith('application/json')) {
      throw httpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
    }
    return next();
  });

  api.post('/admin/login', async (c) => {
    if (limiter.isLocked()) throw httpError(429, 'too_many_attempts', 'Too many failed logins; try again later');
    const { password } = await body(c, z.object({ password: z.string().max(1024) }));
    if (!checkPassword(config, password)) {
      limiter.fail();
      throw httpError(401, 'unauthorized', 'Wrong password');
    }
    setCookie(c, ADMIN_COOKIE, issueAdminCookie(config), {
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });
    return c.json({ ok: true });
  });

  api.post('/admin/logout', (c) => {
    deleteCookie(c, ADMIN_COOKIE, { path: '/', secure: true });
    return c.json({ ok: true });
  });

  api.use('*', resolveActor(sql, config));

  api.get('/admin/devices', async (c) => {
    requireOwner(c.get('actor'));
    return c.json({ devices: await listDevices(sql) });
  });

  api.post('/admin/devices', async (c) => {
    requireOwner(c.get('actor'));
    const { label } = await body(c, z.object({ label: z.string().trim().min(1).max(64) }));
    return c.json(await createDevice(sql, label));
  });

  api.post('/admin/devices/:id/revoke', async (c) => {
    requireOwner(c.get('actor'));
    const id = z.uuid().parse(c.req.param('id'));
    if (!(await revokeDevice(sql, id))) throw httpError(404, 'not_found', 'No active device with that id');
    return c.json({ ok: true });
  });

  api.get('/sessions', (c) => c.json({ sessions: [] }));

  return api;
}
