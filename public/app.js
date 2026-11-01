import { h, mount, api, ago, minutesSince, confirmButton, debounce, Unauthorized } from './dom.js';

const STATUS_LABEL = {
  working: 'Working',
  idle: 'Idle',
  waiting_permission: 'Waiting for permission',
  blocked: 'Blocked',
  paused: 'Paused',
  unreachable: 'Unreachable',
  offline: 'Offline',
};
const ROLES = ['orchestrator', 'worker', 'helper', 'auditor', 'other'];
const TASK_GROUPS = [
  ['blocked', 'Blocked'],
  ['in_progress', 'In progress'],
  ['open', 'Not started'],
  ['done', 'Done'],
  ['cancelled', 'Cancelled'],
];
const OVERDUE_MIN = 30;

const state = { tab: 'board', sessions: [], devices: [], questions: [], tasks: [], detail: null, newToken: null };
const view = document.getElementById('view');
const dialog = document.getElementById('detail');

// ---------- plumbing ----------

function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3500);
}

async function act(fn, done) {
  try {
    await fn();
    if (done) toast(done);
    await refresh();
  } catch (err) {
    if (err instanceof Unauthorized) return showLogin();
    toast(err.message, true);
  }
}

const deviceLabel = (id) => state.devices.find((d) => d.id === id)?.label ?? '—';
const liveSessions = () => state.sessions.filter((s) => !s.retiredAt);
const openQuestions = () => state.questions.filter((q) => q.status === 'open');

async function load() {
  const [sessions, questions, tasks, devices] = await Promise.all([
    api('GET', '/api/sessions'),
    api('GET', '/api/questions'),
    api('GET', '/api/tasks'),
    api('GET', '/api/admin/devices'),
  ]);
  state.sessions = sessions.sessions;
  state.questions = questions.questions;
  state.tasks = tasks.tasks;
  state.devices = devices.devices;
}

/** True while the owner has unsent text in a field: a remount would wipe it. */
function hasDraft() {
  return [...document.querySelectorAll('#view textarea, #view input:not([type=password]), #detail textarea')].some(
    (el) => el.value.trim() !== '',
  );
}

/** Owner actions remount at once; live updates (`live: true`) wait until no draft is open. */
async function refresh({ live = false } = {}) {
  try {
    await load();
  } catch (err) {
    if (err instanceof Unauthorized) return showLogin();
    toast(err.message, true);
    return;
  }
  if (live && hasDraft()) return;
  render();
  if (dialog.open && state.detail) await renderDetail(state.detail);
}

function render() {
  const waiting = openQuestions().length;
  document.getElementById('q-count').textContent = waiting ? String(waiting) : '';
  for (const b of document.querySelectorAll('.tabs button')) {
    if (b.dataset.tab === state.tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  const views = { board: boardView, questions: questionsView, tasks: tasksView, controls: controlsView };
  mount(view, views[state.tab]());
}

// ---------- login ----------

function showLogin() {
  stream?.close();
  document.body.classList.add('signed-out');
  const input = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true, id: 'pw' });
  const error = h('p', { class: 'error-text', role: 'alert' });
  mount(
    view,
    h(
      'form',
      {
        class: 'login',
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            await api('POST', '/api/admin/login', { password: input.value });
            document.body.classList.remove('signed-out');
            start();
          } catch (err) {
            error.textContent = err.message;
          }
        },
      },
      h('h1', null, 'Command Center'),
      h('label', { for: 'pw' }, 'Owner password'),
      input,
      h('button', { type: 'submit', class: 'primary' }, 'Sign in'),
      error,
    ),
  );
  input.focus();
}

// ---------- board ----------

