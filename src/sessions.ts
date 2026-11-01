import type { Sql } from './db.ts';

export const ROLES = ['orchestrator', 'worker', 'helper', 'auditor', 'other'] as const;
export type Role = (typeof ROLES)[number];
export const STATUSES = ['working', 'idle', 'waiting_permission', 'blocked', 'paused', 'unreachable', 'offline'] as const;
export type Status = (typeof STATUSES)[number];
export const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export type Session = {
  id: string;
  name: string;
  role: Role;
  deviceId: string | null;
  claudeSessionId: string | null;
  supersededClaudeSessionIds: string[];
  cwd: string | null;
  status: Status;
  workingOn: string | null;
  blocker: string | null;
  paused: boolean;
  lastHeartbeatAt: Date | null;
  lastActivityAt: Date | null;
  lastWaitAt: Date | null;
  lastPingAt: Date | null;
  retiredAt: Date | null;
  createdAt: Date;
};

const COLUMNS = `id, name, role, device_id, claude_session_id, superseded_claude_session_ids, cwd, status,
  working_on, blocker, paused, last_heartbeat_at, last_activity_at, last_wait_at, last_ping_at, retired_at, created_at`;

/** Creates the session as a worker if missing and un-retires it; safe under concurrent first calls. */
export async function ensureSession(sql: Sql, name: string, deviceId: string): Promise<Session> {
  await sql`insert into ccc.sessions (name, device_id) values (${name}, ${deviceId}) on conflict (name) do nothing`;
  const [session] = await sql<Session[]>`
    update ccc.sessions set retired_at = null where name = ${name} returning ${sql.unsafe(COLUMNS)}`;
  if (!session) throw new Error('session upsert returned no row');
  return session;
}
