import { h, mount, api, debounce, Unauthorized } from './dom.js';
import { NEEDS_YOU, isOpenTask, parseRoute, formatRoute, isTypingTarget, resolveKey, latestOnly } from './logic.js';
import { boardView } from './views/board.js';
import { questionsView } from './views/questions.js';
import { tasksView } from './views/tasks.js';
import { controlsView } from './views/controls.js';
import { renderDetail as drawDetail } from './views/detail.js';

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

const state = {
  tab: 'board',
  project: '',
  status: '',
  projects: [],
  sessions: [],
  devices: [],
  questions: [],
  tasks: [],
  detail: null,
  newToken: null,
  taskFilter: 'open',
  pending: new Map(),
  // Typed answers by textarea id. They outlive a remount, so queueing, Undo or a failed send never loses them.
  drafts: new Map(),
};
/** Adds ?project= when one project is selected; '' means all projects. */
const inProject = () => (state.project ? { project: state.project } : {});
const view = document.getElementById('view');
const dialog = document.getElementById('detail');
const keys = document.getElementById('keys');
const projectList = document.getElementById('project-list');
const projectPick = document.getElementById('project');

// ---------- plumbing ----------

const OFFLINE = "Couldn't reach CCC. Check your connection and try again.";
/** fetch() throws a TypeError when the network fails; anything else carries the server's message. */
const errorText = (err) => (err instanceof TypeError ? OFFLINE : err.message);

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

/** `live: true` makes the follow-up refresh wait for open drafts, for actions the owner did not just take (a timer). */
async function act(fn, done, { live = false } = {}) {
  try {
    await fn();
    if (done) toast(done);
    await refresh({ live });
  } catch (err) {
    if (err instanceof Unauthorized) return showLogin();
    toast(errorText(err), true);
  }
}

const deviceLabel = (id) => state.devices.find((d) => d.id === id)?.label ?? '—';
const liveSessions = () => state.sessions.filter((s) => !s.retiredAt && (!state.project || s.project === state.project));
const openQuestions = () => state.questions.filter((q) => q.status === 'open');

async function fetchAll(project) {
  const { projects } = await api('GET', '/api/projects');
  // A remembered or linked project with nothing left in it: show everything rather than an empty board.
  const scope = project && projects.some((p) => p.name === project) ? project : '';
  const inScope = (path) => (scope ? `${path}?project=${encodeURIComponent(scope)}` : path);
  const [sessions, questions, tasks, devices] = await Promise.all([
    api('GET', '/api/sessions'),
    api('GET', inScope('/api/questions')),
    api('GET', inScope('/api/tasks')),
    api('GET', '/api/admin/devices'),
  ]);
  return { project, scope, projects, sessions: sessions.sessions, questions: questions.questions, tasks: tasks.tasks, devices: devices.devices };
}
const fetchLatest = latestOnly(fetchAll);

/** Loads everything for the current project. False when a newer load overtook this one, or the project changed meanwhile. */
async function load() {
  const got = await fetchLatest(state.project);
  if (!got || got.value.project !== state.project) return false;
  const d = got.value;
  state.projects = d.projects;
  if (d.scope !== state.project) {
    state.project = '';
    saveProject('');
    history.replaceState(null, '', formatRoute(currentRoute()));
  }
  state.sessions = d.sessions;
  state.questions = d.questions;
  state.tasks = d.tasks;
  state.devices = d.devices;
  return true;
}

/** True while the owner has unsent input: typed text, a changed select, or an open row menu. A remount would lose it. */
function hasDraft() {
  const typed = [...document.querySelectorAll('#view textarea, #view input:not([type=password]):not([readonly]), #detail textarea')].some(
    (el) => el.value.trim() !== '',
  );
  return typed || document.querySelector('#view [data-dirty], #detail [data-dirty], #view details.menu[open]') !== null;
}

/** Owner actions remount at once; live updates (`live: true`) wait until no draft is open. */
async function refresh({ live = false } = {}) {
  try {
    if (!(await load())) return; // a newer load will render
  } catch (err) {
    if (err instanceof Unauthorized) return showLogin();
    toast(errorText(err), true);
    return;
  }
  // The sidebar is outside #view, so it stays current even while a draft holds the page still.
  if (live && hasDraft()) return renderNav();
  render();
  if (dialog.open && state.detail) await renderDetail(state.detail);
}