function strip(s) {
  const flags = [
    s.unread ? h('span', { class: 'flag' }, `${s.unread} unread`) : null,
    s.pausePending ? h('span', { class: 'flag warn' }, 'Pause pending') : null,
    s.status === 'unreachable' ? h('span', { class: 'flag alert' }, 'Needs a nudge in its terminal') : null,
  ];
  return h(
    'button',
    { type: 'button', class: `strip s-${s.status}`, onclick: () => openDetail(s.name) },
    h('span', { class: 'band' }, STATUS_LABEL[s.status] ?? s.status),
    h(
      'span',
      { class: 'strip-body' },
      h(
        'span',
        { class: 'strip-head' },
        h('span', { class: 'name' }, s.name),
        h('span', { class: `role${s.role === 'orchestrator' ? ' lead' : ''}` }, s.role),
        h('span', { class: 'meta' }, `${deviceLabel(s.deviceId)}, seen ${ago(s.lastHeartbeatAt ?? s.createdAt)}`),
      ),
      h('span', { class: 'doing', dir: 'auto' }, s.workingOn || 'No status reported yet'),
      s.blocker ? h('span', { class: 'blocker', dir: 'auto' }, s.blocker) : null,
      s.currentTask ? h('span', { class: 'task-line', dir: 'auto' }, `T${s.currentTask.id} ${s.currentTask.title}`) : null,
      flags.some(Boolean) ? h('span', { class: 'flags' }, flags) : null,
    ),
  );
}

function boardView() {
  const sessions = liveSessions();
  const waiting = openQuestions();
  const blocking = waiting.filter((q) => q.isBlocking).length;
  return h(
    'section',
    { class: 'board' },
    waiting.length
      ? h(
          'button',
          { type: 'button', class: 'waiting', onclick: () => switchTab('questions') },
          h('span', { class: 'waiting-n' }, String(waiting.length)),
          h('span', null, waiting.length === 1 ? 'question is waiting for you' : 'questions are waiting for you'),
          blocking ? h('span', { class: 'waiting-b' }, `${blocking} blocking a session`) : null,
        )
      : null,
    sessions.length
      ? h('div', { class: 'strips' }, sessions.map(strip))
      : h('p', { class: 'empty' }, 'No sessions yet. Create a device token under Controls, then run "ccc setup" on that machine.'),
  );
}

// ---------- session detail ----------

function describeEvent(e) {
  const p = e.payload ?? {};
  switch (e.type) {
    case 'message':
      return `${p.kind} from ${p.from}`;
    case 'status':
      return `${STATUS_LABEL[p.status] ?? p.status}${p.workingOn ? `: ${p.workingOn}` : ''}${p.blocker ? ` (blocker: ${p.blocker})` : ''}`;
    case 'task_created':
    case 'task_updated':
    case 'task_reassigned':
    case 'task_cancelled':
      return `${e.type.replace('task_', 'task ')} T${p.taskId} ${p.title} [${p.status}]`;
    case 'register':
      return `registered as ${p.assignedName}`;
    case 'takeover':
      return 'a newer process took over this name';
    case 'idle_ping':
      return 'pinged after an hour without activity';
    case 'unreachable':
      return 'no heartbeat for 15 min';
    default:
      return `${e.type.replaceAll('_', ' ')}${Object.keys(p).length ? ` ${JSON.stringify(p)}` : ''}`;
  }
}

function openDetail(name) {
  state.detail = name;
  void renderDetail(name).then(() => {
    if (!dialog.open) dialog.showModal();
  });
}

