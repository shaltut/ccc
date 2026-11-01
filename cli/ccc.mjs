#!/usr/bin/env node
// CCC CLI and Claude Code hook handler. Zero dependencies; Node >= 18.
// Config: ~/.ccc/config.json {url, token} (written by `ccc setup`). Session name: env CCC_SESSION.
import { mkdir, readFile, stat, writeFile, utimes } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_TIMEOUT_MS = 2000;
const REQUESTABLE_ROLES = ['worker', 'helper', 'auditor', 'other'];
const HOOK_HARD_EXIT_MS = 2400;
const HEARTBEAT_THROTTLE_MS = 60_000;
const WAIT_POLL_MS = 25_000;
const WAIT_RETRY_MS = 5_000;

const cccDir = () => join(homedir(), '.ccc');
const configPath = () => join(cccDir(), 'config.json');
const selfPath = () => fileURLToPath(import.meta.url).replaceAll('\\', '/');

class CliError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function loadConfig() {
  try {
    const cfg = JSON.parse(await readFile(configPath(), 'utf8'));
    if (typeof cfg.url === 'string' && typeof cfg.token === 'string') return cfg;
  } catch {}
  return null;
}

async function requireConfig() {
  const cfg = await loadConfig();
  if (!cfg) throw new CliError('Not configured. Run: ccc setup <url> <token>', 'not_configured');
  return cfg;
}

function requireSessionName() {
  const name = process.env.CCC_SESSION;
  if (!name) throw new CliError('Set CCC_SESSION to this session name (e.g. W1).', 'no_session');
  return name;
}

async function api(
  cfg,
  method,
  path,
  body,
  { timeoutMs = 15_000, claudeSessionId = process.env.CLAUDE_CODE_SESSION_ID, name = process.env.CCC_SESSION } = {},
) {
  const headers = { authorization: `Bearer ${cfg.token}` };
  if (name) headers['x-ccc-session'] = name;
  if (claudeSessionId) headers['x-ccc-claude-session'] = claudeSessionId;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(cfg.url + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new CliError(`${err.code ?? res.status}: ${err.message ?? res.statusText}`, err.code, res.status);
  }
  return data;
}

// ---------- flags ----------

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else flags[key] = argv[++i];
    } else positional.push(a);
  }
  return { positional, flags };
}

const need = (value, usage) => {
  if (value === undefined || value === '') throw new CliError(`Usage: ccc ${usage}`, 'usage');
  return value;
};

// ---------- commands ----------

const out = (s) => process.stdout.write(`${s}\n`);

async function cmdSetup([url, token]) {
  need(url, 'setup <url> <token>');
  need(token, 'setup <url> <token>');
  await mkdir(cccDir(), { recursive: true });
  await writeFile(configPath(), JSON.stringify({ url: url.replace(/\/+$/, ''), token }, null, 2) + '\n', { mode: 0o600 });
  out(`Saved ${configPath()}`);
}

async function cmdRegister(_, flags) {
  const cfg = await requireConfig();
  requireSessionName();
  const r = await api(cfg, 'POST', '/api/sessions/register', { cwd: process.cwd(), ...(flags.role ? { role: flags.role } : {}) });
  out(`Registered as ${r.assignedName} (role ${r.session.role})${r.takeover ? ' — took over from an older process' : ''}`);
  out(r.resume);
}

async function cmdStatus([workingOn], flags) {
  const cfg = await requireConfig();
  requireSessionName();
  const body = {};
  if (workingOn !== undefined) body.workingOn = workingOn;
  if (flags.state) body.status = flags.state;
  if (flags.blocker !== undefined) body.blocker = flags.blocker === true ? null : flags.blocker;
  const r = await api(cfg, 'POST', '/api/status', body);
  out(`${r.session.name}: ${r.session.status}${r.session.workingOn ? ` — ${r.session.workingOn}` : ''}`);
}

async function cmdInbox(_, flags) {
  const cfg = await requireConfig();
  requireSessionName();
  const r = await api(cfg, 'GET', `/api/inbox${flags.peek ? '?peek=1' : ''}`);
  out(r.messages.length ? r.text : '(no messages)');
}

