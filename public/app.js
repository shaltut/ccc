import { h, mount, api, ago, minutesSince, confirmButton, debounce, Unauthorized } from './dom.js';
import { boardView } from './views/board.js';
import { renderDetail as drawDetail } from './views/detail.js';
import { questionsView } from './views/questions.js';
import { tasksView } from './views/tasks.js';
import { controlsView } from './views/controls.js';

const OVERDUE_MIN = 30;

const PROJECT_KEY = 'ccc.project';
function readProject() {
  try {
    return localStorage.getItem(PROJECT_KEY) ?? '';
  } catch {
    return '';
  }
}
function saveProject(p) {
  try {
    localStorage.setItem(PROJECT_KEY, p);
  } catch {}
}
const state = { tab: 'board', project: readProject(), status: '', pending: new Map(), taskFilter: 'open', projects: [], sessions: [], devices: [], questions: [], tasks: [], detail: null, newToken: null };
/** Adds ?project= when one project is selected; '' means all projects. */
const scoped = (path) => (state.project ? `${path}${path.includes('?') ? '&' : '?'}project=${encodeURIComponent(state.project)}` : path);
const inProject = () => (state.project ? { project: state.project } : {});
const view = document.getElementById('view');
const dialog = document.getElementById('detail');

// ---------- plumbing ----------

/** One toast at a time. `action` ({ label, run }) adds a button and keeps it up for 5 s. */
function toast(message, isError = false, action = null) {
  const el = document.getElementById('toast');
  mount(
    el,
    h('span', null, message),
    action
      ? h('button', { type: 'button', class: 'small', onclick: () => { el.classList.remove('show'); action.run(); } }, action.label)
      : null,
  );
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), action ? 5000 : 3500);
}

window.addEventListener('beforeunload', (e) => { if (state.pending.size) e.preventDefault(); });

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

// Everything a view may use. Views never import app.js.
const ctx = {
  state,
  api,
  act,
  toast,
  render,
  // Interim navigation until the hash router lands (Task 8).
  navigate: ({ view: next, status } = {}) => {
    if (status !== undefined) state.status = status;
    if (next && next !== state.tab) switchTab(next);
    else render();
  },
  openDetail: (name) => openDetail(name),
  deviceLabel,
  liveSessions,
  openQuestions,
  inProject,
};

async function load() {
  const projects = await api('GET', '/api/projects');
  state.projects = projects.projects;
  // A remembered project with nothing left in it: show everything rather than an empty board.
  if (state.project && !state.projects.some((p) => p.name === state.project)) {
    state.project = '';
    saveProject('');
  }
  const [sessions, questions, tasks, devices] = await Promise.all([
    api('GET', scoped('/api/sessions')),
    api('GET', scoped('/api/questions')),
    api('GET', scoped('/api/tasks')),
    api('GET', '/api/admin/devices'),
  ]);
  state.sessions = sessions.sessions;
  state.questions = questions.questions;
  state.tasks = tasks.tasks;
  state.devices = devices.devices;
}

/** True while the owner has unsent input: typed text, a changed select, or an open row menu. A remount would lose it. */
function hasDraft() {
  const typed = [...document.querySelectorAll('#view textarea, #view input:not([type=password]), #detail textarea')].some(
    (el) => el.value.trim() !== '',
  );
  return typed || document.querySelector('#view [data-dirty], #view details.menu[open]') !== null;
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

const projectPick = document.getElementById('project');

function renderProjectPicker() {
  mount(
    projectPick,
    h('option', { value: '', selected: state.project === '' }, 'All projects'),
    state.projects.map((p) => h('option', { value: p.name, selected: p.name === state.project }, `${p.name} (${p.sessions})`)),
  );
}

function render() {
  renderProjectPicker();
  const waiting = openQuestions().length;
  document.getElementById('q-count').textContent = waiting ? String(waiting) : '';
  for (const b of document.querySelectorAll('.tabs button')) {
    if (b.dataset.tab === state.tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  const views = { board: () => boardView(ctx), questions: () => questionsView(ctx), tasks: () => tasksView(ctx), controls: () => controlsView(ctx) };
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

// ---------- session detail ----------

let lastFocus = null;
const renderDetail = (name) => drawDetail(ctx, dialog, name);

function showDetail(name) {
  state.detail = name;
  void renderDetail(name).then((ok) => {
    if (ok && state.detail === name && !dialog.open) dialog.showModal();
    if (!ok) state.detail = null;
  });
}

function openDetail(name) {
  lastFocus = document.activeElement;
  showDetail(name);
}

dialog.addEventListener('close', () => {
  const name = state.detail;
  state.detail = null;
  const back = lastFocus?.isConnected ? lastFocus : name ? view.querySelector(`.srow[data-name="${CSS.escape(name)}"]`) : null;
  back?.focus();
  lastFocus = null;
});

// ---------- tabs + live updates ----------

function switchTab(tab) {
  state.tab = tab;
  render();
  view.focus();
}

for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => switchTab(b.dataset.tab));

projectPick.addEventListener('change', () => {
  state.project = projectPick.value;
  saveProject(state.project);
  void refresh();
});

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
