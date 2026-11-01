import type { Sql } from './db.ts';
import { recordEvent } from './events.ts';
import { httpError } from './errors.ts';

export const ROLES = ['orchestrator', 'worker', 'helper', 'auditor', 'other'] as const;
export type Role = (typeof ROLES)[number];
export const STATUSES = ['working', 'idle', 'waiting_permission', 'blocked', 'paused', 'unreachable', 'offline'] as const;
export type Status = (typeof STATUSES)[number];
export const REPORTABLE_STATUSES = ['working', 'idle', 'blocked', 'waiting_permission', 'offline'] as const;
export type ReportableStatus = (typeof REPORTABLE_STATUSES)[number];
export const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const DEFAULT_PROJECT = 'default';

/** CCC_PROJECT as sent by agents: trimmed and lower-cased; anything invalid is 'default' (hooks fail open). */
export function normalizeProject(raw: string | null | undefined): string {
  const p = (raw ?? '').trim().toLowerCase();
  return SESSION_NAME.test(p) ? p : DEFAULT_PROJECT;
}

/** A holder active within this window keeps its name; a newcomer gets <name>-2. */
const ACTIVE_WINDOW = '2 minutes';
const MAX_SUFFIX = 9;

export type Session = {
  id: string;
  name: string;
  role: Role;
  deviceId: string | null;
  claudeSessionId: string | null;
  supersededClaudeSessionIds: string[];
  cwd: string | null;
  project: string;
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

export type SessionView = Session & {
  unread: number;
  pausePending: boolean;
  currentTask: { id: number; title: string } | null;
};

const COLUMNS = `id, name, role, device_id, claude_session_id, superseded_claude_session_ids, cwd, project, status,
  working_on, blocker, paused, last_heartbeat_at, last_activity_at, last_wait_at, last_ping_at, retired_at, created_at`;

function one<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}

/** Creates the session as a worker if missing and un-retires it; the project applies only on creation. */
export async function ensureSession(sql: Sql, name: string, deviceId: string, project: string = DEFAULT_PROJECT): Promise<Session> {
  await sql`
    insert into ccc.sessions (name, device_id, project) values (${name}, ${deviceId}, ${project})
    on conflict (name) do nothing`;
  return one(
    await sql<Session[]>`update ccc.sessions set retired_at = null where name = ${name} returning ${sql.unsafe(COLUMNS)}`,
    'ensureSession',
  );
}

/** The row this Claude process registered as: `name` itself or a `name-N` it was moved to (spec §6.2). */
export async function ownedName(sql: Sql, name: string, claudeSessionId: string): Promise<string> {
  const [row] = await sql<{ name: string }[]>`
    select name from ccc.sessions
    where claude_session_id = ${claudeSessionId} and name = any(${candidates(name)})
    order by name = ${name} desc
    limit 1`;
  return row?.name ?? name;
}

export type RegisterInput = {
  name: string;
  deviceId: string;
  claudeSessionId: string | null;
  cwd: string | null;
  role?: Role;
  project?: string;
};

export type RegisterResult = { session: Session; assignedName: string; takeover: boolean };

function candidates(name: string): string[] {
  return [name, ...Array.from({ length: MAX_SUFFIX - 1 }, (_, i) => `${name}-${i + 2}`)].filter((n) => SESSION_NAME.test(n));
}