async function cmdWait(_, flags) {
  const cfg = await requireConfig();
  requireSessionName();
  const deadline = flags.timeout ? Date.now() + Number(flags.timeout) * 1000 : Infinity;
  while (Date.now() < deadline) {
    const pollMs = Math.max(1000, Math.min(WAIT_POLL_MS, deadline - Date.now()));
    try {
      const r = await api(cfg, 'GET', `/api/inbox/wait?timeoutMs=${Math.floor(pollMs)}`, undefined, { timeoutMs: pollMs + 10_000 });
      if (r?.messages?.length) {
        out(r.text);
        return;
      }
    } catch (err) {
      if (err instanceof CliError && err.status && err.status < 500) throw err;
      await new Promise((resolve) => setTimeout(resolve, WAIT_RETRY_MS));
    }
  }
  out('(no messages before timeout)');
}

async function cmdSend([to, body]) {
  const cfg = await requireConfig();
  requireSessionName();
  const r = await api(cfg, 'POST', '/api/messages', { to: need(to, 'send <to> "<body>"'), body: need(body, 'send <to> "<body>"') });
  out(`Sent #${r.message.id}`);
}

function parseOptions(spec) {
  return String(spec)
    .split(',')
    .map((pair) => {
      const [key, ...label] = pair.split('=');
      return { key: key.trim(), label: (label.join('=') || key).trim() };
    });
}

async function cmdAsk([to, body], flags) {
  const cfg = await requireConfig();
  requireSessionName();
  const q = { to: need(to, 'ask <to> "<body>" [--options a=Yes,b=No] [--blocking]'), body: need(body, 'ask <to> "<body>"') };
  if (flags.options) q.options = parseOptions(flags.options);
  if (flags.blocking) q.isBlocking = true;
  if (flags.context) q.context = flags.context;
  const r = await api(cfg, 'POST', '/api/questions', q);
  out(`Asked Q${r.question.id} → ${r.question.addressedTo}`);
}

async function cmdAnswer([id, text], flags) {
  const cfg = await requireConfig();
  requireSessionName();
  const body = {};
  if (flags.choice) body.choice = flags.choice;
  if (text) body.text = text;
  const r = await api(cfg, 'POST', `/api/questions/${need(id, 'answer <id> [--choice k] ["<text>"]')}/answer`, body);
  out(`Answered Q${r.question.id}`);
}

async function cmdTasks(_, flags) {
  const cfg = await requireConfig();
  const name = requireSessionName();
  const query = flags.mine ? `?assignee=${encodeURIComponent(name)}` : '';
  const r = await api(cfg, 'GET', `/api/tasks${query}`);
  out(r.tasks.length ? r.tasks.map((t) => `T${t.id} [${t.status}] ${t.assigneeName ?? '-'}: ${t.title}`).join('\n') : '(no tasks)');
}

async function cmdTask([id, status], flags) {
  const cfg = await requireConfig();
  requireSessionName();
  const body = { status: need(status, 'task <id> <in_progress|blocked|done> [--result ..] [--blocker ..]') };
  if (flags.result) body.result = flags.result;
  if (flags.blocker) body.blocker = flags.blocker;
  const r = await api(cfg, 'POST', `/api/tasks/${need(id, 'task <id> <status>')}`, body);
  out(`T${r.task.id} → ${r.task.status}`);
}

async function cmdAssign([to, title, body]) {
  const cfg = await requireConfig();
  requireSessionName();
  const r = await api(cfg, 'POST', '/api/tasks', { to: need(to, 'assign <to> "<title>" ["<body>"]'), title: need(title, 'assign <to> "<title>"'), ...(body ? { body } : {}) });
  out(`Assigned T${r.task.id} to ${r.task.assigneeName}`);
}

async function cmdBroadcast([body]) {
  const cfg = await requireConfig();
  requireSessionName();
  const r = await api(cfg, 'POST', '/api/broadcast', { body: need(body, 'broadcast "<body>"') });
  out(`Sent to ${r.count} sessions`);
}