// ---------- shell ----------

function renderNav() {
  const open = openQuestions();
  const qCount = document.getElementById('q-count');
  qCount.textContent = open.length ? String(open.length) : '';
  qCount.classList.toggle('hot', open.some((q) => q.isBlocking));
  const openTasks = state.tasks.filter(isOpenTask).length;
  document.getElementById('t-count').textContent = openTasks ? String(openTasks) : '';
  for (const a of document.querySelectorAll('.nav a')) {
    a.href = formatRoute({ view: a.dataset.view, project: state.project });
    if (a.dataset.view === state.tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const live = state.sessions.filter((s) => !s.retiredAt);
  const hot = new Set(live.filter((s) => NEEDS_YOU.has(s.status)).map((s) => s.project));
  const item = (name, label, count, needsYou) =>
    h(
      'li',
      null,
      h(
        'a',
        { href: formatRoute({ view: state.tab, project: name }), 'aria-current': state.project === name ? 'true' : null },
        h('span', { class: 'pname', translate: name ? 'no' : null }, label),
        h(
          'span',
          { class: 'pcount' },
          needsYou ? h('span', { class: 'dot', 'data-status': 'blocked', role: 'img', 'aria-label': 'needs you' }) : null,
          h('span', { class: 'count' }, String(count)),
        ),
      ),
    );
  mount(projectList, item('', 'All', live.length, hot.size > 0), state.projects.map((p) => item(p.name, p.name, p.sessions, hot.has(p.name))));
  mount(
    projectPick,
    h('option', { value: '', selected: !state.project }, 'All projects'),
    state.projects.map((p) => h('option', { value: p.name, selected: p.name === state.project }, `${p.name} (${p.sessions})`)),
  );
}

/** A selector that finds the focused control again after a remount, or null. */
function focusKey() {
  const el = document.activeElement;
  if (!el || el === view || !view.contains(el)) return null;
  if (el.matches('.srow[data-name]')) return `.srow[data-name="${CSS.escape(el.dataset.name)}"]`;
  if (el.matches('.stat[data-status]')) return `.stat[data-status="${CSS.escape(el.dataset.status)}"]`;
  return el.id ? `#${CSS.escape(el.id)}` : null;
}

function render() {
  renderNav();
  for (const el of view.querySelectorAll('textarea[id^="ans-"]')) state.drafts.set(el.id, el.value);
  const key = focusKey();
  const views = { board: boardView, questions: questionsView, tasks: tasksView, controls: controlsView };
  mount(view, views[state.tab](ctx));
  if (key) view.querySelector(key)?.focus({ preventScroll: true });
}

// A changed select is a draft too: a remount would silently put it back (e.g. Broadcast scope → All projects).
for (const root of [view, dialog]) {
  root.addEventListener('change', (e) => {
    if (e.target instanceof HTMLSelectElement) e.target.dataset.dirty = 'true';
  });
}

// ---------- routing ----------

function currentRoute(over = {}) {
  return { view: state.tab, project: state.project, status: state.tab === 'board' ? state.status : '', session: '', ...over };
}

function navigate(over = {}) {
  const next = formatRoute(currentRoute(over));
  if (location.hash === next) applyRoute();
  else location.hash = next;
}

function applyRoute() {
  if (document.body.classList.contains('signed-out')) return;
  const r = parseRoute(location.hash);
  const viewChanged = r.view !== state.tab;
  const projectChanged = r.project !== state.project;
  const statusChanged = r.status !== state.status;
  state.tab = r.view;
  state.status = r.status;
  if (projectChanged) {
    state.project = r.project;
    saveProject(r.project);
    void refresh();
  } else if (viewChanged || statusChanged) {
    render();
  }
  if (r.session) {
    if (state.detail !== r.session || !dialog.open) showDetail(r.session);
  } else if (dialog.open) {
    dialog.close();
  }
  if (viewChanged) view.focus();
}

window.addEventListener('hashchange', applyRoute);

/** On first load: the hash wins; without a project in it, fall back to the remembered one. */
function initRoute() {
  const r = parseRoute(location.hash);
  if (!/[?&]project=/.test(location.hash)) r.project = parseRoute(`#/board?project=${encodeURIComponent(readProject())}`).project;
  state.tab = r.view;
  state.project = r.project;
  state.status = r.status;
  history.replaceState(null, '', formatRoute(r));
  return r;
}

projectPick.addEventListener('change', () => navigate({ project: projectPick.value, status: '' }));

document.querySelector('.skip').addEventListener('click', (e) => {
  e.preventDefault();
  view.focus();
});

// ---------- session detail ----------

let lastFocus = null;
const renderDetail = (name) => drawDetail(ctx, dialog, name);

function showDetail(name) {
  state.detail = name;
  void renderDetail(name).then((ok) => {
    if (ok && state.detail === name && !dialog.open) dialog.showModal();
    if (!ok) {
      state.detail = null;
      history.replaceState(null, '', formatRoute(currentRoute()));
    }
  });
}

function openDetail(name) {
  lastFocus = document.activeElement;
  navigate({ session: name });
}

dialog.addEventListener('close', () => {
  const name = state.detail;
  state.detail = null;
  if (parseRoute(location.hash).session) history.replaceState(null, '', formatRoute(currentRoute()));
  const back = lastFocus?.isConnected ? lastFocus : name ? view.querySelector(`.srow[data-name="${CSS.escape(name)}"]`) : null;
  back?.focus();
  lastFocus = null;
});

// Everything a view may use. Views never import app.js.
const ctx = { state, api, act, toast, render, navigate, openDetail, deviceLabel, liveSessions, openQuestions, inProject };

// ---------- keyboard ----------

const SHORTCUTS = [
  ['g b', 'Board'],
  ['g q', 'Questions'],
  ['g t', 'Tasks'],
  ['g c', 'Controls'],
  ['j / k', 'Next / previous session'],
  ['Enter', 'Open the focused session'],
  ['0–9', 'Pick a project (0 = All)'],
  ['?', 'Show this list'],
  ['Esc', 'Close a drawer or this list'],
];

function showKeys() {
  mount(
    keys,
    h(
      'div',
      { class: 'sheet-body' },
      h('div', { class: 'page-head' }, h('h2', { id: 'keys-title' }, 'Keyboard Shortcuts'), h('button', { type: 'button', class: 'quiet small', onclick: () => keys.close() }, 'Close')),
      h('dl', { class: 'keys' }, SHORTCUTS.map(([combo, label]) => [h('dt', null, combo.split(' ').map((k) => (k === '/' ? ' / ' : h('kbd', null, k)))), h('dd', null, label)])),
    ),
  );
  if (!keys.open) keys.showModal();
}

document.getElementById('keys-open').addEventListener('click', showKeys);

document.getElementById('sign-out').addEventListener('click', async () => {
  if (state.pending.size) return toast('An answer is still sending. Sign out once it has gone, or undo it.', true);
  try {
    await api('POST', '/api/admin/logout', {});
  } catch (err) {
    if (!(err instanceof Unauthorized)) return toast(errorText(err), true);
  }
  state.newToken = null; // a freshly minted device token must not reappear for the next person to sign in
  showLogin({ signedOut: true });
});

function moveRow(delta) {
  if (state.tab !== 'board') return;
  const rows = [...view.querySelectorAll('.srow')];
  if (!rows.length) return;
  const i = rows.indexOf(document.activeElement);
  rows[i === -1 ? 0 : Math.max(0, Math.min(rows.length - 1, i + delta))].focus();
}

let pendingKey = null;
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
  if (document.body.classList.contains('signed-out') || dialog.open || keys.open) return;
  const { action, pending } = resolveKey(e.key, pendingKey, Date.now());
  pendingKey = pending;
  if (!action) return;
  e.preventDefault();
  const [kind, arg] = action.split(':');
  if (kind === 'view') navigate({ view: arg, status: '' });
  else if (kind === 'help') showKeys();
  else if (kind === 'row') moveRow(arg === 'next' ? 1 : -1);
  else if (kind === 'project') {
    const n = Number(arg);
    const project = n === 0 ? '' : state.projects[n - 1]?.name;
    if (project !== undefined) navigate({ project, status: '' });
  }
});