async function renderDetail(name) {
  const s = state.sessions.find((x) => x.name === name);
  if (!s) {
    dialog.close();
    return;
  }
  let events = [];
  try {
    events = (await api('GET', `/api/events?session=${encodeURIComponent(name)}&limit=60`)).events;
  } catch (err) {
    toast(err.message, true);
  }
  const body = h('textarea', { rows: 3, required: true, maxlength: 65536, 'aria-label': 'Message' });
  const kind = h('select', { 'aria-label': 'Message kind' }, h('option', { value: 'instruction' }, 'Instruction'), h('option', { value: 'note' }, 'Note'));
  mount(
    dialog,
    h(
      'div',
      { class: 'detail' },
      h(
        'div',
        { class: 'detail-head' },
        h('h2', { id: 'detail-title' }, s.name),
        h('span', { class: `pill s-${s.status}` }, STATUS_LABEL[s.status]),
        h('button', { type: 'button', class: 'quiet close', onclick: () => dialog.close() }, 'Close'),
      ),
      h('p', { class: 'doing', dir: 'auto' }, s.workingOn || 'No status reported yet'),
      s.blocker ? h('p', { class: 'blocker', dir: 'auto' }, s.blocker) : null,
      h(
        'div',
        { class: 'row' },
        s.paused || s.pausePending
          ? h('button', { type: 'button', onclick: () => act(() => api('POST', '/api/control', { target: s.name, action: 'resume' }), `Resume sent to ${s.name}`) }, 'Resume')
          : h('button', { type: 'button', onclick: () => act(() => api('POST', '/api/control', { target: s.name, action: 'pause' }), `Pause sent to ${s.name}`) }, 'Pause'),
      ),
      h(
        'form',
        {
          class: 'send',
          onsubmit: (e) => {
            e.preventDefault();
            void act(() => api('POST', '/api/messages', { to: s.name, body: body.value, kind: kind.value }), `Sent to ${s.name}; it lands when the current turn ends`);
          },
        },
        h('label', null, `Message ${s.name}`),
        body,
        h('div', { class: 'row' }, kind, h('button', { type: 'submit', class: 'primary' }, 'Send')),
      ),
      h('h3', null, 'Timeline'),
      events.length
        ? h('ol', { class: 'timeline' }, events.map((e) => h('li', null, h('time', null, ago(e.createdAt)), h('span', null, describeEvent(e)))))
        : h('p', { class: 'empty' }, 'Nothing recorded yet.'),
    ),
  );
}

dialog.addEventListener('close', () => {
  state.detail = null;
});

// ---------- questions ----------

function questionCard(q) {
  const overdue = q.status === 'open' && q.isBlocking && minutesSince(q.createdAt) > OVERDUE_MIN;
  const text = h('textarea', { rows: 2, maxlength: 65536, 'aria-label': `Answer Q${q.id}` });
  const answer = (choice) =>
    act(() => api('POST', `/api/questions/${q.id}/answer`, { ...(choice ? { choice } : {}), ...(text.value.trim() ? { text: text.value } : {}) }), `Answered Q${q.id}`);
  const to = q.addressedTo === 'role:orchestrator' ? 'orchestrator' : q.addressedTo;
  return h(
    'article',
    { class: `question${q.isBlocking ? ' blocking' : ''}${overdue ? ' overdue' : ''}` },
    h(
      'header',
      null,
      h('span', { class: 'qid' }, `Q${q.id}`),
      h('span', null, `${q.askedBy} asks ${to}`),
      h('span', { class: 'meta' }, ago(q.createdAt)),
      q.isBlocking ? h('span', { class: 'flag alert' }, overdue ? 'Blocking, over 30 min' : 'Blocking') : null,
    ),
    h('p', { class: 'qbody', dir: 'auto' }, q.body),
    q.context ? h('details', null, h('summary', null, 'Context'), h('p', { class: 'qbody', dir: 'auto' }, q.context)) : null,
    q.status === 'open'
      ? h(
          'div',
          { class: 'answer' },
          q.options?.length
            ? h('div', { class: 'choices' }, q.options.map((o) => h('button', { type: 'button', class: 'choice', onclick: () => answer(o.key) }, o.label)))
            : null,
          text,
          h(
            'div',
            { class: 'row' },
            h('button', { type: 'button', class: 'primary', onclick: () => answer(null) }, 'Send answer'),
            confirmButton('Withdraw', 'Confirm withdraw', () => act(() => api('POST', `/api/questions/${q.id}/withdraw`, {}), `Withdrew Q${q.id}`)),
          ),
        )
      : h(
          'p',
          { class: 'answered' },
          q.status === 'withdrawn'
            ? 'Withdrawn'
            : `Answered by ${q.answeredBy} ${ago(q.answeredAt)}: ${[q.options?.find((o) => o.key === q.answerChoice)?.label, q.answerText].filter(Boolean).join(' — ')}`,
        ),
  );
}