const cmdControl = (action) => async ([target]) => {
  const cfg = await requireConfig();
  requireSessionName();
  const r = await api(cfg, 'POST', '/api/control', { target: need(target, `${action} <name|all>`), action });
  out(`${action} sent to ${r.count} session(s); it lands when each one's turn ends`);
};

async function cmdSessions() {
  const cfg = await requireConfig();
  requireSessionName();
  const r = await api(cfg, 'GET', '/api/sessions');
  out(
    r.sessions
      .map((s) => `${s.name.padEnd(14)} ${s.role.padEnd(12)} ${s.status.padEnd(18)} ${s.workingOn ?? ''}${s.unread ? ` (${s.unread} unread)` : ''}`)
      .join('\n') || '(no sessions)',
  );
}

async function cmdQuestions() {
  const cfg = await requireConfig();
  requireSessionName();
  const r = await api(cfg, 'GET', '/api/questions?status=open');
  out(r.questions.map((q) => `Q${q.id} ${q.isBlocking ? '[blocking] ' : ''}${q.askedBy} → ${q.addressedTo}: ${q.body}`).join('\n') || '(no open questions)');
}

async function cmdMcpHeaders() {
  const cfg = await requireConfig();
  const headers = { Authorization: `Bearer ${cfg.token}` };
  if (process.env.CCC_SESSION) headers['X-CCC-Session'] = process.env.CCC_SESSION;
  if (process.env.CLAUDE_CODE_SESSION_ID) headers['X-CCC-Claude-Session'] = process.env.CLAUDE_CODE_SESSION_ID;
  out(JSON.stringify(headers));
}

// ---------- install-hooks ----------

const HOOK_EVENTS = [
  ['SessionStart', 'session-start'],
  ['PostToolUse', 'post-tool-use'],
  ['Notification', 'notification', 'permission_prompt'],
  ['Stop', 'stop'],
  ['SessionEnd', 'session-end'],
];

async function cmdInstallHooks(_, flags) {
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  let settings = {};
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new CliError(`Cannot read ${settingsPath}: ${err.message}`, 'settings');
  }
  const path = selfPath();
  const hooks = { ...(settings.hooks ?? {}) };
  const added = [];
  for (const [event, arg, matcher] of HOOK_EVENTS) {
    const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
    const present = entries.some((e) => (e.hooks ?? []).some((h) => String(h.command ?? '').includes(`ccc.mjs" hook ${arg}`)));
    if (present) continue;
    const entry = { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: `node "${path}" hook ${arg}`, timeout: 5 }] };
    hooks[event] = [...entries, entry];
    added.push(`${event}: node "${path}" hook ${arg}`);
  }

  if (!added.length) out(`Hooks already installed in ${settingsPath}`);
  else if (!flags.yes) out(`Would add to ${settingsPath}:\n  ${added.join('\n  ')}\nRe-run with --yes to write.`);
  else {
    await mkdir(join(homedir(), '.claude'), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ ...settings, hooks }, null, 2) + '\n');
    out(`Added to ${settingsPath}:\n  ${added.join('\n  ')}`);
  }

  const cfg = await loadConfig();
  const mcp = JSON.stringify({ type: 'http', url: `${cfg?.url ?? '<CCC_URL>'}/mcp`, headersHelper: `node "${path}" mcp-headers` });
  out(`\nRegister the MCP server (run once per machine):\n  claude mcp add-json ccc '${mcp}' --scope user`);
}

// ---------- hooks (fail open: exit 0, print nothing, on any problem) ----------

async function readStdin() {
  if (process.stdin.isTTY) return {};
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

async function touchOnce(file) {
  try {
    await stat(file);
    return false;
  } catch {
    await mkdir(cccDir(), { recursive: true });
    await writeFile(file, '');
    return true;
  }
}

const safeId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);