/** Spec §6.2: reattach, take over a stale holder, or move a concurrent newcomer to <name>-N. */
export async function registerSession(sql: Sql, input: RegisterInput): Promise<RegisterResult> {
  const deniedOrchestrator = input.role === 'orchestrator';
  const role: Role = deniedOrchestrator ? 'worker' : (input.role ?? 'worker');

  const result = await sql.begin(async (tx) => {
    for (const name of candidates(input.name)) {
      await tx`select pg_advisory_xact_lock(hashtext(${name}))`;
      const [existing] = await tx<(Session & { isActive: boolean })[]>`
        select ${tx.unsafe(COLUMNS)},
          (last_activity_at > now() - ${ACTIVE_WINDOW}::interval and status <> 'offline') as is_active
        from ccc.sessions where name = ${name}`;

      if (!existing) {
        const session = one(
          await tx<Session[]>`
            insert into ccc.sessions (name, role, device_id, claude_session_id, cwd, project, last_heartbeat_at, last_activity_at)
            values (${name}, ${role}, ${input.deviceId}, ${input.claudeSessionId}, ${input.cwd},
              ${input.project ?? DEFAULT_PROJECT}, now(), now())
            returning ${tx.unsafe(COLUMNS)}`,
          'register insert',
        );
        return { session, assignedName: name, takeover: false };
      }

      const sameProcess =
        input.claudeSessionId === null ||
        existing.claudeSessionId === null ||
        existing.claudeSessionId === input.claudeSessionId;
      if (!sameProcess && existing.isActive) continue;

      const superseded = (
        sameProcess || existing.claudeSessionId === null
          ? existing.supersededClaudeSessionIds
          : [...existing.supersededClaudeSessionIds, existing.claudeSessionId]
      ).filter((id) => id !== input.claudeSessionId);
      const session = one(
        await tx<Session[]>`
          update ccc.sessions set
            device_id = ${input.deviceId},
            claude_session_id = coalesce(${input.claudeSessionId}, claude_session_id),
            superseded_claude_session_ids = ${superseded},
            cwd = coalesce(${input.cwd}, cwd),
            status = case when paused then 'paused' else 'idle' end,
            retired_at = null,
            last_heartbeat_at = now(),
            last_activity_at = now()
          where id = ${existing.id}
          returning ${tx.unsafe(COLUMNS)}`,
        'register update',
      );
      return { session, assignedName: name, takeover: !sameProcess };
    }
    throw httpError(409, 'name_exhausted', `All names ${input.name}..${input.name}-${MAX_SUFFIX} are in use`);
  });

  const { session } = result;
  if (deniedOrchestrator) {
    await recordEvent(sql, {
      sessionId: session.id,
      sessionName: session.name,
      actor: session.name,
      type: 'orchestrator_request_denied',
      payload: { message: 'Only the owner can grant the orchestrator role' },
    });
  }
  await recordEvent(sql, {
    sessionId: session.id,
    sessionName: session.name,
    actor: session.name,
    type: result.takeover ? 'takeover' : 'register',
    payload: { requestedName: input.name, assignedName: result.assignedName, cwd: input.cwd, project: session.project },
  });
  return result;
}

export function isSuperseded(session: Session, claudeSessionId: string | null): boolean {
  return claudeSessionId !== null && session.supersededClaudeSessionIds.includes(claudeSessionId);
}

export async function orchestratorHolder(sql: Sql, project: string): Promise<Session | null> {
  const [s] = await sql<Session[]>`
    select ${sql.unsafe(COLUMNS)} from ccc.sessions
    where role = 'orchestrator' and retired_at is null and project = ${project}`;
  return s ?? null;
}

export async function findSession(sql: Sql, name: string): Promise<Session | null> {
  const [s] = await sql<Session[]>`
    select ${sql.unsafe(COLUMNS)} from ccc.sessions where name = ${name} and retired_at is null`;
  return s ?? null;
}

/**
 * With `project` (an agent's own, or one the owner named): 'orchestrator' is that project's holder and a
 * name must belong to it. Without (owner): any live name; 'orchestrator' then needs a project.
 */
export async function resolveAddress(sql: Sql, to: string, project?: string): Promise<Session> {
  if (to === 'orchestrator') {
    if (!project) throw httpError(400, 'project_required', 'Say which project: each project has its own orchestrator');
    const holder = await orchestratorHolder(sql, project);
    if (!holder) throw httpError(409, 'no_orchestrator', `No session holds the orchestrator role in project ${project}`);
    return holder;
  }
  const s = await findSession(sql, to);
  if (!s) throw httpError(404, 'unknown_session', `No session named ${to}`);
  if (project && s.project !== project) throw httpError(403, 'other_project', `${to} is in project ${s.project}`);
  return s;
}

