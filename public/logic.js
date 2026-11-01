// Pure UI logic: no DOM, no fetch. Imported by app.js, the views, and node:test.

export const VIEWS = ['board', 'questions', 'tasks', 'controls'];
/** Most urgent first. Statuses that need the owner come before the rest. */
export const STATUSES = ['blocked', 'waiting_permission', 'unreachable', 'paused', 'working', 'idle', 'offline'];
export const STATUS_LABEL = {
  blocked: 'Blocked',
  waiting_permission: 'Needs permission',
  unreachable: 'Unreachable',
  paused: 'Paused',
  working: 'Working',
  idle: 'Idle',
  offline: 'Offline',
};
/** Statuses that get a tinted row: the owner has to do something. */
export const NEEDS_YOU = new Set(['blocked', 'waiting_permission', 'unreachable']);
export const TASK_LABEL = { blocked: 'Blocked', in_progress: 'In progress', open: 'Not started', done: 'Done', cancelled: 'Cancelled' };
/** Task status → the session status whose colour it borrows. */
export const TASK_TONE = { blocked: 'blocked', in_progress: 'working', open: 'idle', done: 'working', cancelled: 'offline' };

const PROJECT_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function severityRank(status) {
  const i = STATUSES.indexOf(status);
  return i === -1 ? STATUSES.length : i;
}

export function sortSessions(sessions) {
  return [...sessions].sort((a, b) => severityRank(a.status) - severityRank(b.status) || a.name.localeCompare(b.name));
}

export function groupByProject(sessions) {
  const groups = new Map();
  for (const s of sessions) {
    if (!groups.has(s.project)) groups.set(s.project, []);
    groups.get(s.project).push(s);
  }
  return [...groups.keys()].sort().map((project) => ({ project, sessions: sortSessions(groups.get(project)) }));
}

export function countByStatus(sessions) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const s of sessions) if (s.status in counts) counts[s.status] += 1;
  return counts;
}

/** `#/<view>?project=&status=` or `#/session/<name>?project=`. Anything invalid falls back to the board. */
export function parseRoute(hash) {
  const raw = String(hash ?? '').replace(/^#\/?/, '');
  const [path = '', query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  const project = (params.get('project') ?? '').trim().toLowerCase();
  const route = { view: 'board', project: PROJECT_RE.test(project) ? project : '', status: '', session: '' };
  const [head = '', ...rest] = path.split('/');
  if (head === 'session') {
    let name = '';
    try {
      name = decodeURIComponent(rest.join('/'));
    } catch {
      name = '';
    }
    if (SESSION_RE.test(name)) route.session = name;
  } else if (VIEWS.includes(head)) {
    route.view = head;
  }
  const status = params.get('status') ?? '';
  if (route.view === 'board' && !route.session && STATUSES.includes(status)) route.status = status;
  return route;
}

export function formatRoute({ view = 'board', project = '', status = '', session = '' } = {}) {
  const params = new URLSearchParams();
  if (project) params.set('project', project);
  if (status && view === 'board' && !session) params.set('status', status);
  const query = params.toString();
  const path = session ? `session/${encodeURIComponent(session)}` : view;
  return `#/${path}${query ? `?${query}` : ''}`;
}

export function isTypingTarget(el) {
  if (!el) return false;
  const tag = String(el.tagName ?? '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}

const CHORD_MS = 1000;
const GO = { b: 'board', q: 'questions', t: 'tasks', c: 'controls' };

/** Maps one key press to an action. `pending` carries a half-typed `g` chord between calls. */
export function resolveKey(key, pending, now) {
  if (pending && now - pending.at <= CHORD_MS && GO[key]) return { action: `view:${GO[key]}`, pending: null };
  if (key === 'g') return { action: null, pending: { at: now } };
  if (key === 'j') return { action: 'row:next', pending: null };
  if (key === 'k') return { action: 'row:prev', pending: null };
  if (key === '?') return { action: 'help', pending: null };
  if (/^[0-9]$/.test(key)) return { action: `project:${key}`, pending: null };
  return { action: null, pending: null };
}

const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'narrow' });
const DTF = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function relTime(value, now = Date.now()) {
  if (!value) return 'never';
  const seconds = Math.max(0, (now - new Date(value).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return RTF.format(-Math.round(seconds / 60), 'minute');
  if (seconds < 86400) return RTF.format(-Math.round(seconds / 3600), 'hour');
  return RTF.format(-Math.round(seconds / 86400), 'day');
}

export const absTime = (value) => (value ? DTF.format(new Date(value)) : '');

const TASK_ORDER = { blocked: 0, in_progress: 1, open: 2, done: 3, cancelled: 4 };
const TASK_FILTERS = ['open', 'done', 'cancelled', 'all'];

export const isOpenTask = (t) => t.status !== 'done' && t.status !== 'cancelled';

export function filterTasks(tasks, filter) {
  const f = TASK_FILTERS.includes(filter) ? filter : 'open';
  return tasks
    .filter((t) => (f === 'all' ? true : f === 'open' ? isOpenTask(t) : t.status === f))
    .sort((a, b) => (TASK_ORDER[a.status] ?? 9) - (TASK_ORDER[b.status] ?? 9) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