function questionsView() {
  const open = openQuestions();
  const closed = state.questions.filter((q) => q.status !== 'open').slice(0, 40);
  return h(
    'section',
    { class: 'questions' },
    open.length ? open.map(questionCard) : h('p', { class: 'empty' }, 'No open questions. Sessions ask with "ccc ask owner" or the ask_question tool.'),
    closed.length ? h('details', { class: 'history' }, h('summary', null, `Answered and withdrawn (${closed.length})`), closed.map(questionCard)) : null,
  );
}

// ---------- tasks ----------

function sessionSelect(label, selected) {
  return h(
    'select',
    { 'aria-label': label, required: true },
    liveSessions().map((s) => h('option', { value: s.name, selected: s.name === selected }, s.name)),
  );
}

function taskRow(t) {
  const isOpen = t.status !== 'done' && t.status !== 'cancelled';
  const to = sessionSelect(`Reassign T${t.id}`, t.assigneeName);
  return h(
    'li',
    { class: 'task' },
    h('div', { class: 'task-title' }, h('span', { class: 'qid' }, `T${t.id}`), h('span', { dir: 'auto' }, t.title)),
    h('div', { class: 'meta' }, `${t.assigneeName ?? 'unassigned'}, updated ${ago(t.updatedAt)}`),
    t.blocker ? h('p', { class: 'blocker', dir: 'auto' }, t.blocker) : null,
    t.result ? h('p', { class: 'qbody', dir: 'auto' }, t.result) : null,
    isOpen
      ? h(
          'div',
          { class: 'row' },
          to,
          h('button', { type: 'button', onclick: () => act(() => api('POST', `/api/tasks/${t.id}/assign`, { to: to.value }), `T${t.id} moved to ${to.value}`) }, 'Reassign'),
          confirmButton('Cancel task', 'Confirm cancel', () => act(() => api('POST', `/api/tasks/${t.id}/cancel`, {}), `Cancelled T${t.id}`)),
        )
      : null,
  );
}

function tasksView() {
  const to = sessionSelect('Assign to');
  const title = h('input', { type: 'text', required: true, maxlength: 500, placeholder: 'What needs doing', 'aria-label': 'Task title' });
  const body = h('textarea', { rows: 3, maxlength: 65536, placeholder: 'Details (optional)', 'aria-label': 'Task details' });
  return h(
    'section',
    { class: 'tasks' },
    h(
      'form',
      {
        class: 'panel',
        onsubmit: (e) => {
          e.preventDefault();
          void act(() => api('POST', '/api/tasks', { to: to.value, title: title.value, ...(body.value ? { body: body.value } : {}) }), `Assigned to ${to.value}`);
        },
      },
      h('h2', null, 'Assign a task'),
      liveSessions().length ? [to, title, body, h('button', { type: 'submit', class: 'primary' }, 'Assign task')] : h('p', { class: 'empty' }, 'No sessions to assign to yet.'),
    ),
    TASK_GROUPS.map(([status, label]) => {
      const items = state.tasks.filter((t) => t.status === status);
      if (!items.length) return null;
      const list = h('ul', { class: 'task-list' }, items.map(taskRow));
      return status === 'done' || status === 'cancelled'
        ? h('details', { class: 'history' }, h('summary', null, `${label} (${items.length})`), list)
        : h('div', null, h('h2', null, `${label} (${items.length})`), list);
    }),
  );
}

// ---------- controls ----------

