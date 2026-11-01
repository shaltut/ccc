import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Sql } from './db.ts';
import type { Config } from './config.ts';
import { deviceFromBearer, verifyAdminCookie, type Device } from './auth.ts';
import { ensureSession, SESSION_NAME, type Session } from './sessions.ts';
import { httpError } from './errors.ts';

export type Actor =
  | { kind: 'owner' }
  | { kind: 'session'; session: Session; deviceId: string; claudeSessionId: string | null };

export type AppEnv = {
  Variables: { actor: Actor; device: Device | null; sessionName: string | null; claudeSessionId: string | null };
};

export const ADMIN_COOKIE = 'ccc_admin';
export const REGISTER_PATH = '/api/sessions/register';

export const actorName = (a: Actor): string => (a.kind === 'owner' ? 'owner' : a.session.name);

/**
 * Owner via the admin cookie; agents via device bearer token + X-CCC-Session.
 * The register route gets only device + name: registerSession decides which row it lands on.
 */
export function resolveActor(sql: Sql, config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (verifyAdminCookie(config, getCookie(c, ADMIN_COOKIE))) {
      c.set('actor', { kind: 'owner' });
      return next();
    }
    const device = await deviceFromBearer(sql, c.req.header('authorization'));
    if (!device) throw httpError(401, 'unauthorized', 'Missing or invalid credentials');
    const name = c.req.header('x-ccc-session');
    if (!name) throw httpError(400, 'session_header_required', 'X-CCC-Session header is required');
    if (!SESSION_NAME.test(name)) throw httpError(400, 'validation_error', 'Invalid session name');
    const claudeSessionId = c.req.header('x-ccc-claude-session') ?? null;
    c.set('device', device);
    c.set('sessionName', name);
    c.set('claudeSessionId', claudeSessionId);
    if (c.req.path === REGISTER_PATH) return next();
    const session = await ensureSession(sql, name, device.id);
    c.set('actor', { kind: 'session', session, deviceId: device.id, claudeSessionId });
    return next();
  };
}

export function requireOwner(actor: Actor): void {
  if (actor.kind !== 'owner') throw httpError(403, 'forbidden', 'Owner only');
}

export function isOrchestrator(actor: Actor): boolean {
  return actor.kind === 'owner' || actor.session.role === 'orchestrator';
}

export function requireOrchestrator(actor: Actor): void {
  if (!isOrchestrator(actor)) throw httpError(403, 'forbidden', 'Orchestrator only');
}
