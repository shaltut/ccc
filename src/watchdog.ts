import type { Sql } from './db.ts';
import { recordEvent } from './events.ts';
import { sendMessage } from './messages.ts';
import { orchestratorHolder, type Session } from './sessions.ts';

export const UNREACHABLE_AFTER_MIN = 15;
export const IDLE_PING_AFTER_MIN = 60;
export const PING_TEXT =
  'PING from CCC: no activity for over 1 hour. Report your status: what you are working on and what you are waiting on.';

const minutesBefore = (now: Date, m: number) => new Date(now.getTime() - m * 60_000);

/** One pass: mark silent sessions unreachable, ping idle ones (owner rule: even if only waiting). */
export async function runWatchdog(sql: Sql, now: Date): Promise<{ unreachable: string[]; pinged: string[] }> {
  const silentSince = minutesBefore(now, UNREACHABLE_AFTER_MIN);
  const unreachable = await sql<Session[]>`
    update ccc.sessions set status = 'unreachable'
    where retired_at is null and status not in ('offline', 'unreachable')
      and coalesce(last_heartbeat_at, created_at) < ${silentSince}
    returning *`;

  for (const s of unreachable) {
    await recordEvent(sql, { sessionId: s.id, sessionName: s.name, actor: 'system', type: 'unreachable' });
    const holder = await orchestratorHolder(sql, s.project);
    if (holder && holder.id !== s.id) {
      await sendMessage(sql, {
        from: 'system',
        to: holder,
        kind: 'note',
        body: `${s.name} is unreachable: no heartbeat for ${UNREACHABLE_AFTER_MIN} min. It needs a nudge in its terminal.`,
      });
    }
  }

  const idleSince = minutesBefore(now, IDLE_PING_AFTER_MIN);
  const idle = await sql<Session[]>`
    update ccc.sessions set last_ping_at = ${now}
    where retired_at is null and status <> 'offline' and not paused
      and coalesce(last_activity_at, created_at) < ${idleSince}
      and (last_ping_at is null or last_ping_at < ${idleSince})
    returning *`;
  for (const s of idle) {
    await sendMessage(sql, { from: 'system', to: s, kind: 'ping', body: PING_TEXT });
    await recordEvent(sql, { sessionId: s.id, sessionName: s.name, actor: 'system', type: 'idle_ping' });
  }

  return { unreachable: unreachable.map((s) => s.name).sort(), pinged: idle.map((s) => s.name).sort() };
}

export function startWatchdog(sql: Sql, intervalMs = 60_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runWatchdog(sql, new Date())
      .catch((err: unknown) => console.error('[ccc] watchdog pass failed', err))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return () => clearInterval(timer);
}