async function runHook(event) {
  const name = process.env.CCC_SESSION;
  const cfg = await loadConfig();
  if (!name || !cfg) return;
  const input = await readStdin();
  const claudeSessionId = typeof input.session_id === 'string' ? input.session_id : undefined;
  const call = (method, path, body) => api(cfg, method, path, body, { timeoutMs: HOOK_TIMEOUT_MS, claudeSessionId });

  try {
    if (event === 'session-start') {
      const role = REQUESTABLE_ROLES.includes(process.env.CCC_ROLE) ? process.env.CCC_ROLE : undefined;
      const r = await call('POST', '/api/sessions/register', { claudeSessionId: claudeSessionId ?? null, cwd: input.cwd ?? process.cwd(), role });
      out(`${r.resume}\n\`ccc\` means: node "${selfPath()}"`);
    } else if (event === 'post-tool-use') {
      const marker = join(cccDir(), `hb-${safeId(claudeSessionId ?? name)}`);
      const last = await stat(marker).then((s) => s.mtimeMs, () => 0);
      if (Date.now() - last < HEARTBEAT_THROTTLE_MS) return;
      await call('POST', '/api/heartbeat', { activity: true });
      await mkdir(cccDir(), { recursive: true });
      await writeFile(marker, '').then(() => utimes(marker, new Date(), new Date()));
    } else if (event === 'notification') {
      await call('POST', '/api/status', { status: 'waiting_permission', blocker: `Permission prompt: ${String(input.message ?? '').slice(0, 1900)}` });
    } else if (event === 'stop') {
      const r = await call('GET', '/api/inbox?peek=1');
      if (r?.messages?.length) {
        out(JSON.stringify({ decision: 'block', reason: `${r.text}\n\n(From the CCC inbox: act on these.)` }));
        await call('POST', '/api/inbox/ack', { ids: r.messages.map((m) => m.id) }).catch(() => {});
      }
      await call('POST', '/api/status', { status: 'idle' });
    } else if (event === 'session-end') {
      await call('POST', '/api/status', { status: 'offline' });
    }
  } catch (err) {
    if (event === 'stop' && err instanceof CliError && err.code === 'superseded' && claudeSessionId) {
      if (await touchOnce(join(cccDir(), `superseded-${safeId(claudeSessionId)}`))) {
        out(JSON.stringify({ decision: 'block', reason: `CCC: another process has taken over session ${name}. Stop working and do not act on CCC tasks.` }));
      }
    }
    // Everything else is swallowed: CCC must never get in an agent's way.
  }
}

// ---------- main ----------

const COMMANDS = {
  setup: cmdSetup,
  register: cmdRegister,
  status: cmdStatus,
  inbox: cmdInbox,
  wait: cmdWait,
  send: cmdSend,
  ask: cmdAsk,
  answer: cmdAnswer,
  tasks: cmdTasks,
  task: cmdTask,
  assign: cmdAssign,
  broadcast: cmdBroadcast,
  pause: cmdControl('pause'),
  resume: cmdControl('resume'),
  sessions: cmdSessions,
  questions: cmdQuestions,
  'mcp-headers': cmdMcpHeaders,
  'install-hooks': cmdInstallHooks,
};

const USAGE = `ccc <command>
  setup <url> <token>            save server URL + device token to ~/.ccc/config.json
  register [--role R]            register this session (name from CCC_SESSION)
  status "<working on>" [--state working|idle|blocked] [--blocker "<text>"]
  inbox [--peek]                 read (and mark read) your messages
  wait [--timeout <sec>]         block until a message arrives, print it, exit
  send <to> "<body>"             note to a session (or "orchestrator")
  ask <to> "<body>" [--options a=Yes,b=No] [--blocking]
  answer <id> [--choice k] ["<text>"]
  tasks [--mine]   task <id> <in_progress|blocked|done> [--result ..] [--blocker ..]
  assign <to> "<title>" ["<body>"]   broadcast "<body>"   pause|resume <name|all>
  sessions   questions   mcp-headers   install-hooks [--yes]
  hook <session-start|post-tool-use|notification|stop|session-end>   (used by Claude Code)`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'hook') {
    setTimeout(() => process.exit(0), HOOK_HARD_EXIT_MS).unref();
    await runHook(rest[0]).catch(() => {});
    process.exit(0);
  }
  const handler = COMMANDS[command ?? ''];
  if (!handler) {
    out(USAGE);
    process.exit(command ? 1 : 0);
  }
  const { positional, flags } = parseArgs(rest);
  try {
    await handler(positional, flags);
  } catch (err) {
    process.stderr.write(`ccc: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

await main();
