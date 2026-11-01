import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Sql } from './db.ts';
import type { Config } from './config.ts';

export type Device = { id: string; label: string; createdAt: Date; revokedAt: Date | null };

const COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();

export function hashToken(token: string): string {
  return sha256(token).toString('hex');
}

export async function createDevice(sql: Sql, label: string): Promise<{ device: Device; token: string }> {
  const token = `ccc_${randomBytes(32).toString('base64url')}`;
  const [device] = await sql<Device[]>`
    insert into ccc.devices (label, token_hash) values (${label}, ${hashToken(token)})
    returning id, label, created_at, revoked_at`;
  if (!device) throw new Error('device insert returned no row');
  return { device, token };
}

export async function listDevices(sql: Sql): Promise<Device[]> {
  return [...(await sql<Device[]>`select id, label, created_at, revoked_at from ccc.devices order by created_at`)];
}

export async function revokeDevice(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`update ccc.devices set revoked_at = now() where id = ${id} and revoked_at is null returning id`;
  return rows.length > 0;
}

export async function deviceFromBearer(sql: Sql, header: string | undefined): Promise<Device | null> {
  const match = /^Bearer (\S+)$/.exec(header ?? '');
  if (!match?.[1]) return null;
  const [device] = await sql<Device[]>`
    select id, label, created_at, revoked_at from ccc.devices
    where token_hash = ${hashToken(match[1])} and revoked_at is null`;
  return device ?? null;
}

const cookieKey = (config: Config): Buffer => sha256(`ccc-cookie:${config.adminPassword}`);

function sign(config: Config, exp: string): string {
  return createHmac('sha256', cookieKey(config)).update(exp).digest('base64url');
}

export function issueAdminCookie(config: Config, now = Date.now()): string {
  const exp = String(now + COOKIE_TTL_MS);
  return `${exp}.${sign(config, exp)}`;
}

export function verifyAdminCookie(config: Config, value: string | undefined, now = Date.now()): boolean {
  if (!value) return false;
  const [exp, mac] = value.split('.');
  if (!exp || !mac || !(Number(exp) > now)) return false;
  const expected = Buffer.from(sign(config, exp));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function checkPassword(config: Config, password: string): boolean {
  return timingSafeEqual(sha256(password), sha256(config.adminPassword));
}

/** ponytail: one global limit (single owner); per-IP limiting needs trusted proxy headers. */
export function createLoginLimiter(maxFailures = 10, windowMs = 15 * 60 * 1000) {
  let failures: number[] = [];
  const prune = (now: number) => {
    failures = failures.filter((t) => now - t < windowMs);
  };
  return {
    isLocked(now = Date.now()): boolean {
      prune(now);
      return failures.length >= maxFailures;
    },
    fail(now = Date.now()): void {
      prune(now);
      failures.push(now);
    },
  };
}