export type StatusReport = { status?: ReportableStatus; workingOn?: string | null; blocker?: string | null };

export async function reportStatus(sql: Sql, session: Session, r: StatusReport): Promise<Session> {
  const status = r.status ?? null;
  const updated = one(
    await sql<Session[]>`
      update ccc.sessions set
        status = case
          when ${status}::text is null then status
          when paused and ${status}::text in ('working', 'idle') then 'paused'
          else ${status}::text end,
        working_on = ${r.workingOn === undefined ? sql`working_on` : sql`${r.workingOn}`},
        blocker = ${
          r.blocker !== undefined
            ? sql`${r.blocker}`
            : sql`case when status = 'waiting_permission' and ${status}::text is not null
                    and ${status}::text <> 'waiting_permission' then null else blocker end`
        },
        last_heartbeat_at = now(),
        last_activity_at = case when ${status}::text = 'offline' then last_activity_at else now() end
      where id = ${session.id}
      returning ${sql.unsafe(COLUMNS)}`,
    'reportStatus',
  );
  await recordEvent(sql, {
    sessionId: updated.id,
    sessionName: updated.name,
    actor: updated.name,
    type: 'status',
    payload: { status: updated.status, workingOn: updated.workingOn, blocker: updated.blocker },
  });
  return updated;
}

/** activity=true: hooks/tool calls. activity=false: a running `ccc wait` (reachable, not active). */
export async function heartbeat(sql: Sql, sessionId: string, h: { activity: boolean }): Promise<void> {
  if (h.activity) {
    await sql`
      update ccc.sessions set
        status = case when paused then 'paused' else 'working' end,
        blocker = case when status = 'waiting_permission' then null else blocker end,
        last_heartbeat_at = now(), last_activity_at = now()
      where id = ${sessionId}`;
    return;
  }
  await sql`
    update ccc.sessions set
      status = case when status = 'unreachable' then (case when paused then 'paused' else 'idle' end) else status end,
      last_heartbeat_at = now()
    where id = ${sessionId}`;
}

export async function setRole(sql: Sql, name: string, role: Role): Promise<Session> {
  const session = await sql.begin(async (tx) => {
    if (role === 'orchestrator') {
      await tx`
        update ccc.sessions set role = 'worker'
        where role = 'orchestrator' and name <> ${name}
          and project = (select project from ccc.sessions where name = ${name})`;
    }
    const [s] = await tx<Session[]>`
      update ccc.sessions set role = ${role} where name = ${name} and retired_at is null
      returning ${tx.unsafe(COLUMNS)}`;
    if (!s) throw httpError(404, 'unknown_session', `No session named ${name}`);
    return s;
  });
  await recordEvent(sql, { sessionId: session.id, sessionName: session.name, actor: 'owner', type: 'role', payload: { role } });
  return session;
}

export async function retireSession(sql: Sql, name: string): Promise<Session> {
  const [s] = await sql<Session[]>`
    update ccc.sessions set retired_at = now(), status = 'offline',
      role = case when role = 'orchestrator' then 'worker' else role end
    where name = ${name} and retired_at is null
    returning ${sql.unsafe(COLUMNS)}`;
  if (!s) throw httpError(404, 'unknown_session', `No session named ${name}`);
  await recordEvent(sql, { sessionId: s.id, sessionName: s.name, actor: 'owner', type: 'retire' });
  return s;
}

/** Owner only. An orchestrator moving to another project becomes a worker there (one per project). */
export async function moveSession(sql: Sql, name: string, project: string): Promise<Session> {
  // SET expressions see the old row, so `project <> ${project}` compares against where it was.
  const [s] = await sql<Session[]>`
    update ccc.sessions set
      role = case when role = 'orchestrator' and project <> ${project} then 'worker' else role end,
      project = ${project}
    where name = ${name} and retired_at is null
    returning ${sql.unsafe(COLUMNS)}`;
  if (!s) throw httpError(404, 'unknown_session', `No session named ${name}`);
  await recordEvent(sql, { sessionId: s.id, sessionName: s.name, actor: 'owner', type: 'project', payload: { project } });
  return s;
}

