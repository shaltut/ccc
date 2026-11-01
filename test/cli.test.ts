import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { testApp, post } from './helpers.ts';

const CLI = fileURLToPath(new URL('../cli/ccc.mjs', import.meta.url));
const t = await testApp();
const server = serve({ fetch: t.app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const token = await t.newDevice('cli');
after(async () => {
  server.close();
  await t.sql.end();
});

type Run = { code: number | null; stdout: string; stderr: string; ms: number };

function run(args: string[], opts: { home: string; session?: string; input?: string; cli?: string }): Promise<Run> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: opts.home, USERPROFILE: opts.home };
  delete env.CCC_SESSION;
  if (opts.session) env.CCC_SESSION = opts.session;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [opts.cli ?? CLI, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(opts.input ?? '');
  });
}

async function home(cfgUrl = url): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ccc-cli-'));
  const r = await run(['setup', cfgUrl, token], { home: dir });
  assert.equal(r.code, 0, r.stderr);
  return dir;
}

const hookInput = (o: Record<string, unknown>) => JSON.stringify({ cwd: 'F:/repo', hook_event_name: 'x', ...o });

test('setup then register prints assignedName', async () => {
  const h = await home();
  const r = await run(['register'], { home: h, session: 'C1' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /C1/);
  const cfg = JSON.parse(await readFile(join(h, '.ccc', 'config.json'), 'utf8'));
  assert.deepEqual(cfg, { url, token });
});

test('hook stop against closed port is silent and fast', async () => {
  const h = await home('http://127.0.0.1:1');
  const r = await run(['hook', 'stop'], { home: h, session: 'C2', input: hookInput({ session_id: 'x', stop_hook_active: false }) });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.ok(r.ms < 2500, `took ${r.ms} ms`);
});

test('hook against a server that never answers still exits within 2.5 s', async () => {
  const { createServer } = await import('node:net');
  const blackhole = createServer(() => {});
  await new Promise<void>((r) => blackhole.listen(0, '127.0.0.1', () => r()));
  const port = (blackhole.address() as AddressInfo).port;
  try {
    const h = await home(`http://127.0.0.1:${port}`);
    const r = await run(['hook', 'session-start'], { home: h, session: 'C2b', input: hookInput({ session_id: 'y' }) });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.ok(r.ms < 2500, `took ${r.ms} ms`);
  } finally {
    blackhole.close();
  }
});

test('hook without CCC_SESSION does nothing', async () => {
  const h = await home();
  const r = await run(['hook', 'session-start'], { home: h, input: hookInput({ session_id: 'z' }) });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('hook session-start prints resume text containing "ccc wait"', async () => {
  const h = await home();
  const r = await run(['hook', 'session-start'], { home: h, session: 'C3', input: hookInput({ session_id: 's3' }) });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /ccc wait/);
  const [row] = await t.sql`select claude_session_id from ccc.sessions where name = 'C3'`;
  assert.equal(row?.claudeSessionId, 's3');
});

test('stop hook blocks once per message', async () => {
  const h = await home();
  await run(['hook', 'session-start'], { home: h, session: 'C4', input: hookInput({ session_id: 's4' }) });
  await t.agent(token, 'C4s')('/api/messages', post({ to: 'C4', body: 'please rebase' }));
  const first = await run(['hook', 'stop'], { home: h, session: 'C4', input: hookInput({ session_id: 's4', stop_hook_active: false }) });
  const out = JSON.parse(first.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /please rebase/);
  const second = await run(['hook', 'stop'], { home: h, session: 'C4', input: hookInput({ session_id: 's4', stop_hook_active: true }) });
  assert.equal(second.code, 0);
  assert.equal(second.stdout, '');
  const [row] = await t.sql`select status from ccc.sessions where name = 'C4'`;
  assert.equal(row?.status, 'idle');
});

test('post-tool-use throttles', async () => {
  const h = await home();
  const input = hookInput({ session_id: 's5' });
  await run(['hook', 'post-tool-use'], { home: h, session: 'C5', input });
  const [a] = await t.sql`select last_activity_at from ccc.sessions where name = 'C5'`;
  assert.ok(a?.lastActivityAt);
  await new Promise((r) => setTimeout(r, 100));
  await run(['hook', 'post-tool-use'], { home: h, session: 'C5', input });
  const [b] = await t.sql`select last_activity_at from ccc.sessions where name = 'C5'`;
  assert.equal((b?.lastActivityAt as Date).getTime(), (a?.lastActivityAt as Date).getTime());
});

test('notification hook marks waiting_permission', async () => {
  const h = await home();
  await run(['hook', 'notification'], {
    home: h,
    session: 'C6',
    input: hookInput({ session_id: 's6', message: 'Claude needs permission to use Bash', notification_type: 'permission_prompt' }),
  });
  const [row] = await t.sql`select status, blocker from ccc.sessions where name = 'C6'`;
  assert.equal(row?.status, 'waiting_permission');
  assert.equal(row?.blocker, 'Permission prompt: Claude needs permission to use Bash');
});

test('session-end marks offline', async () => {
  const h = await home();
  await run(['hook', 'session-end'], { home: h, session: 'C7', input: hookInput({ session_id: 's7', reason: 'prompt_input_exit' }) });
  const [row] = await t.sql`select status from ccc.sessions where name = 'C7'`;
  assert.equal(row?.status, 'offline');
});

test('superseded stop hook blocks once with takeover text', async () => {
  const h = await home();
  await run(['hook', 'session-start'], { home: h, session: 'C8', input: hookInput({ session_id: 'old' }) });
  await t.sql`update ccc.sessions set last_activity_at = now() - interval '3 minutes' where name = 'C8'`;
  await run(['hook', 'session-start'], { home: h, session: 'C8', input: hookInput({ session_id: 'new' }) });
  const input = hookInput({ session_id: 'old', stop_hook_active: false });
  const first = await run(['hook', 'stop'], { home: h, session: 'C8', input });
  const out = JSON.parse(first.stdout);
  assert.equal(out.decision, 'block');
  assert.equal(out.reason, 'CCC: another process has taken over session C8. Stop working and do not act on CCC tasks.');
  const second = await run(['hook', 'stop'], { home: h, session: 'C8', input });
  assert.equal(second.stdout, '');
});

test('wait exits with message', async () => {
  const h = await home();
  await run(['register'], { home: h, session: 'C9' });
  const waiting = run(['wait'], { home: h, session: 'C9' });
  await new Promise((r) => setTimeout(r, 500));
  await t.agent(token, 'C9s')('/api/messages', post({ to: 'C9', body: 'wake up C9' }));
  const r = await waiting;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /wake up C9/);
  assert.ok(r.ms < 3500, `took ${r.ms} ms`);
});

test('ask, answer and inbox round-trip through the CLI', async () => {
  const h = await home();
  const asked = await run(['ask', 'owner', 'Ship it?', '--options', 'a=Yes,b=No', '--blocking'], { home: h, session: 'C10' });
  assert.equal(asked.code, 0, asked.stderr);
  const id = /Q(\d+)/.exec(asked.stdout)?.[1];
  assert.ok(id);
  await t.owner(`/api/questions/${id}/answer`, post({ choice: 'a' }));
  const inbox = await run(['inbox'], { home: h, session: 'C10' });
  assert.match(inbox.stdout, new RegExp(`Answer to Q${id}: \\[Yes\\]`));
});

test('cli error goes to stderr with exit 1', async () => {
  const h = await home();
  const r = await run(['send', 'ghost-session', 'hi'], { home: h, session: 'C11' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown_session/);
});

test('mcp-headers prints session header', async () => {
  const h = await home();
  const r = await run(['mcp-headers'], { home: h, session: 'C12' });
  assert.deepEqual(JSON.parse(r.stdout), { Authorization: `Bearer ${token}`, 'X-CCC-Session': 'C12' });
});

test('install-hooks merges without clobbering and quotes paths', async () => {
  const h = await home();
  const spaced = join(h, 'dir with space');
  await mkdir(spaced, { recursive: true });
  const cliCopy = join(spaced, 'ccc.mjs');
  await copyFile(CLI, cliCopy);
  const settingsPath = join(h, '.claude', 'settings.json');
  await mkdir(join(h, '.claude'), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }));

  const r = await run(['install-hooks', '--yes'], { home: h, cli: cliCopy });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /claude mcp add-json ccc/);
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(settings.model, 'x');
  const quoted = `"${cliCopy.replaceAll('\\', '/')}"`;
  const events = { SessionStart: 'session-start', PostToolUse: 'post-tool-use', Notification: 'notification', Stop: 'stop', SessionEnd: 'session-end' };
  for (const [event, arg] of Object.entries(events)) {
    const commands = (settings.hooks[event] as { hooks: { command: string }[] }[]).flatMap((e) => e.hooks.map((x) => x.command));
    const ccc = commands.filter((c) => c.includes('ccc.mjs" hook'));
    assert.equal(ccc.length, 1, event);
    assert.equal(ccc[0], `node ${quoted} hook ${arg}`);
  }
  assert.ok(settings.hooks.Stop.some((e: { hooks: { command: string }[] }) => e.hooks[0]?.command === 'echo hi'));
  assert.equal(settings.hooks.Notification[0].matcher, 'permission_prompt');

  const before = await readFile(settingsPath);
  await run(['install-hooks', '--yes'], { home: h, cli: cliCopy });
  assert.ok(before.equals(await readFile(settingsPath)));
});

test('install-hooks without --yes writes nothing', async () => {
  const h = await home();
  const r = await run(['install-hooks'], { home: h });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /--yes/);
  await assert.rejects(readFile(join(h, '.claude', 'settings.json')));
});
