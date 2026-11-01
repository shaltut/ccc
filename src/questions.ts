import type { Sql } from './db.ts';
import type postgres from 'postgres';
import { recordEvent } from './events.ts';
import { httpError } from './errors.ts';
import { sendMessage } from './messages.ts';
import { findSession, orchestratorHolder, resolveAddress } from './sessions.ts';
import { actorName, type Actor } from './actor.ts';

export type QuestionOption = { key: string; label: string };
export type QuestionStatus = 'open' | 'answered' | 'withdrawn';

export type Question = {
  id: number;
  askedBy: string;
  addressedTo: string;
  body: string;
  context: string | null;
  options: QuestionOption[] | null;
  isBlocking: boolean;
  status: QuestionStatus;
  answerChoice: string | null;
  answerText: string | null;
  answeredBy: string | null;
  answeredAt: Date | null;
  createdAt: Date;
};

const ROLE_ORCHESTRATOR = 'role:orchestrator';

async function getQuestion(sql: Sql, id: number): Promise<Question> {
  const [q] = await sql<Question[]>`select * from ccc.questions where id = ${id}`;
  if (!q) throw httpError(404, 'not_found', `No question Q${id}`);
  return q;
}

const event = (sql: Sql, actor: Actor, q: Question, type: string) =>
  recordEvent(sql, {
    actor: actorName(actor),
    type,
    payload: { questionId: q.id, askedBy: q.askedBy, addressedTo: q.addressedTo, isBlocking: q.isBlocking },
  });

export type NewQuestion = {
  to: string;
  body: string;
  context?: string | null;
  options?: QuestionOption[] | null;
  isBlocking?: boolean;
};

export async function askQuestion(sql: Sql, actor: Actor, n: NewQuestion): Promise<Question> {
  const target = n.to === 'owner' ? null : await resolveAddress(sql, n.to);
  const addressedTo = n.to === 'owner' ? 'owner' : n.to === 'orchestrator' ? ROLE_ORCHESTRATOR : n.to;
  const options = n.options?.length ? sql.json(n.options as postgres.JSONValue) : null;
  const [q] = await sql<Question[]>`
    insert into ccc.questions (asked_by, addressed_to, body, context, options, is_blocking)
    values (${actorName(actor)}, ${addressedTo}, ${n.body}, ${n.context ?? null}, ${options}, ${n.isBlocking ?? false})
    returning *`;
  if (!q) throw new Error('question insert returned no row');
  if (target) {
    const blocking = q.isBlocking ? ' (blocking)' : '';
    await sendMessage(sql, {
      from: actorName(actor),
      to: target,
      kind: 'question',
      body: `Question Q${q.id}${blocking} from ${q.askedBy}: ${q.body}`,
      refQuestionId: q.id,
    });
  }
  await event(sql, actor, q, 'question');
  return q;
}

async function canAnswer(sql: Sql, actor: Actor, q: Question): Promise<boolean> {
  if (actor.kind === 'owner') return true;
  const holder = await orchestratorHolder(sql);
  if (holder?.id === actor.session.id) return true;
  return q.addressedTo === actor.session.name;
}

function requireOpen(q: Question): void {
  if (q.status !== 'open') throw httpError(409, 'already_closed', `Q${q.id} is already ${q.status}`);
}

export async function answerQuestion(
  sql: Sql,
  actor: Actor,
  id: number,
  a: { choice?: string | null; text?: string | null },
): Promise<Question> {
  const q = await getQuestion(sql, id);
  if (!(await canAnswer(sql, actor, q))) throw httpError(403, 'forbidden', 'Not addressed to you');
  requireOpen(q);
  const choice = a.choice || null;
  const text = a.text?.trim() || null;
  if (!choice && !text) throw httpError(400, 'validation_error', 'Give a choice or an answer text');
  const option = choice ? q.options?.find((o) => o.key === choice) : undefined;
  if (choice && !option) throw httpError(400, 'invalid_choice', `"${choice}" is not one of the options`);

  const [answered] = await sql<Question[]>`
    update ccc.questions set status = 'answered', answer_choice = ${choice}, answer_text = ${text},
      answered_by = ${actorName(actor)}, answered_at = now()
    where id = ${id} and status = 'open' returning *`;
  if (!answered) throw httpError(409, 'already_closed', `Q${id} was closed meanwhile`);

  const asker = await findSession(sql, answered.askedBy);
  if (asker) {
    const parts = [option ? `[${option.label}]` : null, text].filter(Boolean).join(' ');
    await sendMessage(sql, { from: actorName(actor), to: asker, kind: 'answer', body: `Answer to Q${id}: ${parts}`, refQuestionId: id });
  }
  await event(sql, actor, answered, 'question_answered');
  return answered;
}

export async function withdrawQuestion(sql: Sql, actor: Actor, id: number): Promise<Question> {
  const q = await getQuestion(sql, id);
  if (actor.kind !== 'owner' && actor.session.name !== q.askedBy) throw httpError(403, 'forbidden', 'Only the asker');
  requireOpen(q);
  const [withdrawn] = await sql<Question[]>`
    update ccc.questions set status = 'withdrawn' where id = ${id} and status = 'open' returning *`;
  if (!withdrawn) throw httpError(409, 'already_closed', `Q${id} was closed meanwhile`);
  await event(sql, actor, withdrawn, 'question_withdrawn');
  return withdrawn;
}

/** Open first, blocking before non-blocking, oldest first; closed ones newest first. */
export async function listQuestions(sql: Sql, f: { status?: QuestionStatus; to?: string }): Promise<Question[]> {
  const to = f.to === 'orchestrator' ? ROLE_ORCHESTRATOR : f.to;
  return [
    ...(await sql<Question[]>`
      select * from ccc.questions
      where ${f.status ? sql`status = ${f.status}` : sql`true`}
        and ${to ? sql`addressed_to = ${to}` : sql`true`}
      order by status = 'open' desc, (status = 'open' and is_blocking) desc,
        case when status = 'open' then id end asc, id desc
      limit 500`),
  ];
}
