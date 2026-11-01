import type { Hono } from 'hono';
import { z } from 'zod';
import type { Sql } from './db.ts';
import type { AppEnv } from './actor.ts';
import { body } from './http.ts';
import { cancelTask, createTask, listTasks, reassignTask, TASK_STATUSES, updateTask } from './tasks.ts';
import { answerQuestion, askQuestion, listQuestions, withdrawQuestion } from './questions.ts';

const BODY = z.string().min(1).max(65536);
const OPTIONAL_TEXT = z.string().max(65536).nullish();
const address = z.string().min(1).max(64);
const id = (raw: string | undefined) => z.coerce.number().int().positive().parse(raw);

const optionsSchema = z
  .array(z.object({ key: z.string().min(1).max(32), label: z.string().min(1).max(200) }))
  .min(1)
  .max(8)
  .refine((opts) => new Set(opts.map((o) => o.key)).size === opts.length, 'Option keys must be unique');

/** Task and question routes, mounted on the authenticated /api router. */
export function mountWorkRoutes(api: Hono<AppEnv>, sql: Sql): void {
  api.get('/tasks', async (c) => {
    const f = z
      .object({ assignee: z.string().max(64).optional(), status: z.enum(TASK_STATUSES).optional() })
      .parse(c.req.query());
    return c.json({ tasks: await listTasks(sql, f) });
  });

  api.post('/tasks', async (c) => {
    const t = await body(c, z.object({ to: address, title: z.string().min(1).max(500), body: z.string().max(65536).optional() }));
    return c.json({ task: await createTask(sql, c.get('actor'), t) });
  });

  api.post('/tasks/:id', async (c) => {
    const u = await body(
      c,
      z.object({
        status: z.enum(['in_progress', 'blocked', 'done']).optional(),
        result: OPTIONAL_TEXT,
        blocker: OPTIONAL_TEXT,
      }),
    );
    const update = {
      ...(u.status ? { status: u.status } : {}),
      ...(u.result !== undefined ? { result: u.result } : {}),
      ...(u.blocker !== undefined ? { blocker: u.blocker } : {}),
    };
    return c.json({ task: await updateTask(sql, c.get('actor'), id(c.req.param('id')), update) });
  });

  api.post('/tasks/:id/assign', async (c) => {
    const { to } = await body(c, z.object({ to: address }));
    return c.json({ task: await reassignTask(sql, c.get('actor'), id(c.req.param('id')), to) });
  });

  api.post('/tasks/:id/cancel', async (c) => c.json({ task: await cancelTask(sql, c.get('actor'), id(c.req.param('id'))) }));

  api.get('/questions', async (c) => {
    const f = z
      .object({ status: z.enum(['open', 'answered', 'withdrawn']).optional(), to: z.string().max(64).optional() })
      .parse(c.req.query());
    return c.json({ questions: await listQuestions(sql, f) });
  });

  api.post('/questions', async (c) => {
    const q = await body(
      c,
      z.object({
        to: address,
        body: BODY,
        context: OPTIONAL_TEXT,
        options: optionsSchema.nullish(),
        isBlocking: z.boolean().optional(),
      }),
    );
    const question = await askQuestion(sql, c.get('actor'), {
      to: q.to,
      body: q.body,
      context: q.context ?? null,
      options: q.options ?? null,
      ...(q.isBlocking !== undefined ? { isBlocking: q.isBlocking } : {}),
    });
    return c.json({ question });
  });

  api.post('/questions/:id/answer', async (c) => {
    const a = await body(c, z.object({ choice: z.string().max(32).nullish(), text: OPTIONAL_TEXT }));
    return c.json({ question: await answerQuestion(sql, c.get('actor'), id(c.req.param('id')), a) });
  });

  api.post('/questions/:id/withdraw', async (c) =>
    c.json({ question: await withdrawQuestion(sql, c.get('actor'), id(c.req.param('id'))) }),
  );
}