export async function listSessions(sql: Sql, project?: string): Promise<SessionView[]> {
  const rows = await sql<(Session & { unread: number; pausePending: boolean; taskId: number | null; taskTitle: string | null })[]>`
    select ${sql.unsafe(COLUMNS.replace(/(\w+)/g, 's.$1'))},
      (select count(*) from ccc.messages m where m.to_session_id = s.id and m.read_at is null) as unread,
      exists (select 1 from ccc.messages m where m.to_session_id = s.id and m.read_at is null
        and m.kind = 'control' and m.control_action = 'pause') as pause_pending,
      t.id as task_id, t.title as task_title
    from ccc.sessions s
    left join lateral (select id, title from ccc.tasks where assignee_id = s.id and status = 'in_progress'
      order by updated_at desc limit 1) t on true
    where s.retired_at is null and ${project ? sql`s.project = ${project}` : sql`true`}
    order by s.project, s.role = 'orchestrator' desc, s.name`;
  return rows.map(({ taskId, taskTitle, ...s }) => ({
    ...s,
    currentTask: taskId === null ? null : { id: taskId, title: taskTitle ?? '' },
  }));
}

export type ProjectSummary = { name: string; sessions: number; orchestrator: string | null; openTasks: number; openQuestions: number };

/** Projects exist while something references them: a live session, an open task or an open question. */
export async function listProjects(sql: Sql, project?: string): Promise<ProjectSummary[]> {
  return [
    ...(await sql<ProjectSummary[]>`
      with names as (
        select project from ccc.sessions where retired_at is null
        union select project from ccc.tasks where status in ('open', 'in_progress', 'blocked')
        union select project from ccc.questions where status = 'open'
      )
      select n.project as name,
        (select count(*) from ccc.sessions s where s.project = n.project and s.retired_at is null) as sessions,
        (select s.name from ccc.sessions s
          where s.project = n.project and s.role = 'orchestrator' and s.retired_at is null) as orchestrator,
        (select count(*) from ccc.tasks t
          where t.project = n.project and t.status in ('open', 'in_progress', 'blocked')) as open_tasks,
        (select count(*) from ccc.questions q where q.project = n.project and q.status = 'open') as open_questions
      from names n
      where ${project ? sql`n.project = ${project}` : sql`true`}
      order by n.project`),
  ];
}

const STANDING_RULES = [
  'While idle, keep "ccc wait" running in the background so messages can wake you.',
  'Report what you are working on with report_status or "ccc status".',
  'Send results and findings to the orchestrator.',
];

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function resumeContext(sql: Sql, session: Session): Promise<string> {
  const tasks = await sql<{ id: number; status: string; title: string }[]>`
    select id, status, title from ccc.tasks
    where assignee_id = ${session.id} and status in ('open', 'in_progress', 'blocked')
    order by id limit 8`;
  const [{ unread } = { unread: 0 }] = await sql<{ unread: number }[]>`
    select count(*) as unread from ccc.messages where to_session_id = ${session.id} and read_at is null`;
  const lines = [
    `CCC: you are session "${session.name}" in project "${session.project}" (role: ${session.role}). Unread messages: ${unread}.`,
    `Last reported work: ${session.workingOn ? clip(session.workingOn, 200) : 'nothing yet'}`,
    tasks.length ? 'Open tasks:' : 'Open tasks: none',
    ...tasks.map((t) => `- T${t.id} [${t.status}] ${clip(t.title, 80)}`),
    'Rules:',
    ...STANDING_RULES.map((r) => `- ${r}`),
  ];
  return lines.join('\n');
}
