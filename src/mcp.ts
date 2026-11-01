import type { Context } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z, ZodError } from 'zod';
import type { Sql } from './db.ts';
import { AppError, httpError } from './errors.ts';
import { actorName, requireOrchestrator, requireSession, type Actor, type AppEnv } from './actor.ts';
import { listSessions, REPORTABLE_STATUSES, reportStatus, resolveAddress, resumeContext } from './sessions.ts';
import { broadcast, control, formatForAgent, sendMessage, takeUnread } from './messages.ts';
import { cancelTask, createTask, listTasks, reassignTask, TASK_STATUSES, updateTask } from './tasks.ts';
import { answerQuestion, askQuestion, listQuestions } from './questions.ts';
import { OPTIONS_SCHEMA } from './work-routes.ts';

const BODY = z.string().min(1).max(65536);
const TEXT = z.string().max(65536);
const ADDRESS = z.string().min(1).max(64).describe('Session name in your project, or "orchestrator" for your project\'s orchestrator');
const ID = z.number().int().positive();

async function toolResult(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await fn(), null, 2) }] };
  } catch (err) {
    if (err instanceof AppError) return { isError: true, content: [{ type: 'text', text: `${err.code}: ${err.message}` }] };
    if (err instanceof ZodError) {
      return { isError: true, content: [{ type: 'text', text: `validation_error: ${err.issues[0]?.message ?? 'invalid input'}` }] };
    }
    throw err;
  }
}

