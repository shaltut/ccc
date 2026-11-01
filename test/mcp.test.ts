import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { testApp } from './helpers.ts';
import { ensureSession, setRole } from '../src/sessions.ts';

const t = await testApp();
const token = await t.newDevice('mac');
const [dev] = await t.sql<{ id: string }[]>`select id from ccc.devices`;
for (const n of ['ORC', 'W1']) await ensureSession(t.sql, n, dev!.id);
await setRole(t.sql, 'ORC', 'orchestrator');

const clients: Client[] = [];
after(async () => {
  for (const c of clients) await c.close();
  await t.sql.end();
});

async function connect(name: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL('http://ccc.test/mcp'), {
    requestInit: { headers: { authorization: `Bearer ${token}`, 'x-ccc-session': name } },
    fetch: (url, init) => Promise.resolve(t.app.request(String(url), init)),
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

type TextResult = { isError?: boolean; content: { type: string; text?: string }[] };
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) =>
  (await c.callTool({ name, arguments: args })) as TextResult;
const text = (r: TextResult) => r.content[0]?.text ?? '';

test('lists all 15 tools', async () => {
  const c = await connect('W1');
  const names = (await c.listTools()).tools.map((x) => x.name).sort();
  assert.deepEqual(names, [
    'answer_question',
    'ask_question',
    'assign_task',
    'broadcast',
    'cancel_task',
    'control',
    'get_inbox',
    'list_questions',
    'list_sessions',
    'list_tasks',
    'reassign_task',
    'report_status',
    'send_message',
    'update_task',
    'whoami',
  ]);
});

test('whoami returns the session and resume text', async () => {
  const c = await connect('W1');
  const r = await call(c, 'whoami');
  assert.match(text(r), /"name": "W1"/);
  assert.match(text(r), /ccc wait/);
});

test('worker assign_task returns isError forbidden', async () => {
  const c = await connect('W1');
  const r = await call(c, 'assign_task', { to: 'W1', title: 'self' });
  assert.equal(r.isError, true);
  assert.match(text(r), /^forbidden: /);
});

test('orchestrator assign_task → worker get_inbox returns it', async () => {
  const orc = await connect('ORC');
  const r = await call(orc, 'assign_task', { to: 'W1', title: 'via mcp', body: 'b' });
  assert.notEqual(r.isError, true);
  const w1 = await connect('W1');
  const inbox = await call(w1, 'get_inbox');
  assert.match(text(inbox), /Task T\d+: via mcp/);
});

test('report_status updates the board', async () => {
  const c = await connect('W1');
  await call(c, 'report_status', { workingOn: 'writing mcp tests', status: 'working' });
  const [row] = await t.sql`select working_on, status from ccc.sessions where name = 'W1'`;
  assert.equal(row?.workingOn, 'writing mcp tests');
  assert.equal(row?.status, 'working');
});

test('missing X-CCC-Session → HTTP 400', async () => {
  const res = await t.app.request('/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(res.status, 400);
});

test('owner cookie cannot use MCP', async () => {
  const res = await t.owner('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(res.status, 403);
});