// ---------- login ----------

/** The owner's sign-in page. `signedOut` says so after the Sign out button, so the empty form isn't a surprise. */
function showLogin({ signedOut = false } = {}) {
  stream?.close();
  if (dialog.open) dialog.close();
  document.body.classList.add('signed-out');
  const input = h('input', {
    type: 'password',
    name: 'password',
    autocomplete: 'current-password',
    required: true,
    id: 'pw',
    'aria-describedby': 'login-error',
  });
  let shown = false;
  const reveal = h(
    'button',
    {
      type: 'button',
      class: 'quiet small reveal',
      'aria-pressed': 'false',
      'aria-controls': 'pw',
      onclick: () => {
        shown = !shown;
        input.type = shown ? 'text' : 'password';
        reveal.setAttribute('aria-pressed', String(shown));
        reveal.textContent = shown ? 'Hide' : 'Show';
        input.focus();
      },
    },
    'Show',
  );
  const notice = h('p', { class: 'login-notice', role: 'status' }, signedOut ? "You're signed out." : '');
  const error = h('p', { class: 'error-text', role: 'alert', id: 'login-error' });
  const submit = h('button', { type: 'submit', class: 'primary' }, 'Sign in');
  mount(
    view,
    h(
      'div',
      { class: 'login-wrap' },
      h(
        'form',
        {
          class: 'login',
          'aria-labelledby': 'login-title',
          onsubmit: async (e) => {
            e.preventDefault();
            error.textContent = '';
            notice.textContent = '';
            submit.disabled = true;
            submit.textContent = 'Signing in…';
            try {
              await api('POST', '/api/admin/login', { password: input.value });
              await start();
            } catch (err) {
              error.textContent =
                err instanceof Unauthorized
                  ? 'Wrong password.'
                  : err.status === 429
                    ? 'Too many wrong passwords. Sign-in is paused for up to 15 minutes.'
                    : errorText(err);
              submit.disabled = false;
              submit.textContent = 'Sign in';
              input.select();
            }
          },
        },
        h('div', { class: 'login-brand', translate: 'no' }, h('span', { class: 'mark', 'aria-hidden': 'true' }), 'CCC'),
        h(
          'div',
          { class: 'login-head' },
          h('h1', { id: 'login-title' }, 'Sign in to Command Center'),
          h('p', { class: 'login-sub' }, 'Coordinates your Claude Code sessions across machines.'),
        ),
        notice,
        h('div', { class: 'field' }, h('label', { for: 'pw' }, 'Owner password'), h('div', { class: 'pw-row' }, input, reveal)),
        error,
        submit,
      ),
      h('p', { class: 'login-foot' }, 'Agents connect with device tokens, not this password.'),
    ),
  );
  input.focus();
}

// ---------- live updates ----------

let stream;
const liveRefresh = debounce(() => void refresh({ live: true }), 300);

function connectStream() {
  stream?.close();
  stream = new EventSource('/api/stream');
  const live = document.getElementById('live');
  stream.addEventListener('ready', () => {
    live.textContent = 'Live';
    live.classList.add('on');
  });
  stream.addEventListener('ccc', liveRefresh);
  stream.addEventListener('error', () => {
    live.textContent = 'Reconnecting…';
    live.classList.remove('on');
  });
}

// Relative times drift without events; repaint them every 30 s.
setInterval(() => {
  if (!document.body.classList.contains('signed-out') && !dialog.open && !hasDraft()) render();
}, 30_000);

async function start() {
  const route = initRoute();
  try {
    await load();
  } catch (err) {
    if (err instanceof Unauthorized) return showLogin();
    mount(view, h('div', { class: 'empty' }, h('p', null, errorText(err)), h('button', { type: 'button', onclick: () => void start() }, 'Retry')));
    return;
  }
  document.body.classList.remove('signed-out');
  render();
  connectStream();
  if (route.session) showDetail(route.session);
}

void start();
