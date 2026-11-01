import type { Sql } from './db.ts';
import { recordEvent } from './events.ts';
import { httpError } from './errors.ts';
import { sendMessage } from './messages.ts';
import { orchestratorHolder, resolveAddress, type Session } from './sessions.ts';
import { actorName, isOrchestrator, requireOrchestrator, type Actor } from './actor.ts';

export const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type AgentTaskStatus = 'in_progress' | 'blocked' | 'done';

export type Task = {
  id: number;
  title: string;
  body: string;
  assigneeId: string | null;
  assigneeName: string | null;
  createdBy: string;
  status: TaskStatus;
  blocker: string | null;
  result: string | null;
  createdAt: Date;
  updatedAt: Date;
};

async function getTask(sql: Sql, id: number): Promise<Task> {
  const [task] = await sql<Task[]>`
    select t.*, s.name as assignee_name from ccc.tasks t left join ccc.sessions s on s.id = t.assignee_id
    where t.id = ${id}`;
  if (!task) throw httpError(404, 'not_found', `No task T${id}`);
  return task;
}

async function assigneeSession(sql: Sql, task: Task): Promise<Session | null> {
  if (!task.assigneeId) return null;
  const [s] = await sql<Session[]>`select * from ccc.sessions where id = ${task.assigneeId}`;
  return s ?? null;
}

const event = (sql: Sql, actor: Actor, task: Task, type: string, payload: Record<string, unknown> = {}) =>
  recordEvent(sql, {
    sessionId: task.assigneeId,
    sessionName: task.assigneeName,
    actor: actorName(actor),
    type,
    payload: { taskId: task.id, title: task.title, status: task.status, ...payload },
  });

const taskMessage = (task: Task) => `Task T${task.id}: ${task.title}${task.body ? `\n\n${task.body}` : ''}`;

export async function createTask(sql: Sql, actor: Actor, t: { to: string; title: string; body?: string }): Promise<Task> {
  requireOrchestrator(actor);
  const to = await resolveAddress(sql, t.to);
  const [row] = await sql<{ id: number }[]>`
    insert into ccc.tasks (title, body, assignee_id, created_by)
    values (${t.title}, ${t.body ?? ''}, ${to.id}, ${actorName(actor)}) returning id`;
  const task = await getTask(sql, row!.id);
  await sendMessage(sql, { from: actorName(actor), to, kind: 'task', body: taskMessage(task), refTaskId: task.id });
  await event(sql, actor, task, 'task_created');
  return task;
}

function requireOpen(task: Task): void {
  if (task.status === 'done' || task.status === 'cancelled') {
    throw httpError(409, 'task_closed', `T${task.id} is already ${task.status}`);
  }
}

export async function reassignTask(sql: Sql, actor: Actor, id: number, toName: string): Promise<Task> {
  requireOrchestrator(actor);
  const before = await getTask(sql, id);
  requireOpen(before);
  const to = await resolveAddress(sql, toName);
  const previous = await assigneeSession(sql, before);
  await sql`update ccc.tasks set assignee_id = ${to.id}, status = 'open', updated_at = now() where id = ${id}`;
  const task = await getTask(sql, id);
  const from = actorName(actor);
  if (previous && previous.id !== to.id) {
    await sendMessage(sql, { from, to: previous, kind: 'note', body: `T${id} was moved to ${to.name}. Stop working on it.`, refTaskId: id });
  }
  await sendMessage(sql, { from, to, kind: 'task', body: taskMessage(task), refTaskId: id });
  await event(sql, actor, task, 'task_reassigned', { from: previous?.name ?? null });
  return task;
}

export async function cancelTask(sql: Sql, actor: Actor, id: number): Promise<Task> {
  requireOrchestrator(actor);
  requireOpen(await getTask(sql, id));
  await sql`update ccc.tasks set status = 'cancelled', updated_at = now() where id = ${id}`;
  const task = await getTask(sql, id);
  const assignee = await assigneeSession(sql, task);
  if (assignee) {
    await sendMessage(sql, { from: actorName(actor), to: assignee, kind: 'note', body: `T${id} was cancelled. Stop working on it.`, refTaskId: id });
  }
  await event(sql, actor, task, 'task_cancelled');
  return task;
}

export type TaskUpdate = { status?: AgentTaskStatus; result?: string | null; blocker?: string | null };

export async function updateTask(sql: Sql, actor: Actor, id: number, u: TaskUpdate): Promise<Task> {
  const before = await getTask(sql, id);
  const isAssignee = actor.kind === 'session' && actor.session.id === before.assigneeId;
  if (!isAssignee && !isOrchestrator(actor)) throw httpError(403, 'forbidden', 'Only the assignee or the orchestrator');
  requireOpen(before);
  await sql`
    update ccc.tasks set
      status = coalesce(${u.status ?? null}, status),
      result = ${u.result === undefined ? sql`result` : sql`${u.result}`},
      blocker = ${u.blocker === undefined ? sql`blocker` : sql`${u.blocker}`},
      updated_at = now()
    where id = ${id}`;
  const task = await getTask(sql, id);
  await event(sql, actor, task, 'task_updated');

  // Results and blockers go to the orchestrator (the hub), unless it made the change itself.
  if (u.status === 'done' || u.status === 'blocked') {
    const holder = await orchestratorHolder(sql);
    const self = actor.kind === 'session' && holder?.id === actor.session.id;
    if (holder && !self) {
      const detail = (u.status === 'done' ? task.result : task.blocker) ?? '(no detail)';
      await sendMessage(sql, {
        from: actorName(actor),
        to: holder,
        kind: 'note',
        body: `T${id} ${u.status} by ${actorName(actor)}: ${detail}`,
        refTaskId: id,
      });
    }
  }
  return task;
}

export async function listTasks(sql: Sql, f: { assignee?: string; status?: TaskStatus }): Promise<Task[]> {
  return [
    ...(await sql<Task[]>`
      select t.*, s.name as assignee_name from ccc.tasks t left join ccc.sessions s on s.id = t.assignee_id
      where ${f.assignee ? sql`s.name = ${f.assignee}` : sql`true`}
        and ${f.status ? sql`t.status = ${f.status}` : sql`true`}
      order by t.id desc limit 500`),
  ];
}
