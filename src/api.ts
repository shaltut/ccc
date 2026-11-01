import { Hono, type Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Sql } from './db.ts';
import type { Config } from './config.ts';
import {
  actorName,
  ADMIN_COOKIE,
  requireOrchestrator,
  requireOwner,
  requireSession,
  resolveActor,
  scopeProject,
  type AppEnv,
} from './actor.ts';
import { broadcast, control, formatForAgent, peekUnread, sendMessage, takeUnread, waitForUnread } from './messages.ts';
import {
  heartbeat,
  listSessions,
  registerSession,
  REPORTABLE_STATUSES,
  reportStatus,
  resumeContext,
  retireSession,
  ROLES,
  resolveAddress,
  SESSION_NAME,
  setRole,
} from './sessions.ts';
import {
  checkPassword,
  createDevice,
  createLoginLimiter,
  issueAdminCookie,
  listDevices,
  revokeDevice,
} from './auth.ts';
import { httpError } from './errors.ts';
import { bus, listEvents, type BusEvent } from './events.ts';
import { body } from './http.ts';
import { mountWorkRoutes } from './work-routes.ts';

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
    const { password } = await body(c, z.object({ password: z.string().max(1024) }));
    // Checked after the last await: parallel requests must each see the failures recorded so far.
    if (limiter.isLocked()) throw httpError(429, 'too_many_attempts', 'Too many failed logins; try again later');
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

  const text = (max: number) => z.string().max(max);
  const nameParam = (c: Context) => z.string().regex(SESSION_NAME).parse(c.req.param('name'));

  api.post('/sessions/register', async (c) => {
    const device = c.get('device');
    const name = c.get('sessionName');
    if (!device || !name) throw httpError(403, 'forbidden', 'Agent sessions only');
    const input = await body(
      c,
      z.object({
        claudeSessionId: text(200).nullish(),
        cwd: text(1024).nullish(),
        role: z.enum(ROLES).optional(),
      }),
    );
    const result = await registerSession(sql, {
      name,
      deviceId: device.id,
      claudeSessionId: input.claudeSessionId ?? c.get('claudeSessionId'),
      cwd: input.cwd ?? null,
      ...(input.role ? { role: input.role } : {}),
    });
    return c.json({ ...result, resume: await resumeContext(sql, result.session) });
  });

  api.get('/me', async (c) => {
    const { session } = requireSession(c.get('actor'));
    return c.json({ session, resume: await resumeContext(sql, session) });
  });

  api.post('/status', async (c) => {
    const { session } = requireSession(c.get('actor'));
    const r = await body(
      c,
      z.object({
        status: z.enum(REPORTABLE_STATUSES).optional(),
        workingOn: text(2000).nullish(),
        blocker: text(2000).nullish(),
      }),
    );
    const updated = await reportStatus(sql, session, {
      ...(r.status ? { status: r.status } : {}),
      ...(r.workingOn !== undefined ? { workingOn: r.workingOn } : {}),
      ...(r.blocker !== undefined ? { blocker: r.blocker } : {}),
    });
    return c.json({ session: updated });
  });

  api.post('/heartbeat', async (c) => {
    const { session } = requireSession(c.get('actor'));
    const { activity } = await body(c, z.object({ activity: z.boolean() }));
    await heartbeat(sql, session.id, { activity });
    return c.json({ ok: true });
  });

  api.get('/sessions', async (c) => c.json({ sessions: await listSessions(sql) }));

  const BODY = z.string().min(1).max(65536);
  const address = z.string().min(1).max(64);

  api.get('/inbox', async (c) => {
    const { session, claudeSessionId } = requireSession(c.get('actor'));
    const peek = c.req.query('peek') === '1';
    const messages = peek ? await peekUnread(sql, session.id) : await takeUnread(sql, session.id, { claudeSessionId });
    return c.json({ messages, text: formatForAgent(messages) });
  });

  api.post('/inbox/ack', async (c) => {
    const { session, claudeSessionId } = requireSession(c.get('actor'));
    const { ids } = await body(c, z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) }));
    const acked = await takeUnread(sql, session.id, { claudeSessionId, ids });
    return c.json({ acked: acked.map((m) => m.id) });
  });

  api.get('/inbox/wait', async (c) => {
    const { session, claudeSessionId } = requireSession(c.get('actor'));
    const timeoutMs = z.coerce.number().int().min(1000).max(30000).default(25000).parse(c.req.query('timeoutMs'));
    const messages = await waitForUnread(sql, session.id, timeoutMs, c.req.raw.signal, claudeSessionId);
    return messages.length ? c.json({ messages, text: formatForAgent(messages) }) : c.body(null, 204);
  });

  api.post('/messages', async (c) => {
    const actor = c.get('actor');
    const m = await body(c, z.object({ to: address, body: BODY, kind: z.enum(['note', 'instruction']).default('note') }));
    if (m.kind === 'instruction') requireOrchestrator(actor);
    const to = await resolveAddress(sql, m.to, scopeProject(actor));
    return c.json({ message: await sendMessage(sql, { from: actorName(actor), to, kind: m.kind, body: m.body }) });
  });

  api.post('/broadcast', async (c) => {
    const { body: text } = await body(c, z.object({ body: BODY }));
    return c.json({ count: await broadcast(sql, c.get('actor'), text) });
  });

  api.post('/control', async (c) => {
    const r = await body(c, z.object({ target: address, action: z.enum(['pause', 'resume']) }));
    return c.json({ count: await control(sql, c.get('actor'), r.target, r.action) });
  });

  api.post('/admin/sessions/:name/role', async (c) => {
    requireOwner(c.get('actor'));
    const { role } = await body(c, z.object({ role: z.enum(ROLES) }));
    return c.json({ session: await setRole(sql, nameParam(c), role) });
  });

  api.post('/admin/sessions/:name/retire', async (c) => {
    requireOwner(c.get('actor'));
    return c.json({ session: await retireSession(sql, nameParam(c)) });
  });

  api.get('/events', async (c) => {
    requireOwner(c.get('actor'));
    const q = z
      .object({ session: z.string().regex(SESSION_NAME).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(c.req.query());
    return c.json({ events: await listEvents(sql, { ...(q.session ? { sessionName: q.session } : {}), limit: q.limit }) });
  });

  api.get('/stream', (c) => {
    requireOwner(c.get('actor'));
    return streamSSE(c, async (stream) => {
      const onEvent = (e: BusEvent) => {
        void stream.writeSSE({ event: 'ccc', data: JSON.stringify({ type: e.type, sessionName: e.sessionName }) });
      };
      bus.on('event', onEvent);
      stream.onAbort(() => {
        bus.off('event', onEvent);
      });
      await stream.writeSSE({ event: 'ready', data: '{}' });
      // Comment pings keep reverse proxies from closing an idle stream.
      while (!stream.aborted) {
        await stream.sleep(25_000);
        if (!stream.aborted) await stream.write(': keepalive\n\n');
      }
      bus.off('event', onEvent);
    });
  });

  mountWorkRoutes(api, sql);

  return api;
}