function controlsView() {
  const message = h('textarea', { rows: 3, required: true, maxlength: 65536, 'aria-label': 'Broadcast message' });
  const label = h('input', { type: 'text', required: true, maxlength: 64, placeholder: 'e.g. windows, mac, vps', 'aria-label': 'Device label' });
  return h(
    'section',
    { class: 'controls' },
    h(
      'form',
      {
        class: 'panel',
        onsubmit: (e) => {
          e.preventDefault();
          void act(async () => {
            const r = await api('POST', '/api/broadcast', { body: message.value });
            toast(`Broadcast to ${r.count} sessions`);
          });
        },
      },
      h('h2', null, 'Everyone'),
      message,
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'submit', class: 'primary' }, 'Broadcast'),
        confirmButton('Pause all', 'Confirm pause all', () => act(() => api('POST', '/api/control', { target: 'all', action: 'pause' }), 'Pause sent; each session stops when its turn ends'), 'warn'),
        h('button', { type: 'button', onclick: () => act(() => api('POST', '/api/control', { target: 'all', action: 'resume' }), 'Resume sent') }, 'Resume all'),
      ),
    ),
    h(
      'div',
      { class: 'panel' },
      h('h2', null, 'Sessions'),
      liveSessions().length
        ? h(
            'ul',
            { class: 'plain' },
            liveSessions().map((s) => {
              const role = h('select', { 'aria-label': `Role for ${s.name}` }, ROLES.map((r) => h('option', { value: r, selected: r === s.role }, r)));
              return h(
                'li',
                { class: 'row' },
                h('span', { class: 'name small' }, s.name),
                role,
                h('button', { type: 'button', onclick: () => act(() => api('POST', `/api/admin/sessions/${encodeURIComponent(s.name)}/role`, { role: role.value }), `${s.name} is now ${role.value}`) }, 'Set role'),
                confirmButton('Retire', 'Confirm retire', () => act(() => api('POST', `/api/admin/sessions/${encodeURIComponent(s.name)}/retire`, {}), `Retired ${s.name}`)),
              );
            }),
          )
        : h('p', { class: 'empty' }, 'No sessions yet.'),
    ),
    h(
      'form',
      {
        class: 'panel',
        onsubmit: (e) => {
          e.preventDefault();
          void act(async () => {
            const r = await api('POST', '/api/admin/devices', { label: label.value });
            state.newToken = { label: r.device.label, token: r.token };
          }, 'Device token created');
        },
      },
      h('h2', null, 'Devices'),
      state.newToken
        ? h(
            'div',
            { class: 'token' },
            h('p', null, `Token for ${state.newToken.label}. It is shown once: copy it now.`),
            h('input', { type: 'text', readonly: true, value: state.newToken.token, onfocus: (e) => e.target.select(), 'aria-label': 'New device token' }),
            h('button', { type: 'button', onclick: () => navigator.clipboard?.writeText(state.newToken.token).then(() => toast('Copied')) }, 'Copy token'),
            h('button', { type: 'button', class: 'quiet', onclick: () => { state.newToken = null; render(); } }, 'Done'),
          )
        : null,
      h(
        'ul',
        { class: 'plain' },
        state.devices.map((d) =>
          h(
            'li',
            { class: 'row' },
            h('span', { class: 'name small' }, d.label),
            h('span', { class: 'meta' }, d.revokedAt ? `revoked ${ago(d.revokedAt)}` : `added ${ago(d.createdAt)}`),
            d.revokedAt ? null : confirmButton('Revoke', 'Confirm revoke', () => act(() => api('POST', `/api/admin/devices/${d.id}/revoke`, {}), `Revoked ${d.label}`)),
          ),
        ),
      ),
      h('div', { class: 'row' }, label, h('button', { type: 'submit', class: 'primary' }, 'Create token')),
    ),
  );
}

// ---------- tabs + live updates ----------

function switchTab(tab) {
  state.tab = tab;
  render();
  view.focus();
}

for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => switchTab(b.dataset.tab));

let stream;
const liveRefresh = debounce(() => void refresh({ live: true }), 300);

function connectStream() {
  stream?.close();
  stream = new EventSource('/api/stream');
  const live = document.getElementById('live');
  stream.addEventListener('ready', () => {
    live.textContent = 'live';
    live.classList.add('on');
  });
  stream.addEventListener('ccc', liveRefresh);
  stream.addEventListener('error', () => {
    live.textContent = 'reconnecting';
    live.classList.remove('on');
  });
}

// Relative times drift without events; repaint them every 30 s.
setInterval(() => {
  if (!document.body.classList.contains('signed-out') && !dialog.open && !hasDraft()) render();
}, 30_000);

async function start() {
  try {
    await load();
  } catch (err) {
    if (err instanceof Unauthorized) return showLogin();
    toast(err.message, true);
    return;
  }
  render();
  connectStream();
}

void start();