function buildServer(sql: Sql, actor: Extract<Actor, { kind: 'session' }>): McpServer {
  const server = new McpServer({ name: 'ccc', version: '0.1.0' });
  const { session } = actor;
  const tool = server.registerTool.bind(server);

  tool('whoami', { description: 'Anyone: your CCC identity, role, open tasks and standing rules.' }, () =>
    toolResult(async () => ({ session, resume: await resumeContext(sql, session) })),
  );
  tool(
    'report_status',
    {
      description: 'Anyone: report what you are working on, your state and any blocker (shown on the owner board).',
      inputSchema: { workingOn: TEXT.max(2000).optional(), status: z.enum(REPORTABLE_STATUSES).optional(), blocker: TEXT.max(2000).nullish() },
    },
    (a) =>
      toolResult(() =>
        reportStatus(sql, session, {
          ...(a.status ? { status: a.status } : {}),
          ...(a.workingOn !== undefined ? { workingOn: a.workingOn } : {}),
          ...(a.blocker !== undefined ? { blocker: a.blocker } : {}),
        }),
      ),
  );
  tool('get_inbox', { description: 'Anyone: fetch and mark read your unread CCC messages.' }, () =>
    toolResult(async () => {
      const messages = await takeUnread(sql, session.id, { claudeSessionId: actor.claudeSessionId });
      return { count: messages.length, text: formatForAgent(messages) };
    }),
  );
  tool(
    'send_message',
    {
      description: 'Anyone: send a note to a session. kind "instruction" is orchestrator only.',
      inputSchema: { to: ADDRESS, body: BODY, kind: z.enum(['note', 'instruction']).optional() },
    },
    (a) =>
      toolResult(async () => {
        const kind = a.kind ?? 'note';
        if (kind === 'instruction') requireOrchestrator(actor);
        return sendMessage(sql, { from: actorName(actor), to: await resolveAddress(sql, a.to, session.project), kind, body: a.body });
      }),
  );
  tool(
    'ask_question',
    {
      description: 'Anyone: ask the owner ("owner"), the orchestrator or a session; optional answer choices.',
      inputSchema: {
        to: z.string().min(1).max(64).describe('"owner", "orchestrator" or a session name'),
        body: BODY,
        context: TEXT.optional(),
        options: OPTIONS_SCHEMA.optional(),
        isBlocking: z.boolean().optional(),
      },
    },
    (a) =>
      toolResult(() =>
        askQuestion(sql, actor, {
          to: a.to,
          body: a.body,
          context: a.context ?? null,
          options: a.options ?? null,
          ...(a.isBlocking !== undefined ? { isBlocking: a.isBlocking } : {}),
        }),
      ),
  );
  tool(
    'answer_question',
    {
      description: 'Addressee or orchestrator: answer a question by id with a choice key and/or text.',
      inputSchema: { id: ID, choice: z.string().max(32).optional(), text: TEXT.optional() },
    },
    (a) => toolResult(() => answerQuestion(sql, actor, a.id, { choice: a.choice ?? null, text: a.text ?? null })),
  );
  tool('list_sessions', { description: 'Anyone: every live session in your project with status, current task and unread count.' }, () =>
    toolResult(() => listSessions(sql, session.project)),
  );
  tool(
    'list_tasks',
    {
      description: 'Anyone: list tasks, optionally by assignee name and status.',
      inputSchema: { assignee: z.string().max(64).optional(), status: z.enum(TASK_STATUSES).optional() },
    },
    (a) =>
      toolResult(() =>
        listTasks(sql, { project: session.project, ...(a.assignee ? { assignee: a.assignee } : {}), ...(a.status ? { status: a.status } : {}) }),
      ),
  );
  tool(
    'update_task',
    {
      description: 'Assignee or orchestrator: set a task in_progress, blocked (with blocker) or done (with result).',
      inputSchema: { id: ID, status: z.enum(['in_progress', 'blocked', 'done']).optional(), result: TEXT.optional(), blocker: TEXT.optional() },
    },
    (a) =>
      toolResult(() =>
        updateTask(sql, actor, a.id, {
          ...(a.status ? { status: a.status } : {}),
          ...(a.result !== undefined ? { result: a.result } : {}),
          ...(a.blocker !== undefined ? { blocker: a.blocker } : {}),
        }),
      ),
  );
  tool(
    'assign_task',
    {
      description: "Orchestrator only: create a task for a session and put it in that session's inbox.",
      inputSchema: { to: ADDRESS, title: z.string().min(1).max(500), body: TEXT.optional() },
    },
    (a) => toolResult(() => createTask(sql, actor, { to: a.to, title: a.title, ...(a.body ? { body: a.body } : {}) })),
  );
  tool(
    'reassign_task',
    { description: 'Orchestrator only: move a task to another session (both are told).', inputSchema: { id: ID, to: ADDRESS } },
    (a) => toolResult(() => reassignTask(sql, actor, a.id, a.to)),
  );
  tool('cancel_task', { description: 'Orchestrator only: cancel a task (the assignee is told).', inputSchema: { id: ID } }, (a) =>
    toolResult(() => cancelTask(sql, actor, a.id)),
  );
  tool('broadcast', { description: 'Orchestrator only: send an instruction to every live session in your project.', inputSchema: { body: BODY } }, (a) =>
    toolResult(async () => ({ count: await broadcast(sql, actor, a.body) })),
  );
  tool(
    'control',
    {
      description: 'Orchestrator only: pause or resume a session or "all" in your project; lands when its current turn ends.',
      inputSchema: { target: z.string().min(1).max(64), action: z.enum(['pause', 'resume']) },
    },
    (a) => toolResult(async () => ({ count: await control(sql, actor, a.target, a.action) })),
  );
  tool(
    'list_questions',
    {
      description: 'Anyone: list questions, optionally by status and addressee.',
      inputSchema: { status: z.enum(['open', 'answered', 'withdrawn']).optional(), to: z.string().max(64).optional() },
    },
    (a) =>
      toolResult(() =>
        listQuestions(sql, { project: session.project, ...(a.status ? { status: a.status } : {}), ...(a.to ? { to: a.to } : {}) }),
      ),
  );
  return server;
}

/** Stateless MCP over streamable HTTP: a fresh server per request, bound to the calling session. */
export function mcpHandler(sql: Sql) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    const actor = c.get('actor');
    if (actor.kind !== 'session') throw httpError(403, 'forbidden', 'MCP is for agent sessions');
    const server = buildServer(sql, requireSession(actor));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  };
}
