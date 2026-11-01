import { EventEmitter } from 'node:events';
import type { Sql } from './db.ts';
import type postgres from 'postgres';

export type BusEvent = { type: string; sessionId: string | null; sessionName: string | null };

/**
 * In-process bus: 'event' feeds the owner SSE stream, 'inbox:<sessionId>' wakes long-polls.
 * ponytail: single replica only; switch to LISTEN/NOTIFY if CCC ever runs more than one process.
 */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export type EventInput = {
  sessionId?: string | null;
  sessionName?: string | null;
  actor: string;
  type: string;
  payload?: Record<string, unknown>;
};

export async function recordEvent(sql: Sql, e: EventInput): Promise<void> {
  await sql`
    insert into ccc.events (session_id, actor, type, payload)
    values (${e.sessionId ?? null}, ${e.actor}, ${e.type}, ${sql.json((e.payload ?? {}) as postgres.JSONValue)})`;
  bus.emit('event', { type: e.type, sessionId: e.sessionId ?? null, sessionName: e.sessionName ?? null } satisfies BusEvent);
}

export type EventRow = {
  id: number;
  sessionName: string | null;
  actor: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
};

export async function listEvents(sql: Sql, q: { sessionName?: string; limit: number }): Promise<EventRow[]> {
  const rows = await sql<EventRow[]>`
    select e.id::int as id, s.name as session_name, e.actor, e.type, e.payload, e.created_at
    from ccc.events e left join ccc.sessions s on s.id = e.session_id
    where ${q.sessionName ? sql`s.name = ${q.sessionName}` : sql`true`}
    order by e.id desc limit ${q.limit}`;
  return [...rows];
}

