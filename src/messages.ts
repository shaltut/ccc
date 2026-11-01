import { once } from 'node:events';
import type { Sql } from './db.ts';
import { bus, recordEvent } from './events.ts';
import { heartbeat, resolveAddress, type Session } from './sessions.ts';
import { actorName, requireOrchestrator, scopeProject, type Actor } from './actor.ts';

export const MESSAGE_KINDS = ['instruction', 'task', 'answer', 'question', 'control', 'note', 'ping'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type ControlAction = 'pause' | 'resume';

export const PAUSE_TEXT = 'PAUSE: finish the current step, then stop and wait for RESUME.';
export const RESUME_TEXT = 'RESUME: you may continue your work.';

export type Message = {
  id: number;
  fromName: string;
  toSessionId: string;
  kind: MessageKind;
  controlAction: ControlAction | null;
  body: string;
  refTaskId: number | null;
  refQuestionId: number | null;
  createdAt: Date;
  readAt: Date | null;
};

export type NewMessage = {
  from: string;
  to: Session;
  kind: MessageKind;
  body: string;
  refTaskId?: number;
  refQuestionId?: number;
  controlAction?: ControlAction;
};

const COLUMNS = `id, from_name, to_session_id, kind, control_action, body, ref_task_id, ref_question_id, created_at, read_at`;

export async function sendMessage(sql: Sql, m: NewMessage): Promise<Message> {
  const [message] = await sql<Message[]>`
    insert into ccc.messages (from_name, to_session_id, kind, control_action, body, ref_task_id, ref_question_id)
    values (${m.from}, ${m.to.id}, ${m.kind}, ${m.controlAction ?? null}, ${m.body},
      ${m.refTaskId ?? null}, ${m.refQuestionId ?? null})
    returning ${sql.unsafe(COLUMNS)}`;
  if (!message) throw new Error('message insert returned no row');
  await recordEvent(sql, {
    sessionId: m.to.id,
    sessionName: m.to.name,
    actor: m.from,
    type: 'message',
    payload: { messageId: message.id, kind: m.kind, from: m.from, to: m.to.name },
  });
  bus.emit(`inbox:${m.to.id}`);
  return message;
}

async function liveSessions(
  sql: Sql,
  opts: { excludeId: string | null; excludeOrchestrator: boolean; project: string | undefined },
): Promise<Session[]> {
  return [
    ...(await sql<Session[]>`
      select * from ccc.sessions
      where retired_at is null
        and ${opts.excludeId ? sql`id <> ${opts.excludeId}` : sql`true`}
        and ${opts.excludeOrchestrator ? sql`role <> 'orchestrator'` : sql`true`}
        and ${opts.project ? sql`project = ${opts.project}` : sql`true`}
      order by name`),
  ];
}

/** One `instruction` row per live session in scope (agents: their project; owner: `project` or all), sender excluded. */
export async function broadcast(sql: Sql, actor: Actor, body: string, project?: string): Promise<number> {
  requireOrchestrator(actor);
  const targets = await liveSessions(sql, {
    excludeId: actor.kind === 'session' ? actor.session.id : null,
    excludeOrchestrator: false,
    project: scopeProject(actor) ?? project,
  });
  for (const to of targets) await sendMessage(sql, { from: actorName(actor), to, kind: 'instruction', body });
  return targets.length;
}

/** 'all' targets every live non-orchestrator session in scope; anything else is an address in scope. */
export async function control(sql: Sql, actor: Actor, target: string, action: ControlAction, project?: string): Promise<number> {
  requireOrchestrator(actor);
  const scope = scopeProject(actor) ?? project;
  const targets =
    target === 'all'
      ? await liveSessions(sql, { excludeId: null, excludeOrchestrator: true, project: scope })
      : [await resolveAddress(sql, target, scope)];
  const body = action === 'pause' ? PAUSE_TEXT : RESUME_TEXT;
  for (const to of targets) {
    await sendMessage(sql, { from: actorName(actor), to, kind: 'control', controlAction: action, body });
  }
  return targets.length;
}

export async function peekUnread(sql: Sql, sessionId: string): Promise<Message[]> {
  return [
    ...(await sql<Message[]>`
      select ${sql.unsafe(COLUMNS)} from ccc.messages
      where to_session_id = ${sessionId} and read_at is null order by id`),
  ];
}

/** Delivers (marks read) every unread message; a delivered pause/resume flips the session's paused state. */
export type TakeOptions = {
  /** Refuse when this process has been superseded: a wait already in flight must not take the new holder's mail. */
  claudeSessionId?: string | null;
  /** Ack only these ids (peek-then-ack delivery). */
  ids?: number[];
};

export async function takeUnread(sql: Sql, sessionId: string, opts: TakeOptions = {}): Promise<Message[]> {
  return sql.begin(async (tx) => {
    const rows = await tx<Message[]>`
      update ccc.messages set read_at = now()
      where to_session_id = ${sessionId} and read_at is null
        ${opts.ids ? tx`and id = any(${opts.ids}::bigint[])` : tx``}
        ${
          opts.claudeSessionId
            ? tx`and not exists (select 1 from ccc.sessions s
                   where s.id = ${sessionId} and ${opts.claudeSessionId}::text = any(s.superseded_claude_session_ids))`
            : tx``
        }
      returning ${tx.unsafe(COLUMNS)}`;
    const messages = [...rows].sort((a, b) => a.id - b.id);
    const lastControl = messages.filter((m) => m.kind === 'control').at(-1)?.controlAction;
    if (lastControl === 'pause') {
      await tx`update ccc.sessions set paused = true, status = 'paused' where id = ${sessionId}`;
    } else if (lastControl === 'resume') {
      await tx`update ccc.sessions set paused = false,
        status = case when status = 'paused' then 'idle' else status end where id = ${sessionId}`;
    }
    return messages;
  });
}

/**
 * Long-poll: returns as soon as mail exists, [] on timeout/abort. Counts as a heartbeat
 * (the session is reachable) but not as activity.
 */
export async function waitForUnread(
  sql: Sql,
  sessionId: string,
  timeoutMs: number,
  signal?: AbortSignal,
  claudeSessionId: string | null = null,
): Promise<Message[]> {
  await heartbeat(sql, sessionId, { activity: false });
  await sql`update ccc.sessions set last_wait_at = now() where id = ${sessionId}`;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || signal?.aborted) return [];
    const stop = new AbortController();
    const signals = [stop.signal, AbortSignal.timeout(remaining), ...(signal ? [signal] : [])];
    // Listen before checking, so a message sent between the check and the listen still wakes us.
    const woke = once(bus, `inbox:${sessionId}`, { signal: AbortSignal.any(signals) }).then(
      () => true,
      () => false,
    );
    const messages = await takeUnread(sql, sessionId, { claudeSessionId });
    if (messages.length) {
      stop.abort();
      return messages;
    }
    if (!(await woke)) return [];
  }
}

export function formatForAgent(messages: Message[]): string {
  return messages.map((m) => `[#${m.id} ${m.kind} from ${m.fromName}]\n${m.body}`).join('\n\n');
}
