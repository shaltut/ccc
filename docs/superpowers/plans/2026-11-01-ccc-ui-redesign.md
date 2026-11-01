# CCC Owner UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the CCC owner UI as a calm, desktop-first ops console (sidebar, grouped board, drawer,
URL routing, keyboard shortcuts) that passes WCAG AA in light and dark, with every view in its own module.

**Architecture:**
- `public/logic.js` holds pure, node-testable helpers (sorting, routing, keys, time).
- `public/views/*.js` each render one page from a `ctx` object and never import `app.js`.
- `public/app.js` keeps state, fetching, SSE, the router and the shell.
- `style.css` is rewritten on semantic tokens; a test computes WCAG contrast from those tokens.
- The server gains exactly one static route for `/views/*.js`.

**Tech Stack:** Node ≥ 22.18 (type stripping), Hono, node:test (serial), vanilla ES modules with `h()`, plain CSS, Google Fonts (IBM Plex Sans + Mono).

**Spec:** `docs/superpowers/specs/2026-11-01-ccc-ui-redesign-design.md`

## Global Constraints

- DOM is built only with `h()`. Never `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` in any `public/**/*.js`.
- Every UI JS file is ≤ 800 lines.
- No new runtime or dev dependencies.
- `app.js` must keep matching these `test/ui.test.ts` regexes:
  - `function hasDraft\(`
  - `const liveRefresh = debounce\(\(\) => void refresh\(\{ live: true \}\), 300\);`
  - `!dialog\.open && !hasDraft\(\)\) render\(\);`
- `index.html` keeps `<script type="module" src="/app.js">`.
- Views receive `(ctx)` and return nodes. They import only `../dom.js` and `../logic.js`.
- Contrast: text ≥ 4.5:1 and non-text UI ≥ 3:1, in both themes.
- Transitions name their properties (never `all`), and `prefers-reduced-motion: reduce` disables motion.
- Copy:
  - Title Case on buttons.
  - `…` on loading labels and placeholders.
  - Errors say what to do next.
  - `translate="no"` on session, project and device names.
- Server API unchanged. The only server edit is `GET /views/:file{[a-z0-9-]+\.js}`.
- Test command: `npm test` (uses `ccc-test-pg` on 127.0.0.1:5544 through `test/helpers.ts`), then `npm run check`.
- Commits use `git -c user.name=shaltut -c user.email=itshaltoot96@gmail.com commit …` and end with the two attribution lines:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01VedgXUgL6iW3TBNCGKnxmr
  ```

## Plan rulings (made while planning, against the spec)

1. **Statuses beyond the spec's five.** The server also reports `waiting_permission` and `paused`.
   - Severity order is blocked < waiting_permission < unreachable < paused < working < idle < offline.
   - `waiting_permission` gets a tint, because the human must act in the terminal.
   - Cost if wrong: one array order.
2. **Controls uses `<section>` + `<h2>` instead of `<fieldset>` + `<legend>`.**
   - Reason: the Sessions block is a table, not a form, and h1 → h2 keeps the heading hierarchy (Vercel rule).
   - Cost if wrong: a markup swap.
3. **Move to project is an empty input with the placeholder "Move to…"**, beside a chip showing the current project.
   - Reason: a pre-filled input would count as a draft in `hasDraft` and freeze live refresh on the Controls page.
4. **Sessions are fetched unscoped (`/api/sessions`) and filtered client-side**, so the sidebar can mark projects with blocked
   sessions while one project is selected. Questions and tasks stay scoped by the server.
5. **Mid-branch styling.** Task 2 replaces the stylesheet. Pages not yet migrated render with base styles only until their
   task lands. Nothing is deployed before Task 9.
6. **Login error.** A wrong password returns 401, which `api()` turns into `Unauthorized('Signed out')`, so the old login
   page showed "Signed out". The login form now says "Wrong password."

## Review Focus

1. **A live refresh arrives while the owner is mid-action:**
   - Mid-action covers typing, a changed select, an open row menu, or a queued answer.
   - Expected: nothing they entered is wiped.
   - Pinned by the `hasDraft` selector test (Task 6) and the pending-answer render (Task 5).
2. **A garbage, stale or hand-edited URL hash.** Expected: falls back to the board or to All, never a blank page. Pinned by the `parseRoute` tests (Task 1) and the stale-project fallback in `load()` (Task 8).
3. **Shortcut keys pressed while typing in a field.** Expected: they type, they don't navigate. Pinned by `isTypingTarget` and the `resolveKey` tests (Task 1).
4. **Closing the tab inside the 5 s answer-undo window.** Expected: the browser warns first. Pinned by the `beforeunload` test (Task 5).
5. **Very long session names, summaries or project names.** Expected: they truncate with an ellipsis and never widen the layout. Pinned by the board CSS test (Task 3).
6. **Path tricks on `/views/`.** Expected: 404. Pinned by the route test (Task 3).

---

### Task 1: Pure UI logic

**Files:**
- Create: `public/logic.js`
- Modify: `public/dom.js:44-51` (replace `ago`)
- Test: `test/ui-logic.test.ts`

**Interfaces:**
- Produces (all exported from `public/logic.js`):
  - `VIEWS`, `STATUSES`, `STATUS_LABEL`, `NEEDS_YOU`, `TASK_LABEL`, `TASK_TONE`
  - `severityRank(status) → number`, `sortSessions(sessions) → sessions`
  - `groupByProject(sessions) → [{project, sessions}]`, `countByStatus(sessions) → {status: n}`
  - `parseRoute(hash) → {view, project, status, session}`, `formatRoute(route) → '#/…'`
  - `isTypingTarget(el) → bool`, `resolveKey(key, pending, now) → {action, pending}`
  - `relTime(value, now?) → string`, `absTime(value) → string`
  - `isOpenTask(t) → bool`, `filterTasks(tasks, filter) → tasks`
- `public/dom.js` keeps exporting `ago`, now an alias of `relTime`.

- [ ] **Step 1: Write the failing test**

`test/ui-logic.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Dynamic import of a plain browser module: typed `any`, so tsc needs no declarations.
const L = await import(new URL('../public/logic.js', import.meta.url).href);

type Row = { name: string; status: string; project: string };
const s = (name: string, status: string, project = 'p'): Row => ({ name, status, project });
const names = (rows: Row[]) => rows.map((r) => r.name);

test('sortSessions puts the sessions that need you first, then by name', () => {
  const out = L.sortSessions([
    s('b', 'idle'), s('a', 'working'), s('z', 'blocked'), s('c', 'offline'),
    s('y', 'unreachable'), s('x', 'waiting_permission'), s('w', 'paused'), s('q', 'mystery'),
  ]);
  assert.deepEqual(names(out), ['z', 'x', 'y', 'w', 'a', 'b', 'c', 'q']);
});

test('sortSessions does not mutate its input', () => {
  const input = [s('b', 'idle'), s('a', 'blocked')];
  L.sortSessions(input);
  assert.deepEqual(names(input), ['b', 'a']);
});

test('groupByProject sorts groups by name and rows by severity', () => {
  const g = L.groupByProject([s('k1', 'idle', 'kiosk'), s('w1', 'working', 'ihop'), s('w2', 'blocked', 'ihop')]);
  assert.deepEqual(
    g.map((x: { project: string; sessions: Row[] }) => [x.project, names(x.sessions)]),
    [['ihop', ['w2', 'w1']], ['kiosk', ['k1']]],
  );
});

test('countByStatus counts every known status and ignores unknown ones', () => {
  const c = L.countByStatus([s('a', 'blocked'), s('b', 'blocked'), s('c', 'idle'), s('d', 'mystery')]);
  assert.equal(c.blocked, 2);
  assert.equal(c.idle, 1);
  assert.equal(c.working, 0);
  assert.equal('mystery' in c, false);
});

test('parseRoute reads view, project, status and session', () => {
  assert.deepEqual(L.parseRoute('#/questions?project=iHop'), { view: 'questions', project: 'ihop', status: '', session: '' });
  assert.deepEqual(L.parseRoute('#/board?project=ihop&status=blocked'), { view: 'board', project: 'ihop', status: 'blocked', session: '' });
  assert.deepEqual(L.parseRoute('#/session/W2?project=ihop'), { view: 'board', project: 'ihop', status: '', session: 'W2' });
});

test('parseRoute falls back safely on garbage', () => {
  const board = { view: 'board', project: '', status: '', session: '' };
  const cases: [string, object][] = [
    ['', board],
    ['#', board],
    ['#view', board],
    ['#/nope', board],
    ['#/session/', board],
    ['#/session/%E0%A4%A', board],
    ['#/session/has%20space', board],
    ['#/board?project=has%20space', board],
    ['#/board?status=bogus', board],
    ['#/tasks?status=blocked', { ...board, view: 'tasks' }],
    ['#/session/W2?status=blocked', { ...board, session: 'W2' }],
  ];
  for (const [hash, expected] of cases) assert.deepEqual(L.parseRoute(hash), expected, hash);
});

test('formatRoute and parseRoute round-trip', () => {
  for (const r of [
    { view: 'board', project: '', status: '', session: '' },
    { view: 'board', project: 'ihop', status: 'blocked', session: '' },
    { view: 'tasks', project: 'kiosk', status: '', session: '' },
    { view: 'board', project: 'ihop', status: '', session: 'W2' },
    { view: 'board', project: '', status: '', session: 'a.b-c_d' },
  ]) {
    assert.deepEqual(L.parseRoute(L.formatRoute(r)), r);
  }
  assert.equal(L.formatRoute({ view: 'board' }), '#/board');
  assert.equal(L.formatRoute({ view: 'questions', status: 'blocked' }), '#/questions');
  assert.equal(L.formatRoute({ view: 'board', project: 'ihop', status: 'idle' }), '#/board?project=ihop&status=idle');
});

test('isTypingTarget is true only for editable fields', () => {
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(L.isTypingTarget({ tagName }), true, tagName);
  assert.equal(L.isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(L.isTypingTarget({ tagName: 'BUTTON' }), false);
  assert.equal(L.isTypingTarget(null), false);
});

test('resolveKey completes a g chord within one second', () => {
  const first = L.resolveKey('g', null, 1000);
  assert.equal(first.action, null);
  assert.ok(first.pending);
  assert.equal(L.resolveKey('q', first.pending, 1500).action, 'view:questions');
  assert.equal(L.resolveKey('b', first.pending, 1999).action, 'view:board');
  assert.equal(L.resolveKey('q', first.pending, 2500).action, null);
  assert.equal(L.resolveKey('b', null, 0).action, null);
});

test('resolveKey maps single keys', () => {
  assert.equal(L.resolveKey('j', null, 0).action, 'row:next');
  assert.equal(L.resolveKey('k', null, 0).action, 'row:prev');
  assert.equal(L.resolveKey('?', null, 0).action, 'help');
  assert.equal(L.resolveKey('0', null, 0).action, 'project:0');
  assert.equal(L.resolveKey('7', null, 0).action, 'project:7');
  assert.equal(L.resolveKey('x', null, 0).action, null);
});

test('relTime uses compact Intl wording', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const at = (sec: number) => new Date(now - sec * 1000).toISOString();
  assert.equal(L.relTime(null, now), 'never');
  assert.equal(L.relTime(at(10), now), 'just now');
  assert.equal(L.relTime(at(-30), now), 'just now');
  assert.equal(L.relTime(at(300), now), '5m ago');
  assert.equal(L.relTime(at(7200), now), '2h ago');
  assert.equal(L.relTime(at(86400), now), 'yesterday');
  assert.equal(L.relTime(at(3 * 86400), now), '3d ago');
  assert.equal(L.absTime(null), '');
  assert.match(L.absTime(at(0)), /2026/);
});

test('filterTasks filters, then orders blocked → in progress → not started, newest first', () => {
  const t = (id: number, status: string, updatedAt: string) => ({ id, status, updatedAt });
  const list = [
    t(1, 'open', '2026-11-01T10:00:00Z'),
    t(2, 'blocked', '2026-11-01T09:00:00Z'),
    t(3, 'done', '2026-11-01T08:00:00Z'),
    t(4, 'in_progress', '2026-11-01T07:00:00Z'),
    t(5, 'cancelled', '2026-11-01T06:00:00Z'),
    t(6, 'open', '2026-11-01T11:00:00Z'),
  ];
  const ids = (f: string) => L.filterTasks(list, f).map((x: { id: number }) => x.id);
  assert.deepEqual(ids('open'), [2, 4, 6, 1]);
  assert.deepEqual(ids('done'), [3]);
  assert.deepEqual(ids('cancelled'), [5]);
  assert.deepEqual(ids('all'), [2, 4, 6, 1, 3, 5]);
  assert.deepEqual(ids('bogus'), [2, 4, 6, 1]);
  assert.equal(L.isOpenTask({ status: 'blocked' }), true);
  assert.equal(L.isOpenTask({ status: 'done' }), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/ui-logic.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `public/logic.js`.

- [ ] **Step 3: Write `public/logic.js`**

```js
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
```

- [ ] **Step 4: Make `dom.js` use it**

In `public/dom.js`, add the import on line 1 (above the comment), then replace the whole `export function ago(value) { … }` block (lines 44-51) with an alias.

New first line:
```js
import { relTime } from './logic.js';
```
Replacement for the `ago` function:
```js
/** Kept for existing callers: compact `Intl` relative time ("5m ago"). */
export const ago = relTime;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/ui-logic.test.ts`
Expected: PASS, 12 tests.

Run: `npm test > .superpowers/t1.log 2>&1; tail -5 .superpowers/t1.log && npm run check`
Expected: every test passes (previous count 141, plus 12 new = 153); `tsc` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add public/logic.js public/dom.js test/ui-logic.test.ts
git -c user.name=shaltut -c user.email=itshaltoot96@gmail.com commit -m "feat(ui): pure logic module for sorting, routes, keys and time

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VedgXUgL6iW3TBNCGKnxmr"
```

---

### Task 2: Design tokens and foundation CSS

**Files:**
- Rewrite: `public/style.css` (the whole file)
- Test: `test/ui-contrast.test.ts`, `test/ui-css.test.ts`

**Interfaces:**
- Produces CSS tokens:
  - `--bg --surface --surface-2 --hover --selected --border --control-border`
  - `--text --text-muted --accent --accent-hover --on-accent --focus --danger`
  - `--st-<status>` for all seven statuses, and `--st-<blocked|waiting_permission|unreachable>-tint`
- Produces classes:
  - Type and text: `.mono .num .muted .meta .hint .sr-only`
  - Status: `.st .dot` and `[data-status]`, which sets `--st` and `--tint`
  - Buttons: `button.primary .quiet .danger .small .armed`
  - Layout and forms: `.panel .page-head .empty .chip .field .row .between .error-text`
  - Shell: `.skip .shell .side .brand .nav .side-h .project-list .pname .pcount .count .project-select .side-foot .live .login`
  - Overlays: `.toast` and `dialog`

- [ ] **Step 1: Write the failing tests**

`test/ui-contrast.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');

function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9_-]+):\s*(#[0-9a-f]{6})\s*;/gi)) out[m[1]!] = m[2]!.toLowerCase();
  return out;
}

function themes(): Record<string, Record<string, string>> {
  const roots = [...css.matchAll(/:root\s*\{([^}]*)\}/g)];
  assert.ok(roots.length >= 2, 'expected a light and a dark :root block');
  const darkAt = css.indexOf('@media (prefers-color-scheme: dark)');
  assert.ok(darkAt !== -1 && roots[1]!.index! > darkAt, 'the second :root block must sit inside the dark media query');
  const light = tokens(roots[0]![1]!);
  return { light, dark: { ...light, ...tokens(roots[1]![1]!) } };
}

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
const ratio = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

const STATUSES = ['working', 'blocked', 'waiting_permission', 'unreachable', 'paused', 'idle', 'offline'];
const TINTED = ['blocked', 'waiting_permission', 'unreachable'];
const SURFACES = ['bg', 'surface', 'surface-2', 'hover', 'selected'];
const TEXT = ['text', 'text-muted', 'accent', 'danger', ...STATUSES.map((s) => `st-${s}`)];

function pairs(): [string, string, number][] {
  const out: [string, string, number][] = [];
  for (const f of TEXT) for (const b of SURFACES) out.push([f, b, 4.5]);
  for (const s of TINTED) for (const f of ['text', 'text-muted', `st-${s}`]) out.push([f, `st-${s}-tint`, 4.5]);
  for (const b of ['accent', 'accent-hover', 'danger']) out.push(['on-accent', b, 4.5]);
  for (const b of ['bg', 'surface']) for (const f of ['focus', 'control-border']) out.push([f, b, 3]);
  return out;
}

test('ratio matches known WCAG values', () => {
  assert.equal(ratio('#000000', '#ffffff').toFixed(1), '21.0');
  assert.equal(ratio('#777777', '#ffffff').toFixed(2), '4.48');
});

for (const [name, t] of Object.entries(themes())) {
  test(`${name} theme: every text and UI pair meets WCAG AA`, () => {
    const failures: string[] = [];
    for (const [f, b, min] of pairs()) {
      assert.ok(t[f] && t[b], `${name}: missing token --${t[f] ? b : f}`);
      const r = ratio(t[f]!, t[b]!);
      if (r < min) failures.push(`--${f} on --${b}: ${r.toFixed(2)} < ${min}`);
    }
    assert.deepEqual(failures, []);
  });
}
```

`test/ui-css.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');

test('transitions name their properties and never use all', () => {
  for (const m of css.matchAll(/transition:\s*([^;]+);/g)) {
    const value = m[1]!.replace(/\s*!important\s*$/, '').trim();
    if (value === 'none') continue;
    for (const part of value.split(',')) {
      const prop = part.trim().split(/\s+/)[0]!;
      assert.match(prop, /^[a-z-]+$/, `transition "${value}" must start each part with a property`);
      assert.notEqual(prop, 'all', `transition: all is not allowed ("${value}")`);
    }
  }
});

test('focus stays visible', () => {
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus\)/);
  for (const m of css.matchAll(/([^{}]+)\{[^}]*outline:\s*(?:none|0)\s*;/g)) {
    assert.match(m[1]!, /:focus:not\(:focus-visible\)/, `outline removed outside :focus:not(:focus-visible): ${m[1]!.trim()}`);
  }
});

test('motion respects reduced-motion', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*animation: none !important;[^@]*transition: none !important;/);
});

test('mono text and numbers use tabular figures', () => {
  assert.match(css, /\.mono[^{]*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /\.num\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
});

test('native selects get explicit colours for dark mode', () => {
  assert.match(css, /select[^{]*\{[^}]*background-color:\s*var\(--surface\)[^}]*color:\s*var\(--text\)/);
});

test('signed-out hides the app chrome', () => {
  assert.match(css, /body\.signed-out \.side\s*\{[^}]*display:\s*none/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/ui-contrast.test.ts test/ui-css.test.ts`
Expected: FAIL:
- Contrast: `missing token --text`. The old file has `--ink`.
- CSS: the `focus-visible`, `.num`, `select` and `signed-out .side` assertions fail.

- [ ] **Step 3: Replace `public/style.css` entirely**

```css
/* CCC owner UI: a calm ops console.
   Colour lives in tokens. Status colour appears only as a rail, a dot and the status word. */

:root {
  color-scheme: light;
  --bg: #f4f4f5;
  --surface: #ffffff;
  --surface-2: #fafafa;
  --hover: #f4f4f5;
  --selected: #e4e4e7;
  --border: #e4e4e7;
  --control-border: #8a8a93;
  --text: #18181b;
  --text-muted: #52525b;
  --accent: #1d4ed8;
  --accent-hover: #1e40af;
  --on-accent: #ffffff;
  --focus: #2563eb;
  --danger: #b91c1c;

  --st-working: #166534;
  --st-blocked: #b91c1c;
  --st-waiting_permission: #92400e;
  --st-unreachable: #a21caf;
  --st-paused: #4338ca;
  --st-idle: #52525b;
  --st-offline: #63636b;
  --st-blocked-tint: #fef2f2;
  --st-waiting_permission-tint: #fffbeb;
  --st-unreachable-tint: #fdf4ff;

  --shadow: 0 8px 30px rgb(0 0 0 / 0.12);
  --radius: 6px;
  --font: 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --mono: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  --ease: cubic-bezier(0.2, 0, 0, 1);
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #09090b;
    --surface: #18181b;
    --surface-2: #1f1f23;
    --hover: #27272a;
    --selected: #303036;
    --border: #27272a;
    --control-border: #71717a;
    --text: #fafafa;
    --text-muted: #a1a1aa;
    --accent: #60a5fa;
    --accent-hover: #93c5fd;
    --on-accent: #0a0a0a;
    --focus: #60a5fa;
    --danger: #f87171;

    --st-working: #4ade80;
    --st-blocked: #f87171;
    --st-waiting_permission: #fbbf24;
    --st-unreachable: #e879f9;
    --st-paused: #a5b4fc;
    --st-idle: #a1a1aa;
    --st-offline: #9b9ba4;
    --st-blocked-tint: #2a1215;
    --st-waiting_permission-tint: #2a2010;
    --st-unreachable-tint: #2a1230;

    --shadow: 0 8px 30px rgb(0 0 0 / 0.5);
  }
}

/* ---------- status mapping ---------- */

[data-status='working'] { --st: var(--st-working); }
[data-status='blocked'] { --st: var(--st-blocked); --tint: var(--st-blocked-tint); }
[data-status='waiting_permission'] { --st: var(--st-waiting_permission); --tint: var(--st-waiting_permission-tint); }
[data-status='unreachable'] { --st: var(--st-unreachable); --tint: var(--st-unreachable-tint); }
[data-status='paused'] { --st: var(--st-paused); }
[data-status='idle'] { --st: var(--st-idle); }
[data-status='offline'] { --st: var(--st-offline); }

/* ---------- base ---------- */

* { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

@media (pointer: fine) {
  html { overscroll-behavior: none; }
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 var(--font);
  -webkit-font-smoothing: antialiased;
}

h1, h2, h3 { margin: 0; line-height: 1.25; text-wrap: balance; scroll-margin-top: 16px; }
h1 { font-size: 20px; font-weight: 600; }
h2 { font-size: 16px; font-weight: 600; }
h3 { font-size: 14px; font-weight: 600; }
p { margin: 0; }

.mono, code, kbd, pre, .name, .qid { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.num { font-variant-numeric: tabular-nums; }
.muted { color: var(--text-muted); }
.meta { color: var(--text-muted); font-size: 12px; }
.hint { color: var(--text-muted); font-size: 12px; }
.qid { color: var(--text-muted); font-weight: 500; }
kbd {
  font-size: 12px;
  padding: 0 4px;
  border: 1px solid var(--control-border);
  border-radius: 4px;
  background: var(--surface-2);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

a { color: var(--accent); }

:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

main:focus:not(:focus-visible) { outline: none; }

/* ---------- controls ---------- */

button, input, select, textarea { font: inherit; color: inherit; touch-action: manipulation; }

input, select, textarea {
  background-color: var(--surface);
  color: var(--text);
  border: 1px solid var(--control-border);
  border-radius: var(--radius);
  padding: 5px 10px;
  min-height: 32px;
  transition: border-color 150ms var(--ease);
}
textarea { resize: vertical; width: 100%; line-height: 1.5; }
input::placeholder, textarea::placeholder { color: var(--text-muted); }

button {
  cursor: pointer;
  min-height: 32px;
  padding: 0 12px;
  border-radius: var(--radius);
  border: 1px solid var(--control-border);
  background: var(--surface);
  color: var(--text);
  font-weight: 500;
  white-space: nowrap;
  transition: background-color 150ms var(--ease), border-color 150ms var(--ease), color 150ms var(--ease);
}
button:hover { background: var(--hover); border-color: var(--text-muted); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
button.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
button.quiet { border-color: transparent; background: transparent; }
button.quiet:hover { background: var(--hover); }
button.danger { color: var(--danger); border-color: transparent; background: transparent; }
button.danger:hover { background: var(--hover); }
button.armed { background: var(--danger); border-color: var(--danger); color: var(--on-accent); }
button.small { min-height: 28px; padding: 0 8px; font-size: 13px; }

/* ---------- primitives ---------- */

.row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.between { justify-content: space-between; }
.field { display: flex; flex-direction: column; gap: 4px; }
.field > label, label.field { font-size: 13px; font-weight: 500; }
.error-text { color: var(--danger); font-size: 13px; min-height: 1.5em; }

.panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
}

.page-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 16px; }

.empty {
  color: var(--text-muted);
  padding: 24px;
  text-align: center;
  border: 1px dashed var(--control-border);
  border-radius: 8px;
}
.empty code { color: var(--text); }

.chip {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--hover);
  color: var(--text-muted);
  font: 500 12px/1 var(--mono);
  white-space: nowrap;
}

.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--st, var(--st-offline)); }

.st {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--st, var(--text-muted));
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
}

pre {
  display: inline-block;
  margin: 8px 0 0;
  padding: 8px 12px;
  background: var(--hover);
  border-radius: var(--radius);
  overflow-x: auto;
  text-align: left;
}

/* ---------- shell ---------- */

.skip {
  position: absolute;
  left: 8px;
  top: -48px;
  z-index: 100;
  padding: 8px 12px;
  background: var(--surface);
  border: 1px solid var(--focus);
  border-radius: var(--radius);
}
.skip:focus { top: 8px; }

.shell { display: grid; grid-template-columns: 220px minmax(0, 1fr); min-height: 100dvh; }

.side {
  position: sticky;
  top: 0;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 16px 12px;
  border-right: 1px solid var(--border);
  background: var(--surface);
  overflow-y: auto;
}

.brand { font: 600 15px/1 var(--mono); letter-spacing: 0.04em; padding: 4px 8px; }

.nav { display: flex; flex-direction: column; gap: 2px; }

.nav a,
.project-list a {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 32px;
  padding: 0 8px;
  border-radius: var(--radius);
  color: var(--text);
  text-decoration: none;
  font-weight: 500;
  transition: background-color 150ms var(--ease);
}
.nav a:hover, .project-list a:hover { background: var(--hover); }
.nav a[aria-current='page'], .project-list a[aria-current='true'] { background: var(--selected); }

.count { font: 500 12px/1 var(--mono); font-variant-numeric: tabular-nums; color: var(--text-muted); }
.count.hot { color: var(--danger); }

.side-h {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 0 8px 6px;
}

.project-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.pname { font-family: var(--mono); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pcount { display: inline-flex; align-items: center; gap: 6px; }
.project-select { display: none; }

.side-foot { margin-top: auto; display: flex; align-items: center; justify-content: space-between; gap: 8px; }

.live { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-muted); }
.live::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--st-offline); }
.live.on::before { background: var(--st-working); animation: pulse 2s var(--ease) infinite; }

@keyframes pulse {
  50% { opacity: 0.35; }
}

main { min-width: 0; width: 100%; max-width: 1200px; padding: 20px 24px 48px; }

body.signed-out .side { display: none; }
body.signed-out .shell { grid-template-columns: minmax(0, 1fr); }

/* ---------- login ---------- */

.login {
  max-width: 360px;
  margin: 12vh auto 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 24px;
}
.login .brand { padding: 0; color: var(--text-muted); }
.login input { width: 100%; }

/* ---------- toast + dialogs ---------- */

.toast {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 50;
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: min(440px, calc(100vw - 32px));
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--text);
  color: var(--bg);
  box-shadow: var(--shadow);
  opacity: 0;
  transform: translateY(8px);
  pointer-events: none;
  transition: opacity 150ms var(--ease), transform 150ms var(--ease);
}
.toast.show { opacity: 1; transform: none; pointer-events: auto; }
.toast.error { background: var(--danger); color: var(--on-accent); }
.toast button { min-height: 28px; background: transparent; color: inherit; border-color: currentColor; }

dialog {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  padding: 0;
  box-shadow: var(--shadow);
  overscroll-behavior: contain;
}
dialog::backdrop { background: rgb(0 0 0 / 0.35); }

/* ---------- narrow screens ---------- */

@media (max-width: 1023px) {
  html { scroll-padding-top: 72px; }
  .shell { grid-template-columns: minmax(0, 1fr); }
  .side {
    z-index: 10;
    height: auto;
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    padding: 8px 12px;
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }
  .nav { flex-direction: row; flex-wrap: wrap; }
  .projects .side-h, .project-list { display: none; }
  .project-select { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-muted); }
  .side-foot { margin: 0 0 0 auto; }
  #keys-open { display: none; }
  main { padding: 16px; }
}

@media (max-width: 639px) {
  body { font-size: 16px; }
  button, input, select, .nav a { min-height: 44px; }
}

/* ---------- reduced motion ---------- */

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/ui-contrast.test.ts test/ui-css.test.ts`
Expected: PASS, 3 contrast tests and 6 CSS tests.

Run: `npm test > .superpowers/t2.log 2>&1; tail -5 .superpowers/t2.log && npm run check`
Expected: all pass (162), `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add public/style.css test/ui-contrast.test.ts test/ui-css.test.ts
git -c user.name=shaltut -c user.email=itshaltoot96@gmail.com commit -m "feat(ui): calm ops tokens and foundation CSS with contrast tests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VedgXUgL6iW3TBNCGKnxmr"
```

---

### Task 3: Board view module, `/views/` route, recursive UI tests

**Files:**
- Create: `public/views/board.js`
- Modify: `src/app.ts:56` (add the route after the `/:file` route)
- Modify: `public/dom.js` (add `timeEl`, `statusWord`)
- Modify: `public/app.js`:
  - add an import
  - add `status: ''` to state
  - add `ctx`
  - delete the `// ---------- board ----------` section (lines 165-216)
  - change the views map
- Rewrite: `test/ui.test.ts`
- Modify: `test/ui-css.test.ts` (append one test)
- Modify: `public/style.css` (append the board block)

**Interfaces:**
- Consumes (Task 1): `STATUSES`, `STATUS_LABEL`, `NEEDS_YOU`, `groupByProject`, `countByStatus`.
- Produces:
  - `public/dom.js`: `timeEl(value) → <time>` and `statusWord(status, label?) → <span class="st">`.
  - `public/views/board.js`: `boardView(ctx) → Node`.
  - `ctx` is `{ state, api, act, toast, render, navigate, openDetail, deviceLabel, liveSessions, openQuestions, inProject }`.
  - `navigate({ view?, status?, project?, session? })`.
  - Board rows are `button.srow` with `data-name`.

- [ ] **Step 1: Write the failing tests**

Replace `test/ui.test.ts` with:
```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { testApp } from './helpers.ts';

const t = await testApp();
after(() => t.sql.end());
const PUBLIC = new URL('../public/', import.meta.url);

/** Every .js file under public/, views/ included. */
async function jsFiles(dir: URL = PUBLIC): Promise<URL[]> {
  const out: URL[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...(await jsFiles(new URL(`${e.name}/`, dir))));
    else if (e.name.endsWith('.js')) out.push(new URL(e.name, dir));
  }
  return out;
}

test('the ui file scan reaches the view modules', async () => {
  assert.ok((await jsFiles()).some((f) => f.pathname.endsWith('/public/views/board.js')));
});

test('ui never uses innerHTML', async () => {
  const files = await jsFiles();
  assert.ok(files.length > 0);
  for (const f of files) {
    const src = await readFile(f, 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, f.pathname);
  }
});

test('live updates never remount over a half-typed draft', async () => {
  const src = await readFile(new URL('app.js', PUBLIC), 'utf8');
  assert.match(src, /function hasDraft\(/);
  // Only owner actions force a remount; SSE and the 30 s repaint go through the draft guard.
  assert.match(src, /const liveRefresh = debounce\(\(\) => void refresh\(\{ live: true \}\), 300\);/);
  assert.match(src, /!dialog\.open && !hasDraft\(\)\) render\(\);/);
});

test('ui js files stay under 800 lines', async () => {
  for (const f of await jsFiles()) {
    const lines = (await readFile(f, 'utf8')).split('\n').length;
    assert.ok(lines <= 800, `${f.pathname}: ${lines} lines`);
  }
});

test('views never import app.js', async () => {
  for (const f of (await jsFiles()).filter((x) => x.pathname.includes('/views/'))) {
    assert.doesNotMatch(await readFile(f, 'utf8'), /from '\.\.\/app\.js'/, f.pathname);
  }
});

test('index served at /', async () => {
  const res = await t.app.request('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await res.text(), /<script type="module" src="\/app.js">/);
});

test('view modules are served as JavaScript', async () => {
  const res = await t.app.request('/views/board.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/javascript/);
  assert.match(await res.text(), /export function boardView/);
});

test('the views route serves plain file names only', async () => {
  for (const path of ['/views/..%2Fapp.js', '/views/nope.js', '/views/board.ts', '/views/sub/board.js', '/views/Board.js']) {
    assert.equal((await t.app.request(path)).status, 404, path);
  }
});
```

Append to `test/ui-css.test.ts`:
```ts
test('board rows truncate long text instead of widening the layout', () => {
  assert.match(css, /\.srow\s*\{[^}]*grid-template-columns:[^;]*minmax\(0, 1fr\)/);
  assert.match(css, /\.srow \.summary\s*\{[^}]*min-width:\s*0[^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.srow \.name\s*\{[^}]*text-overflow:\s*ellipsis/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/ui.test.ts test/ui-css.test.ts`
Expected: FAIL in exactly three tests:
- "the ui file scan reaches the view modules"
- "view modules are served as JavaScript" (404)
- "board rows truncate…"

The rest pass, including "views never import app.js" (vacuously: no view exists yet).

- [ ] **Step 3: Add the static route**

In `src/app.ts`, after the `app.get('/:file{…}', …)` block (it ends at line 60), add:
```ts
  // View modules: one level, lower-case names only, so no path can climb out of public/views/.
  app.get('/views/:file{[a-z0-9-]+\\.js}', async (c) =>
    (await fileResponse(`public/views/${c.req.param('file')}`, CONTENT_TYPES.js!)) ?? notFound(),
  );
```

- [ ] **Step 4: Add the DOM helpers**

In `public/dom.js`, change the Task 1 import line to:
```js
import { relTime, absTime, STATUS_LABEL } from './logic.js';
```
Then, after `export const ago = relTime;`, add:
```js
/** A <time> with the machine value, the absolute time on hover, and a relative label. */
export function timeEl(value) {
  return h('time', { datetime: value ? new Date(value).toISOString() : null, title: absTime(value) || null }, relTime(value));
}

/** Dot plus status word, coloured through [data-status]: never colour alone. */
export function statusWord(status, label = STATUS_LABEL[status] ?? status) {
  return h('span', { class: 'st', 'data-status': status }, h('span', { class: 'dot', 'aria-hidden': 'true' }), label);
}
```

- [ ] **Step 5: Write `public/views/board.js`**

```js
import { h, timeEl, statusWord } from '../dom.js';
import { STATUSES, STATUS_LABEL, NEEDS_YOU, groupByProject, countByStatus } from '../logic.js';

const LAUNCH = 'CCC_PROJECT=ihop CCC_SESSION=W1 claude';

function secondLine(s) {
  if (s.status === 'unreachable') return 'Not responding. Nudge it in its terminal.';
  if (s.status === 'waiting_permission') return 'Waiting on a permission prompt in its terminal.';
  return s.blocker || null;
}

function row(ctx, s) {
  const summary = s.workingOn || (s.currentTask ? `T${s.currentTask.id} ${s.currentTask.title}` : '');
  const second = secondLine(s);
  return h(
    'li',
    null,
    h(
      'button',
      {
        type: 'button',
        class: `srow${NEEDS_YOU.has(s.status) ? ' hot' : ''}`,
        'data-status': s.status,
        dataset: { name: s.name },
        onclick: () => ctx.openDetail(s.name),
      },
      h('span', { class: 'rail', 'aria-hidden': 'true' }),
      h(
        'span',
        { class: 'name', translate: 'no', title: s.name },
        s.name,
        s.role === 'orchestrator' ? h('span', { class: 'star', role: 'img', 'aria-label': 'orchestrator', title: 'Orchestrator' }, ' ★') : null,
      ),
      statusWord(s.status),
      h('span', { class: 'summary', dir: 'auto', title: summary || null }, summary || h('span', { class: 'muted' }, '—')),
      h(
        'span',
        { class: 'flags' },
        s.unread ? h('span', { class: 'chip' }, `${s.unread} unread`) : null,
        s.pausePending ? h('span', { class: 'chip' }, 'Pause pending') : null,
      ),
      h('span', { class: 'seen meta' }, timeEl(s.lastHeartbeatAt ?? s.createdAt)),
      second ? h('span', { class: 'second', dir: 'auto' }, second) : null,
    ),
  );
}

function summaryStrip(ctx, counts) {
  const { state } = ctx;
  return h(
    'div',
    { class: 'summary-strip', role: 'group', 'aria-label': 'Filter by status' },
    STATUSES.filter((st) => counts[st] > 0 || st === state.status).map((st) =>
      h(
        'button',
        {
          type: 'button',
          class: 'stat',
          'data-status': st,
          'aria-pressed': String(state.status === st),
          onclick: () => ctx.navigate({ status: state.status === st ? '' : st }),
        },
        h('span', { class: 'dot', 'aria-hidden': 'true' }),
        h('span', { class: 'num' }, String(counts[st])),
        STATUS_LABEL[st],
      ),
    ),
  );
}

function waitingBanner(ctx, waiting) {
  const blocking = waiting.filter((q) => q.isBlocking).length;
  return h(
    'div',
    { class: `waiting${blocking ? ' hot' : ''}`, 'data-status': blocking ? 'blocked' : null },
    h(
      'p',
      null,
      h('strong', { class: 'num' }, String(waiting.length)),
      waiting.length === 1 ? ' question waiting' : ' questions waiting',
      blocking ? h('span', { class: 'muted' }, ` · ${blocking} blocking`) : null,
    ),
    h('button', { type: 'button', class: 'primary small', onclick: () => ctx.navigate({ view: 'questions', status: '' }) }, 'Answer'),
  );
}

function emptyBoard() {
  return h(
    'div',
    { class: 'empty' },
    h('p', null, 'No sessions yet.'),
    h('p', { class: 'hint' }, 'Create a device token under Controls, run ', h('code', null, 'ccc setup'), ' on that machine, then launch:'),
    h('pre', null, h('code', { translate: 'no' }, LAUNCH)),
  );
}

export function boardView(ctx) {
  const { state } = ctx;
  const all = ctx.liveSessions();
  const shown = state.status ? all.filter((s) => s.status === state.status) : all;
  const waiting = ctx.openQuestions();
  const orchestrator = (project) => state.projects.find((p) => p.name === project)?.orchestrator;
  let body;
  if (!all.length) body = emptyBoard();
  else if (!shown.length)
    body = h(
      'p',
      { class: 'empty' },
      `No ${(STATUS_LABEL[state.status] ?? state.status).toLowerCase()} sessions. `,
      h('button', { type: 'button', class: 'quiet small', onclick: () => ctx.navigate({ status: '' }) }, 'Clear Filter'),
    );
  else
    body = groupByProject(shown).map((g) =>
      h(
        'section',
        { class: 'group', 'aria-label': `Project ${g.project}` },
        state.project
          ? null
          : h(
              'h2',
              { class: 'group-h' },
              h('span', { translate: 'no' }, g.project),
              orchestrator(g.project)
                ? h('span', { class: 'meta' }, 'orchestrator ', h('span', { class: 'mono', translate: 'no' }, orchestrator(g.project)))
                : h('span', { class: 'meta' }, 'no orchestrator'),
            ),
        h('ul', { class: 'rows' }, g.sessions.map((s) => row(ctx, s))),
      ),
    );
  return h(
    'section',
    { class: 'board', 'aria-labelledby': 'board-title' },
    h(
      'div',
      { class: 'page-head' },
      h('h1', { id: 'board-title' }, state.project ? h('span', { translate: 'no' }, state.project) : 'All Projects'),
      h('span', { class: 'meta num' }, `${all.length} ${all.length === 1 ? 'session' : 'sessions'}`),
    ),
    all.length ? summaryStrip(ctx, countByStatus(all)) : null,
    waiting.length ? waitingBanner(ctx, waiting) : null,
    body,
  );
}
```

- [ ] **Step 6: Wire it into the current `app.js`**

1. Below the `dom.js` import on line 1 add:
   ```js
   import { boardView } from './views/board.js';
   ```
2. In the `const state = { … }` literal (line 35), add `status: '',` after `project: readProject(),`.
3. Directly after `const openQuestions = () => …;` (line 66), add:
   ```js
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
   ```
4. Delete the whole `// ---------- board ----------` section: the `strip` and `boardView` functions, from that comment line down to just before `// ---------- session detail ----------`.
5. In `render()`, change the views map so the board receives `ctx`:
   ```js
   const views = { board: () => boardView(ctx), questions: questionsView, tasks: tasksView, controls: controlsView };
   ```

- [ ] **Step 7: Append the board CSS to `public/style.css`**

Insert this block **above** the `/* ---------- narrow screens ---------- */` section:
```css
/* ---------- board ---------- */

.summary-strip { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }

.stat {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 13px;
}
.stat .num { font-family: var(--mono); font-weight: 600; }
.stat[aria-pressed='true'] { background: var(--selected); border-color: var(--text-muted); }

.waiting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
  padding: 8px 12px 8px 14px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius);
  background: var(--surface);
}
.waiting.hot { border-left-color: var(--st); background: var(--tint); }

.group + .group { margin-top: 20px; }

.group-h {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 0 0 6px 4px;
  font: 600 12px/1.4 var(--mono);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}
.group-h .meta { font-family: var(--font); font-weight: 400; text-transform: none; letter-spacing: 0; }

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  overflow: hidden;
}
.rows > li + li { border-top: 1px solid var(--border); }

.srow {
  display: grid;
  grid-template-columns: 3px minmax(96px, 160px) 140px minmax(0, 1fr) auto 72px;
  align-items: center;
  column-gap: 12px;
  row-gap: 2px;
  width: 100%;
  min-height: 40px;
  padding: 6px 12px 6px 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  text-align: left;
  font-weight: 400;
}
.srow:hover { background: var(--hover); }
.srow.hot { background: var(--tint); }
.srow.hot:hover { background: var(--tint); box-shadow: inset 0 0 0 1px var(--st); }
.srow:focus-visible { outline-offset: -2px; }
.srow .rail { align-self: stretch; grid-row: 1 / span 2; background: var(--st); border-radius: 0 2px 2px 0; }
.srow[data-status='idle'] .rail, .srow[data-status='offline'] .rail { opacity: 0.4; }
.srow .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.srow[data-status='offline'] .name, .srow[data-status='offline'] .summary { color: var(--text-muted); }
.srow .summary { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.srow .flags { display: flex; gap: 4px; }
.srow .seen { text-align: right; white-space: nowrap; }
.srow .second { grid-column: 3 / -1; color: var(--st); font-size: 13px; overflow-wrap: anywhere; }
.star { color: var(--text-muted); }

@media (max-width: 639px) {
  .srow { grid-template-columns: 3px minmax(0, 1fr) auto; padding: 8px 12px 8px 0; }
  .srow .rail { grid-row: 1 / span 4; }
  .srow .summary, .srow .flags, .srow .second { grid-column: 2 / -1; }
  .srow .seen { display: none; }
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test test/ui.test.ts test/ui-css.test.ts`
Expected: PASS, all 8 UI tests and 7 CSS tests.

Run: `npm test > .superpowers/t3.log 2>&1; tail -5 .superpowers/t3.log && npm run check`
Expected: all pass (167), `tsc` clean.

- [ ] **Step 9: Commit**

```bash
git add src/app.ts public/dom.js public/views/board.js public/app.js public/style.css test/ui.test.ts test/ui-css.test.ts
git -c user.name=shaltut -c user.email=itshaltoot96@gmail.com commit -m "feat(ui): grouped, severity-sorted board as a view module

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VedgXUgL6iW3TBNCGKnxmr"
```

---

### Task 4: Session drawer

**Files:**
- Create: `public/views/detail.js`
- Modify: `public/dom.js` (add `busy`)
- Modify: `public/app.js`:
  - add an import
  - delete `STATUS_LABEL` (lines 3-11)
  - replace the `// ---------- session detail ----------` section
- Modify: `public/style.css` (append the drawer block)
- Test: `test/ui-css.test.ts` (append)

**Interfaces:**
- Consumes: `timeEl` and `statusWord` (Task 3), plus `ctx`.
- Produces:
  - `renderDetail(ctx, dialog, name) → Promise<boolean>` (false when no live session has that name), from `public/views/detail.js`.
  - `describeEvent(e) → string`, from the same file.
  - `busy(button, label, run) → Promise<void>`, from `public/dom.js`.
  - In `app.js`: `showDetail(name)` and `openDetail(name)`.

- [ ] **Step 1: Write the failing test**

Append to `test/ui-css.test.ts`:
```ts
test('the session detail is a right-hand drawer', () => {
  assert.match(css, /\.drawer\s*\{[^}]*margin:\s*0 0 0 auto[^}]*height:\s*100dvh/);
  assert.match(css, /\.drawer\[open\]\s*\{[^}]*animation:\s*slide-in/);
});
```
Also append to `test/ui.test.ts`:
```ts
test('the detail view is its own module', async () => {
  const src = await readFile(new URL('views/detail.js', PUBLIC), 'utf8');
  assert.match(src, /export async function renderDetail\(ctx, dialog, name\)/);
  assert.match(src, /export function describeEvent\(/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/ui.test.ts test/ui-css.test.ts`
Expected: FAIL. The drawer CSS assertion fails, and `views/detail.js` doesn't exist (ENOENT).

- [ ] **Step 3: Add `busy` to `public/dom.js`**

Append:
```js
/** Disables a button and swaps its label while `run` is in flight; restores it if still on the page. */
export async function busy(button, label, run) {
  const idle = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    await run();
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = idle;
    }
  }
}
```

- [ ] **Step 4: Write `public/views/detail.js`**

```js
import { h, mount, api, timeEl, statusWord, busy } from '../dom.js';
import { STATUS_LABEL } from '../logic.js';

export function describeEvent(e) {
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

/** Fills the drawer for `name`. Returns false (and closes it) when no live session has that name. */
export async function renderDetail(ctx, dialog, name) {
  const s = ctx.state.sessions.find((x) => x.name === name && !x.retiredAt);
  if (!s) {
    if (dialog.open) dialog.close();
    return false;
  }
  let events = [];
  try {
    events = (await api('GET', `/api/events?session=${encodeURIComponent(name)}&limit=60`)).events;
  } catch (err) {
    ctx.toast(err.message, true);
  }
  const body = h('textarea', { id: 'msg-body', rows: 3, required: true, maxlength: 65536, placeholder: 'e.g. Finish this task, then summarise what changed…' });
  const kind = h('select', { id: 'msg-kind' }, h('option', { value: 'instruction' }, 'Instruction'), h('option', { value: 'note' }, 'Note'));
  const send = h('button', { type: 'submit', class: 'primary' }, 'Send Message');
  const control = (action, label) =>
    h('button', { type: 'button', onclick: () => ctx.act(() => api('POST', '/api/control', { target: s.name, action }), `${label} sent to ${s.name}`) }, label);
  mount(
    dialog,
    h(
      'div',
      { class: 'detail' },
      h(
        'header',
        { class: 'detail-head' },
        h(
          'div',
          { class: 'detail-title' },
          h('h2', { id: 'detail-title', class: 'mono', translate: 'no' }, s.name),
          statusWord(s.status),
          h('span', { class: 'chip', translate: 'no' }, s.project),
          h('span', { class: 'chip' }, s.role === 'orchestrator' ? '★ orchestrator' : s.role),
        ),
        h('button', { type: 'button', class: 'quiet small', onclick: () => dialog.close() }, 'Close'),
      ),
      h('p', { class: 'meta' }, h('span', { translate: 'no' }, ctx.deviceLabel(s.deviceId)), ' · seen ', timeEl(s.lastHeartbeatAt ?? s.createdAt)),
      h(
        'section',
        { class: 'detail-sec' },
        h('h3', null, 'Now'),
        h('p', { dir: 'auto' }, s.workingOn || h('span', { class: 'muted' }, 'No status reported yet.')),
        s.blocker ? h('p', { class: 'blocker', 'data-status': 'blocked', dir: 'auto' }, s.blocker) : null,
        s.status === 'unreachable' ? h('p', { class: 'blocker', 'data-status': 'unreachable' }, 'Not responding. Nudge it in its terminal.') : null,
        s.currentTask ? h('p', null, h('span', { class: 'qid' }, `T${s.currentTask.id}`), ' ', h('span', { dir: 'auto' }, s.currentTask.title)) : null,
      ),
      h('div', { class: 'row' }, s.paused || s.pausePending ? control('resume', 'Resume') : control('pause', 'Pause')),
      h(
        'form',
        {
          class: 'detail-sec',
          onsubmit: (e) => {
            e.preventDefault();
            void busy(send, 'Sending…', () =>
              ctx.act(() => api('POST', '/api/messages', { to: s.name, body: body.value, kind: kind.value }), `Sent to ${s.name}. It lands when the current turn ends.`),
            );
          },
        },
        h('label', { class: 'field', for: 'msg-body' }, `Message ${s.name}`),
        body,
        h('p', { class: 'hint' }, 'Delivered when its current turn ends.'),
        h('div', { class: 'row' }, h('label', { class: 'sr-only', for: 'msg-kind' }, 'Message kind'), kind, send),
      ),
      h(
        'section',
        { class: 'detail-sec' },
        h('h3', null, 'Timeline'),
        events.length
          ? h('ol', { class: 'timeline' }, events.map((e) => h('li', null, timeEl(e.createdAt), h('span', { dir: 'auto' }, describeEvent(e)))))
          : h('p', { class: 'muted' }, 'Nothing recorded yet.'),
      ),
    ),
  );
  return true;
}
```

- [ ] **Step 5: Wire it into `app.js`**

1. Add the import below the board import:
   ```js
   import { renderDetail as drawDetail } from './views/detail.js';
   ```
2. Delete the `const STATUS_LABEL = { … };` block at the top. Only the moved code used it.
3. Replace the whole `// ---------- session detail ----------` section (`describeEvent`, `openDetail`, `renderDetail` and the `dialog.addEventListener('close', …)`) with:
   ```js
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
   ```
4. In `index.html`, change `<dialog id="detail" aria-labelledby="detail-title">` to `<dialog id="detail" class="drawer" aria-labelledby="detail-title">`.

- [ ] **Step 6: Append the drawer CSS to `public/style.css`**

Insert above `/* ---------- narrow screens ---------- */`:
```css
/* ---------- session drawer ---------- */

.drawer {
  margin: 0 0 0 auto;
  height: 100dvh;
  max-height: none;
  width: min(480px, 100vw);
  border-width: 0 0 0 1px;
  border-radius: 0;
}
.drawer[open] { animation: slide-in 200ms var(--ease); }

@keyframes slide-in {
  from { transform: translateX(24px); opacity: 0; }
}

.detail { display: flex; flex-direction: column; gap: 16px; padding: 16px 20px 24px; }
.detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.detail-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
.detail-title h2 { font-size: 20px; }
.detail-sec { display: flex; flex-direction: column; gap: 8px; }
.detail-sec h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); }

.blocker {
  padding: 8px 10px;
  border-left: 3px solid var(--st);
  border-radius: 0 var(--radius) var(--radius) 0;
  background: var(--tint, var(--hover));
  color: var(--text);
  overflow-wrap: anywhere;
}

.timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.timeline li {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 12px;
  padding: 6px 0;
  border-top: 1px solid var(--border);
  font-size: 13px;
  overflow-wrap: anywhere;
}
.timeline time { color: var(--text-muted); font-variant-numeric: tabular-nums; }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/ui.test.ts test/ui-css.test.ts`
Expected: PASS.

Run: `npm test > .superpowers/t4.log 2>&1; tail -5 .superpowers/t4.log && npm run check`
Expected: all pass (169), `tsc` clean.

- [ ] **Step 8: Commit**

```bash
git add public/views/detail.js public/dom.js public/app.js public/index.html public/style.css test/ui.test.ts test/ui-css.test.ts
git -c user.name=shaltut -c user.email=itshaltoot96@gmail.com commit -m "feat(ui): session detail as a right-hand drawer module

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VedgXUgL6iW3TBNCGKnxmr"
```

---

### Task 5: Questions page with an undo window

**Files:**
- Create: `public/views/questions.js`
- Modify: `public/app.js`:
  - replace `toast`
  - add `pending: new Map()` to state
  - add `beforeunload`
  - delete the `// ---------- questions ----------` section
  - change the views map
- Modify: `public/style.css` (append the questions block)
- Test: `test/ui.test.ts` (append)

**Interfaces:**
- Consumes:
  - `ctx.state.pending: Map<number, {timer, label}>`
  - `ctx.toast(message, isError?, action?)`, where `action` is `{label, run}`
  - `ctx.act`, `ctx.render`, `ctx.openQuestions`
  - `timeEl`, `confirmButton`, `minutesSince`
- Produces: `questionsView(ctx) → Node`.

- [ ] **Step 1: Write the failing test**

Append to `test/ui.test.ts`:
```ts
test('queued answers have an undo window and guard against closing the page', async () => {
  const app = await readFile(new URL('app.js', PUBLIC), 'utf8');
  assert.match(app, /addEventListener\('beforeunload'[^\n]*state\.pending\.size/);
  const q = await readFile(new URL('views/questions.js', PUBLIC), 'utf8');
  assert.match(q, /const UNDO_MS = 5000;/);
  assert.match(q, /clearTimeout\(p\.timer\)/);
  assert.match(q, /export function questionsView\(ctx\)/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/ui.test.ts`
Expected: FAIL on the new test (no `beforeunload` in `app.js`).

- [ ] **Step 3: Write `public/views/questions.js`**

```js
import { h, api, timeEl, confirmButton, minutesSince } from '../dom.js';

const OVERDUE_MIN = 30;
const UNDO_MS = 5000;

function undoAnswer(ctx, id) {
  const p = ctx.state.pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  ctx.state.pending.delete(id);
  ctx.render();
  ctx.toast(`Answer to Q${id} cancelled`);
}

/** Holds the answer for UNDO_MS, then sends it. Undo cancels it before anything reaches the server. */
function queueAnswer(ctx, q, payload, label) {
  const timer = setTimeout(() => {
    ctx.state.pending.delete(q.id);
    void ctx.act(() => api('POST', `/api/questions/${q.id}/answer`, payload), `Answered Q${q.id}`);
  }, UNDO_MS);
  ctx.state.pending.set(q.id, { timer, label });
  ctx.render();
  ctx.toast(`Answer to Q${q.id} sends in 5 s`, false, { label: 'Undo', run: () => undoAnswer(ctx, q.id) });
}

function closedText(q) {
  if (q.status === 'withdrawn') return 'Withdrawn';
  const answer = [q.options?.find((o) => o.key === q.answerChoice)?.label, q.answerText].filter(Boolean).join(' — ');
  return [`Answered by ${q.answeredBy} `, timeEl(q.answeredAt), answer ? `: ${answer}` : ''];
}

function answerForm(ctx, q) {
  const id = `ans-${q.id}`;
  const text = h('textarea', {
    id,
    rows: 2,
    maxlength: 65536,
    placeholder: 'e.g. Use the staging creds in 1Password…',
    onkeydown: (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit(null);
      }
    },
  });
  function submit(choice) {
    const option = choice ? q.options.find((o) => o.key === choice) : null;
    const typed = text.value.trim();
    if (!option && !typed) {
      text.focus();
      ctx.toast('Type an answer or pick an option first.', true);
      return;
    }
    queueAnswer(ctx, q, { ...(choice ? { choice } : {}), ...(typed ? { text: text.value } : {}) }, option?.label ?? typed);
  }
  return h(
    'div',
    { class: 'answer' },
    q.options?.length
      ? h('div', { class: 'choices', role: 'group', 'aria-label': `Options for Q${q.id}` }, q.options.map((o) => h('button', { type: 'button', class: 'choice', onclick: () => submit(o.key) }, o.label)))
      : null,
    h('label', { class: 'field', for: id }, q.options?.length ? 'Or write an answer' : 'Your answer'),
    text,
    h(
      'div',
      { class: 'row between' },
      h('span', { class: 'hint' }, h('kbd', null, '⌘'), ' or ', h('kbd', null, 'Ctrl'), ' + ', h('kbd', null, 'Enter'), ' to send'),
      h(
        'div',
        { class: 'row' },
        confirmButton('Withdraw', 'Confirm Withdraw', () => ctx.act(() => api('POST', `/api/questions/${q.id}/withdraw`, {}), `Withdrew Q${q.id}`)),
        h('button', { type: 'button', class: 'primary', onclick: () => submit(null) }, 'Send Answer'),
      ),
    ),
  );
}

function card(ctx, q) {
  const { state } = ctx;
  const open = q.status === 'open';
  const blocking = open && q.isBlocking;
  const overdue = blocking && minutesSince(q.createdAt) > OVERDUE_MIN;
  const pending = state.pending.get(q.id);
  const to = q.addressedTo === 'role:orchestrator' ? 'orchestrator' : q.addressedTo;
  return h(
    'article',
    { class: `question${blocking ? ' hot' : ''}`, 'data-status': blocking ? 'blocked' : null, 'aria-labelledby': `q-${q.id}` },
    h(
      'header',
      { class: 'q-head' },
      h('span', { class: 'qid', id: `q-${q.id}` }, `Q${q.id}`),
      h('span', null, h('span', { class: 'mono', translate: 'no' }, q.askedBy), ' → ', h('span', { class: 'mono', translate: 'no' }, to)),
      state.project ? null : h('span', { class: 'chip', translate: 'no' }, q.project),
      blocking
        ? h('span', { class: 'st', 'data-status': 'blocked' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), overdue ? `Blocking ${q.askedBy} · 30+ min` : `Blocking ${q.askedBy}`)
        : null,
      h('span', { class: 'meta q-time' }, timeEl(q.createdAt)),
    ),
    h('p', { class: 'q-body', dir: 'auto' }, q.body),
    q.context ? h('details', { class: 'q-context' }, h('summary', null, 'Context'), h('p', { class: 'q-body', dir: 'auto' }, q.context)) : null,
    !open
      ? h('p', { class: 'answered' }, closedText(q))
      : pending
        ? h(
            'div',
            { class: 'pending row between' },
            h('span', null, 'Sending ', h('strong', { dir: 'auto' }, `“${pending.label}”`), '…'),
            h('button', { type: 'button', class: 'small', onclick: () => undoAnswer(ctx, q.id) }, 'Undo'),
          )
        : answerForm(ctx, q),
  );
}

export function questionsView(ctx) {
  const open = ctx
    .openQuestions()
    .sort((a, b) => Number(b.isBlocking) - Number(a.isBlocking) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const closed = ctx.state.questions.filter((q) => q.status !== 'open').slice(0, 40);
  return h(
    'section',
    { class: 'questions', 'aria-labelledby': 'q-title' },
    h('div', { class: 'page-head' }, h('h1', { id: 'q-title' }, 'Questions'), h('span', { class: 'meta num' }, `${open.length} open`)),
    open.length ? h('div', { class: 'q-list' }, open.map((q) => card(ctx, q))) : h('p', { class: 'empty' }, "No open questions. Agents ask here when they're stuck."),
    closed.length ? h('details', { class: 'history' }, h('summary', null, `Answered (${closed.length})`), h('div', { class: 'q-list' }, closed.map((q) => card(ctx, q)))) : null,
  );
}
```

- [ ] **Step 4: Wire it into `app.js`**

1. Add the import:
   ```js
   import { questionsView } from './views/questions.js';
   ```
2. In the `state` literal, add `pending: new Map(),`.
3. Replace the whole `function toast(…) { … }` with:
   ```js
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
   ```
4. Directly after the `toast` function add:
   ```js
   window.addEventListener('beforeunload', (e) => { if (state.pending.size) e.preventDefault(); });
   ```
5. Delete the `// ---------- questions ----------` section (`questionCard` and the old `questionsView`).
6. Views map: `questions: () => questionsView(ctx),`.

- [ ] **Step 5: Append the questions CSS**

Insert above `/* ---------- narrow screens ---------- */`:
```css
/* ---------- questions ---------- */

.q-list { display: flex; flex-direction: column; gap: 12px; }

.question {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.question.hot { border-left: 3px solid var(--st); }

.q-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; font-size: 13px; }
.q-time { margin-left: auto; }
.q-body { max-width: 72ch; white-space: pre-wrap; overflow-wrap: anywhere; }
.q-context summary { cursor: pointer; color: var(--text-muted); font-size: 13px; }

.answer { display: flex; flex-direction: column; gap: 6px; max-width: 72ch; }
.choices { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 4px; }
.choice { min-height: 36px; }
.pending { padding: 8px 12px; background: var(--hover); border-radius: var(--radius); max-width: 72ch; }
.answered { color: var(--text-muted); font-size: 13px; }

.history { margin-top: 24px; }
.history > summary { cursor: pointer; font-weight: 600; margin-bottom: 12px; }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/ui.test.ts`
Expected: PASS.

Run: `npm test > .superpowers/t5.log 2>&1; tail -5 .superpowers/t5.log && npm run check`
Expected: all pass (170), `tsc` clean.

- [ ] **Step 7: Commit**

```bash
git add public/views/questions.js public/app.js public/style.css test/ui.test.ts
git -c user.name=shaltut -c user.email=itshaltoot96@gmail.com commit -m "feat(ui): questions page with labelled answers and a 5 s undo window

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VedgXUgL6iW3TBNCGKnxmr"
```

---

### Task 6: Tasks page as a table

**Files:**
- Create: `public/views/tasks.js`
- Modify: `public/app.js`:
  - add `taskFilter: 'open'` to state
  - replace `hasDraft`
  - delete the `// ---------- tasks ----------` section and the `TASK_GROUPS` constant
  - change the views map
- Modify: `public/style.css` (append the tasks block)
- Test: `test/ui.test.ts` (append)

**Interfaces:**
- Consumes: `filterTasks`, `groupByProject`, `TASK_LABEL`, `TASK_TONE` (Task 1); `timeEl`, `statusWord`, `confirmButton`, `busy`.
- Produces:
  - `tasksView(ctx) → Node`.
  - Elements carrying `data-dirty`, and `details.menu`, both of which `hasDraft` respects.

- [ ] **Step 1: Write the failing test**

Append to `test/ui.test.ts`:
```ts
test('a changed select or an open row menu also counts as a draft', async () => {
  const src = await readFile(new URL('app.js', PUBLIC), 'utf8');
  assert.match(src, /#view \[data-dirty\], #view details\.menu\[open\]/);
  const tasks = await readFile(new URL('views/tasks.js', PUBLIC), 'utf8');
  assert.match(tasks, /export function tasksView\(ctx\)/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/ui.test.ts`
Expected: FAIL on the new test.

- [ ] **Step 3: Write `public/views/tasks.js`**

```js
import { h, api, timeEl, statusWord, confirmButton, busy } from '../dom.js';
import { TASK_LABEL, TASK_TONE, filterTasks, groupByProject, isOpenTask } from '../logic.js';

const FILTERS = [['open', 'Open'], ['done', 'Done'], ['cancelled', 'Cancelled'], ['all', 'All']];
const EMPTY = {
  open: 'No open tasks. Create one above.',
  done: 'Nothing done yet.',
  cancelled: 'No cancelled tasks.',
  all: 'No tasks yet. Create one above.',
};

/** In one project: its sessions. In All: grouped by project. */
function sessionSelect(ctx, { id, selected }) {
  const opts = (list) => list.map((s) => h('option', { value: s.name, selected: s.name === selected }, s.name));
  const sessions = [...ctx.liveSessions()].sort((a, b) => a.name.localeCompare(b.name));
  return h(
    'select',
    { id, required: true },
    ctx.state.project ? opts(sessions) : groupByProject(sessions).map((g) => h('optgroup', { label: g.project }, opts([...g.sessions].sort((a, b) => a.name.localeCompare(b.name))))),
  );
}

function newTaskForm(ctx) {
  if (!ctx.liveSessions().length) return h('p', { class: 'empty' }, 'No sessions to assign to yet.');
  const to = sessionSelect(ctx, { id: 'task-to' });
  const title = h('input', { id: 'task-title', type: 'text', name: 'task-title', autocomplete: 'off', required: true, maxlength: 500, placeholder: 'e.g. Add retries to the payment adapter…' });
  const body = h('textarea', { id: 'task-body', class: 'grow', rows: 1, maxlength: 65536, placeholder: 'Context, acceptance criteria, links…' });
  const submit = h('button', { type: 'submit', class: 'primary' }, 'Create Task');
  return h(
    'form',
    {
      class: 'panel new-task',
      onsubmit: (e) => {
        e.preventDefault();
        void busy(submit, 'Creating…', () =>
          ctx.act(() => api('POST', '/api/tasks', { to: to.value, title: title.value, ...(body.value.trim() ? { body: body.value } : {}) }), `Assigned to ${to.value}`),
        );
      },
    },
    h('h2', null, 'New Task'),
    h(
      'div',
      { class: 'new-task-grid' },
      h('div', { class: 'field' }, h('label', { for: 'task-title' }, 'Title'), title),
      h('div', { class: 'field' }, h('label', { for: 'task-to' }, 'Assign to'), to),
      submit,
      h('div', { class: 'field full' }, h('label', { for: 'task-body' }, 'Details ', h('span', { class: 'hint' }, '(optional)')), body),
    ),
  );
}

function rowMenu(ctx, t) {
  const sel = sessionSelect(ctx, { id: `reassign-${t.id}`, selected: t.assigneeName });
  sel.addEventListener('change', () => sel.toggleAttribute('data-dirty', sel.value !== t.assigneeName));
  const save = h('button', { type: 'button', class: 'primary small' }, 'Save');
  save.addEventListener('click', () => busy(save, 'Saving…', () => ctx.act(() => api('POST', `/api/tasks/${t.id}/assign`, { to: sel.value }), `T${t.id} moved to ${sel.value}`)));
  return h(
    'details',
    { class: 'menu' },
    h('summary', { 'aria-label': `Actions for T${t.id}`, title: 'Actions' }, '⋯'),
    h(
      'div',
      { class: 'menu-pop' },
      h('label', { class: 'field', for: `reassign-${t.id}` }, 'Reassign to'),
      sel,
      h('div', { class: 'row between' }, confirmButton('Cancel Task', 'Confirm Cancel', () => ctx.act(() => api('POST', `/api/tasks/${t.id}/cancel`, {}), `Cancelled T${t.id}`), 'danger'), save),
    ),
  );
}

function taskRow(ctx, t) {
  return h(
    'tr',
    { 'data-status': TASK_TONE[t.status] },
    h('td', { class: 'qid' }, `T${t.id}`),
    h(
      'td',
      { class: 'title-cell' },
      h('div', { class: 'task-title', dir: 'auto' }, t.title),
      t.blocker ? h('div', { class: 'second', dir: 'auto' }, t.blocker) : null,
      t.result ? h('div', { class: 'meta', dir: 'auto' }, t.result) : null,
    ),
    h('td', { class: 'mono', translate: 'no' }, t.assigneeName ?? h('span', { class: 'muted' }, 'unassigned')),
    ctx.state.project ? null : h('td', { class: 'hide-sm' }, h('span', { class: 'chip', translate: 'no' }, t.project)),
    h('td', null, statusWord(TASK_TONE[t.status], TASK_LABEL[t.status] ?? t.status)),
    h('td', { class: 'meta hide-sm' }, timeEl(t.updatedAt)),
    h('td', { class: 'actions' }, isOpenTask(t) && ctx.liveSessions().length ? rowMenu(ctx, t) : null),
  );
}

export function tasksView(ctx) {
  const { state } = ctx;
  const shown = filterTasks(state.tasks, state.taskFilter);
  const th = (label, cls) => h('th', { scope: 'col', class: cls ?? null }, label);
  return h(
    'section',
    { class: 'tasks', 'aria-labelledby': 'tasks-title' },
    h('div', { class: 'page-head' }, h('h1', { id: 'tasks-title' }, 'Tasks')),
    newTaskForm(ctx),
    h(
      'div',
      { class: 'chips-row', role: 'group', 'aria-label': 'Filter tasks' },
      FILTERS.map(([f, label]) =>
        h(
          'button',
          { type: 'button', class: 'stat', 'aria-pressed': String(state.taskFilter === f), onclick: () => { state.taskFilter = f; ctx.render(); } },
          label,
          h('span', { class: 'num muted' }, String(filterTasks(state.tasks, f).length)),
        ),
      ),
    ),
    shown.length
      ? h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'grid' },
            h(
              'thead',
              null,
              h('tr', null, th('ID'), th('Title'), th('Assignee'), state.project ? null : th('Project', 'hide-sm'), th('Status'), th('Updated', 'hide-sm'), th(h('span', { class: 'sr-only' }, 'Actions'))),
            ),
            h('tbody', null, shown.map((t) => taskRow(ctx, t))),
          ),
        )
      : h('p', { class: 'empty' }, EMPTY[state.taskFilter] ?? EMPTY.open),
  );
}
```

- [ ] **Step 4: Wire it into `app.js`**

1. Add the import:
   ```js
   import { tasksView } from './views/tasks.js';
   ```
2. In the `state` literal, add `taskFilter: 'open',`.
3. Delete the `const TASK_GROUPS = [ … ];` constant and the whole `// ---------- tasks ----------` section (`sessionSelect`, `taskRow`, the old `tasksView`).
4. Replace `hasDraft` with:
   ```js
   /** True while the owner has unsent input: typed text, a changed select, or an open row menu. A remount would lose it. */
   function hasDraft() {
     const typed = [...document.querySelectorAll('#view textarea, #view input:not([type=password]), #detail textarea')].some(
       (el) => el.value.trim() !== '',
     );
     return typed || document.querySelector('#view [data-dirty], #view details.menu[open]') !== null;
   }
   ```
5. Views map: `tasks: () => tasksView(ctx),`.

- [ ] **Step 5: Append the tasks CSS**

Insert above `/* ---------- narrow screens ---------- */`:
```css
/* ---------- tasks + tables ---------- */

.new-task { margin-bottom: 16px; }
.new-task-grid { display: grid; grid-template-columns: minmax(0, 1fr) 220px auto; gap: 12px; align-items: end; }
.new-task-grid .full { grid-column: 1 / -1; }
.new-task-grid input, .new-task-grid select { width: 100%; }
.grow { min-height: 34px; }
.grow:focus, .grow:not(:placeholder-shown) { min-height: 96px; }

.chips-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.chips-row .num { font-family: var(--mono); }

.table-wrap { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
table.grid { width: 100%; border-collapse: collapse; }
.grid th {
  text-align: left;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  padding: 8px 12px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.grid th:first-child { border-top-left-radius: 8px; }
.grid th:last-child { border-top-right-radius: 8px; }
.grid td { padding: 8px 12px; border-top: 1px solid var(--border); vertical-align: top; }
.grid tbody tr:first-child td { border-top: 0; }
.grid tbody tr:hover { background: var(--hover); }
.title-cell { min-width: 220px; }
.task-title { font-weight: 500; overflow-wrap: anywhere; }
.grid .second { color: var(--st); font-size: 13px; overflow-wrap: anywhere; }
.actions { width: 1%; text-align: right; white-space: nowrap; }

.menu { position: relative; display: inline-block; }
.menu > summary {
  list-style: none;
  cursor: pointer;
  display: inline-grid;
  place-items: center;
  min-width: 32px;
  min-height: 32px;
  border-radius: var(--radius);
  color: var(--text-muted);
}
.menu > summary::-webkit-details-marker { display: none; }
.menu > summary:hover, .menu[open] > summary { background: var(--hover); color: var(--text); }
.menu-pop {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 260px;
  padding: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow);
  text-align: left;
  white-space: normal;
}

@media (max-width: 1023px) {
  .new-task-grid { grid-template-columns: minmax(0, 1fr); }
}

@media (max-width: 639px) {
  .hide-sm { display: none; }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/ui.test.ts`
Expected: PASS.

Run: `npm test > .superpowers/t6.log 2>&1; tail -5 .superpowers/t6.log && npm run check`
Expected: all pass (171), `tsc` clean.

- [ ] **Step 7: Commit**

```bash
git add public/views/tasks.js public/app.js public/style.css test/ui.test.ts
git -c user.name=shaltut -c user.email=itshaltoot96@gmail.com commit -m "feat(ui): tasks table with filters and per-row action menus

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VedgXUgL6iW3TBNCGKnxmr"
```

---

### Task 7: Controls page

**Files:**
- Create: `public/views/controls.js`
- Modify: `public/app.js`:
  - delete the `ROLES` constant and the `// ---------- controls ----------` section
  - change the views map
- Modify: `public/style.css` (append the controls block)
- Test: `test/ui.test.ts` (append)

**Interfaces:**
- Consumes: `ctx.state.projects/devices/newToken`, `ctx.liveSessions`, `ctx.deviceLabel`, `timeEl`, `confirmButton`, `busy`.
- Produces: `controlsView(ctx) → Node`.

- [ ] **Step 1: Write the failing test**

Append to `test/ui.test.ts`:
```ts
test('controls never pre-fill an input that would freeze live refresh', async () => {
  const src = await readFile(new URL('views/controls.js', PUBLIC), 'utf8');
  assert.match(src, /export function controlsView\(ctx\)/);
  assert.match(src, /placeholder: 'Move to…'/);
  assert.doesNotMatch(src, /value: s\.project/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/ui.test.ts`
Expected: FAIL with ENOENT for `views/controls.js`.

- [ ] **Step 3: Write `public/views/controls.js`**

```js
import { h, api, timeEl, confirmButton, busy } from '../dom.js';

const ROLES = ['orchestrator', 'worker', 'helper', 'auditor', 'other'];

function everyone(ctx) {
  const { state } = ctx;
  const scope = h(
    'select',
    { id: 'bc-scope' },
    h('option', { value: '', selected: !state.project }, 'All projects'),
    state.projects.map((p) => h('option', { value: p.name, selected: p.name === state.project }, p.name)),
  );
  const message = h('textarea', { id: 'bc-body', rows: 3, required: true, maxlength: 65536, placeholder: 'e.g. Wrap up and commit; we deploy at 18:00…' });
  const send = h('button', { type: 'submit', class: 'primary' }, 'Send Broadcast');
  const target = () => (scope.value ? { project: scope.value } : {});
  return h(
    'form',
    {
      class: 'panel',
      'aria-labelledby': 'c-everyone',
      onsubmit: (e) => {
        e.preventDefault();
        void busy(send, 'Sending…', () =>
          ctx.act(async () => {
            const r = await api('POST', '/api/broadcast', { body: message.value, ...target() });
            ctx.toast(`Broadcast to ${r.count} ${r.count === 1 ? 'session' : 'sessions'}`);
          }),
        );
      },
    },
    h('h2', { id: 'c-everyone' }, 'Everyone'),
    h('div', { class: 'field narrow' }, h('label', { for: 'bc-scope' }, 'Scope'), scope),
    h('div', { class: 'field' }, h('label', { for: 'bc-body' }, 'Broadcast message'), message, h('p', { class: 'hint' }, 'Each session receives it when its current turn ends.')),
    h(
      'div',
      { class: 'row' },
      send,
      confirmButton('Pause All', 'Confirm Pause All', () => ctx.act(() => api('POST', '/api/control', { target: 'all', action: 'pause', ...target() }), 'Pause sent. Each session stops when its turn ends.')),
      h('button', { type: 'button', onclick: () => ctx.act(() => api('POST', '/api/control', { target: 'all', action: 'resume', ...target() }), 'Resume sent') }, 'Resume All'),
    ),
  );
}

function sessionRow(ctx, s) {
  const enc = encodeURIComponent(s.name);
  const role = h('select', { 'aria-label': `Role for ${s.name}` }, ROLES.map((r) => h('option', { value: r, selected: r === s.role }, r)));
  const move = h('input', {
    type: 'text',
    list: 'project-names',
    name: `move-${s.name}`,
    autocomplete: 'off',
    spellcheck: 'false',
    maxlength: 64,
    placeholder: 'Move to…',
    'aria-label': `Move ${s.name} to project`,
  });
  const save = h('button', { type: 'button', class: 'primary small', hidden: true }, 'Save');
  const tr = h(
    'tr',
    null,
    h('td', { class: 'mono', translate: 'no' }, s.name, s.role === 'orchestrator' ? h('span', { class: 'star', role: 'img', 'aria-label': 'orchestrator' }, ' ★') : null),
    h('td', null, h('span', { class: 'chip', translate: 'no' }, s.project)),
    h('td', null, move),
    h('td', null, role),
    h('td', { class: 'meta hide-sm', translate: 'no' }, ctx.deviceLabel(s.deviceId)),
    h(
      'td',
      { class: 'actions' },
      h('div', { class: 'row end' }, save, confirmButton('Retire', 'Confirm Retire', () => ctx.act(() => api('POST', `/api/admin/sessions/${enc}/retire`, {}), `Retired ${s.name}`), 'danger')),
    ),
  );
  const dirty = () => {
    const project = move.value.trim().toLowerCase();
    const changed = role.value !== s.role || (project !== '' && project !== s.project);
    save.hidden = !changed;
    tr.toggleAttribute('data-dirty', changed);
  };
  role.addEventListener('change', dirty);
  move.addEventListener('input', dirty);
  save.addEventListener('click', () =>
    busy(save, 'Saving…', () =>
      ctx.act(async () => {
        const project = move.value.trim();
        if (project && project.toLowerCase() !== s.project) await api('POST', `/api/admin/sessions/${enc}/project`, { project });
        if (role.value !== s.role) await api('POST', `/api/admin/sessions/${enc}/role`, { role: role.value });
      }, `Saved ${s.name}`),
    ),
  );
  return tr;
}

function sessionsPanel(ctx) {
  const sessions = [...ctx.liveSessions()].sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
  const th = (label, cls) => h('th', { scope: 'col', class: cls ?? null }, label);
  return h(
    'section',
    { class: 'panel', 'aria-labelledby': 'c-sessions' },
    h('h2', { id: 'c-sessions' }, 'Sessions'),
    h('datalist', { id: 'project-names' }, ctx.state.projects.map((p) => h('option', { value: p.name }))),
    sessions.length
      ? h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'grid' },
            h('thead', null, h('tr', null, th('Name'), th('Project'), th('Move to project'), th('Role'), th('Device', 'hide-sm'), th(h('span', { class: 'sr-only' }, 'Actions')))),
            h('tbody', null, sessions.map((s) => sessionRow(ctx, s))),
          ),
        )
      : h('p', { class: 'muted' }, 'No sessions yet.'),
  );
}

function tokenBox(ctx) {
  const { state } = ctx;
  return h(
    'div',
    { class: 'token' },
    h('p', null, h('strong', null, `Token for ${state.newToken.label}. `), 'Shown once. Store it now.'),
    h('input', { type: 'text', readonly: true, class: 'mono', value: state.newToken.token, onfocus: (e) => e.target.select(), 'aria-label': 'New device token' }),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          type: 'button',
          onclick: () =>
            navigator.clipboard?.writeText(state.newToken.token).then(
              () => ctx.toast('Copied'),
              () => ctx.toast('Copy failed. Select the token and copy it manually.', true),
            ),
        },
        'Copy Token',
      ),
      h('button', { type: 'button', class: 'quiet', onclick: () => { state.newToken = null; ctx.render(); } }, 'Done'),
    ),
  );
}

function devicesPanel(ctx) {
  const { state } = ctx;
  const label = h('input', { id: 'dev-label', type: 'text', name: 'device-label', autocomplete: 'off', spellcheck: 'false', required: true, maxlength: 64, placeholder: 'e.g. win-box…' });
  const add = h('button', { type: 'submit', class: 'primary' }, 'Add Device');
  return h(
    'form',
    {
      class: 'panel',
      'aria-labelledby': 'c-devices',
      onsubmit: (e) => {
        e.preventDefault();
        void busy(add, 'Adding…', () =>
          ctx.act(async () => {
            const r = await api('POST', '/api/admin/devices', { label: label.value });
            state.newToken = { label: r.device.label, token: r.token };
          }, 'Device token created'),
        );
      },
    },
    h('h2', { id: 'c-devices' }, 'Devices'),
    state.newToken ? tokenBox(ctx) : null,
    state.devices.length
      ? h(
          'ul',
          { class: 'dev-list' },
          state.devices.map((d) =>
            h(
              'li',
              { class: `row between${d.revokedAt ? ' revoked' : ''}` },
              h('span', { class: 'mono', translate: 'no' }, d.label),
              h('span', { class: 'meta' }, d.revokedAt ? ['Revoked ', timeEl(d.revokedAt)] : ['Added ', timeEl(d.createdAt)]),
              d.revokedAt ? null : confirmButton('Revoke', 'Confirm Revoke', () => ctx.act(() => api('POST', `/api/admin/devices/${d.id}/revoke`, {}), `Revoked ${d.label}`), 'danger'),
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'No devices yet.'),
    h('div', { class: 'row end' }, h('div', { class: 'field' }, h('label', { for: 'dev-label' }, 'Device label'), label), add),
  );
}

export function controlsView(ctx) {
  return h(
    'section',
    { class: 'controls', 'aria-labelledby': 'c-title' },
    h('div', { class: 'page-head' }, h('h1', { id: 'c-title' }, 'Controls')),
    everyone(ctx),
    sessionsPanel(ctx),
    devicesPanel(ctx),
  );
}
```

- [ ] **Step 4: Wire it into `app.js`**

1. Add the import:
   ```js
   import { controlsView } from './views/controls.js';
   ```
2. Delete the `const ROLES = [ … ];` constant and the whole `// ---------- controls ----------` section.
3. Views map: `controls: () => controlsView(ctx),`. Every entry now passes `ctx`.

- [ ] **Step 5: Append the controls CSS**

Insert above `/* ---------- narrow screens ---------- */`:
```css
/* ---------- controls ---------- */

.controls { display: flex; flex-direction: column; gap: 16px; }
.controls .field.narrow { max-width: 280px; }
.controls .grid input, .controls .grid select { width: 100%; min-width: 120px; }
.end { justify-content: flex-end; align-items: flex-end; flex-wrap: nowrap; }

.dev-list { list-style: none; margin: 0; padding: 0; }
.dev-list li { padding: 8px 0; border-top: 1px solid var(--border); }
.dev-list li:first-child { border-top: 0; }
.revoked .mono { color: var(--text-muted); text-decoration: line-through; }

.token {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--st-waiting_permission);
  border-radius: var(--radius);
  background: var(--st-waiting_permission-tint);
}
.token input { width: 100%; }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/ui.test.ts`
Expected: PASS.

Run: `npm test > .superpowers/t7.log 2>&1; tail -5 .superpowers/t7.log && npm run check`
Expected: all pass (172), `tsc` clean.

- [ ] **Step 7: Commit**

```bash
git add public/views/controls.js public/app.js public/style.css test/ui.test.ts
git -c user.name=shaltut -c user.email=itshaltoot96@gmail.com commit -m "feat(ui): controls page with save-on-change session rows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VedgXUgL6iW3TBNCGKnxmr"
```

---

### Task 8: Shell, hash router and keyboard shortcuts

**Files:**
- Rewrite: `public/app.js` (whole file, final form)
- Rewrite: `public/index.html` (whole file)
- Modify: `public/style.css` (append the shortcut sheet block)
- Test: `test/ui-css.test.ts` and `test/ui.test.ts` (append)

**Interfaces:**
- Consumes: every view module, `parseRoute`, `formatRoute`, `isTypingTarget`, `resolveKey`, `NEEDS_YOU`, `isOpenTask`.
- Produces the final `ctx`, with `navigate(over)` writing `location.hash`.

- [ ] **Step 1: Write the failing tests**

Append to `test/ui-css.test.ts`:
```ts
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

test('index declares theme colours, the skip link, the sidebar and both fonts', () => {
  assert.match(html, /<meta name="theme-color" content="#f4f4f5" media="\(prefers-color-scheme: light\)"/);
  assert.match(html, /<meta name="theme-color" content="#09090b" media="\(prefers-color-scheme: dark\)"/);
  assert.match(html, /<body class="signed-out">/);
  assert.match(html, /<a class="skip" href="#view">/);
  assert.match(html, /<aside class="side"/);
  assert.match(html, /<a href="#\/board" data-view="board">/);
  assert.match(html, /IBM\+Plex\+Mono/);
  assert.doesNotMatch(html, /Condensed/);
  assert.match(html, /<dialog id="keys"/);
});
```
Append to `test/ui.test.ts`:
```ts
test('app routes through the hash and keeps shortcuts out of text fields', async () => {
  const src = await readFile(new URL('app.js', PUBLIC), 'utf8');
  assert.match(src, /window\.addEventListener\('hashchange', applyRoute\)/);
  assert.match(src, /isTypingTarget\(e\.target\)/);
  assert.match(src, /e\.ctrlKey \|\| e\.metaKey \|\| e\.altKey/);
  assert.doesNotMatch(src, /\.tabs button/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/ui.test.ts test/ui-css.test.ts`
Expected: FAIL on the two new tests.

- [ ] **Step 3: Replace `public/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#f4f4f5" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#09090b" media="(prefers-color-scheme: dark)" />
    <title>Command Center</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%2318181b'/%3E%3Crect x='3' y='3' width='2' height='10' rx='1' fill='%23f87171'/%3E%3Crect x='7' y='4' width='6' height='2' rx='1' fill='%23fafafa'/%3E%3Crect x='7' y='10' width='6' height='2' rx='1' fill='%23a1a1aa'/%3E%3C/svg%3E" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      rel="stylesheet"
      href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap"
    />
    <link rel="stylesheet" href="/style.css" />
    <script type="module" src="/app.js"></script>
  </head>
  <body class="signed-out">
    <a class="skip" href="#view">Skip to content</a>
    <div class="shell">
      <aside class="side" aria-label="Navigation">
        <div class="brand" translate="no">CCC</div>
        <nav class="nav" aria-label="Sections">
          <a href="#/board" data-view="board">Board</a>
          <a href="#/questions" data-view="questions">Questions <span class="count" id="q-count"></span></a>
          <a href="#/tasks" data-view="tasks">Tasks <span class="count" id="t-count"></span></a>
          <a href="#/controls" data-view="controls">Controls</a>
        </nav>
        <section class="projects" aria-labelledby="projects-title">
          <h2 class="side-h" id="projects-title">Projects</h2>
          <ul class="project-list" id="project-list"></ul>
          <label class="project-select">Project <select id="project"></select></label>
        </section>
        <div class="side-foot">
          <span class="live" id="live" role="status">Offline</span>
          <button type="button" class="quiet small" id="keys-open" aria-keyshortcuts="Shift+/">Shortcuts <kbd>?</kbd></button>
        </div>
      </aside>
      <main id="view" tabindex="-1"></main>
    </div>
    <dialog id="detail" class="drawer" aria-labelledby="detail-title"></dialog>
    <dialog id="keys" class="sheet" aria-labelledby="keys-title"></dialog>
    <div class="toast" id="toast" role="status" aria-live="polite"></div>
  </body>
</html>
```

- [ ] **Step 4: Replace `public/app.js`**

```js
import { h, mount, api, debounce, Unauthorized } from './dom.js';
import { NEEDS_YOU, isOpenTask, parseRoute, formatRoute, isTypingTarget, resolveKey } from './logic.js';
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
};
/** Adds ?project= when one project is selected; '' means all projects. */
const scoped = (path) => (state.project ? `${path}${path.includes('?') ? '&' : '?'}project=${encodeURIComponent(state.project)}` : path);
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

async function act(fn, done) {
  try {
    await fn();
    if (done) toast(done);
    await refresh();
  } catch (err) {
    if (err instanceof Unauthorized) return showLogin();
    toast(errorText(err), true);
  }
}

const deviceLabel = (id) => state.devices.find((d) => d.id === id)?.label ?? '—';
const liveSessions = () => state.sessions.filter((s) => !s.retiredAt && (!state.project || s.project === state.project));
const openQuestions = () => state.questions.filter((q) => q.status === 'open');

async function load() {
  const projects = await api('GET', '/api/projects');
  state.projects = projects.projects;
  // A remembered or linked project with nothing left in it: show everything rather than an empty board.
  if (state.project && !state.projects.some((p) => p.name === state.project)) {
    state.project = '';
    saveProject('');
    history.replaceState(null, '', formatRoute(currentRoute()));
  }
  const [sessions, questions, tasks, devices] = await Promise.all([
    api('GET', '/api/sessions'),
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
    toast(errorText(err), true);
    return;
  }
  if (live && hasDraft()) return;
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

function render() {
  renderNav();
  const views = { board: boardView, questions: questionsView, tasks: tasksView, controls: controlsView };
  mount(view, views[state.tab](ctx));
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

function showLogin() {
  stream?.close();
  if (dialog.open) dialog.close();
  document.body.classList.add('signed-out');
  const input = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true, id: 'pw' });
  const error = h('p', { class: 'error-text', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'primary' }, 'Sign In');
  mount(
    view,
    h(
      'form',
      {
        class: 'login',
        onsubmit: async (e) => {
          e.preventDefault();
          error.textContent = '';
          submit.disabled = true;
          submit.textContent = 'Signing in…';
          try {
            await api('POST', '/api/admin/login', { password: input.value });
            await start();
          } catch (err) {
            error.textContent = err instanceof Unauthorized ? 'Wrong password.' : errorText(err);
            submit.disabled = false;
            submit.textContent = 'Sign In';
            input.focus();
          }
        },
      },
      h('div', { class: 'brand', translate: 'no' }, 'CCC'),
      h('h1', null, 'Command Center'),
      h('label', { class: 'field', for: 'pw' }, 'Owner password'),
      input,
      submit,
      error,
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
```

- [ ] **Step 5: Append the shortcut sheet CSS**

Insert above `/* ---------- narrow screens ---------- */`:
```css
/* ---------- shortcut sheet ---------- */

.sheet { width: min(440px, calc(100vw - 32px)); }
.sheet-body { padding: 20px; }
.sheet .page-head { margin-bottom: 8px; }
.keys { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 16px; margin: 0; }
.keys dt { white-space: nowrap; }
.keys dd { margin: 0; color: var(--text-muted); }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/ui.test.ts test/ui-css.test.ts`
Expected: PASS, including the `hasDraft`/`liveRefresh`/`render` regex test against the new `app.js`.

Run: `npm test > .superpowers/t8.log 2>&1; tail -5 .superpowers/t8.log && npm run check && wc -l public/*.js public/views/*.js`
Expected: all pass (174), `tsc` clean, and every file under 800 lines (`app.js` about 360).

- [ ] **Step 7: Commit**

```bash
git add public/app.js public/index.html public/style.css test/ui.test.ts test/ui-css.test.ts
git -c user.name=shaltut -c user.email=itshaltoot96@gmail.com commit -m "feat(ui): sidebar shell, hash router and keyboard shortcuts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VedgXUgL6iW3TBNCGKnxmr"
```

---

### Task 9: Docs and visual verification

**Files:**
- Modify: `docs/use-cases.md:9` and `docs/agent-prompts.md:11` (`Controls → Roles` becomes `Controls → Sessions`)
- Modify: `docs/knowledge-base.md:142` (mention `/views/*.js`)
- Modify: `README.md:8` (mention the shortcuts)
- Scratch (not committed):
  - `/tmp/claude-1002/-home-ahmed/3ffc892b-1d02-46ff-b71c-e140ec991ce1/scratchpad/shots/seed.sh`
  - `/tmp/claude-1002/-home-ahmed/3ffc892b-1d02-46ff-b71c-e140ec991ce1/scratchpad/shots/shoot.mjs`

- [ ] **Step 1: Update the docs**

- `docs/use-cases.md`: `open **Controls → Roles** and make` becomes `open **Controls → Sessions**, set `.
- `docs/agent-prompts.md`: `**Controls → Roles**, give that name` becomes `**Controls → Sessions**, give that name`.
- `docs/knowledge-base.md` line 142: `` - `/` serves the UI.`` becomes `` - `/` serves the UI; `/views/*.js` serves its page modules (one level, lower-case names). ``
- `README.md` line 8: change it to:
  ```
  - **Owner UI.** A web page to see everything, answer questions and send instructions. Press `?` for keyboard shortcuts.
  ```

Run: `grep -rn "Controls → Roles" docs README.md`
Expected: no output.

- [ ] **Step 2: Seed a separate screenshot database**

The test suite drops and recreates `ccc_test`, so screenshots use their own `ccc_shots` database. Write `/tmp/claude-1002/-home-ahmed/3ffc892b-1d02-46ff-b71c-e140ec991ce1/scratchpad/shots/seed.sh`:
```bash
#!/bin/bash
# Seeds a local CCC (http://localhost:18080, DB ccc_shots) with two projects of sessions, tasks and questions.
set -euo pipefail
U=http://localhost:18080
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
J="$W/jar"
curl -sf -c "$J" -H 'content-type: application/json' -d '{"password":"smoke-test-password"}' $U/api/admin/login >/dev/null
TOKEN=$(curl -sf -b "$J" -H 'content-type: application/json' -d '{"label":"win-box"}' $U/api/admin/devices | jq -r .token)
curl -sf -b "$J" -H 'content-type: application/json' -d '{"label":"mac-box"}' $U/api/admin/devices >/dev/null
agent() { # name project method path [json]
  curl -sf -H "authorization: Bearer $TOKEN" -H "x-ccc-session: $1" -H "x-ccc-project: $2" -H 'content-type: application/json' \
    -X "$3" "$U$4" ${5:+-d "$5"} >/dev/null
}
for s in orch W1 W2 W3 uiux; do agent $s ihop POST /api/sessions/register '{}'; done
for s in k-orch K1; do agent $s kiosk POST /api/sessions/register '{}'; done
curl -sf -b "$J" -H 'content-type: application/json' -d '{"role":"orchestrator"}' $U/api/admin/sessions/orch/role >/dev/null
curl -sf -b "$J" -H 'content-type: application/json' -d '{"role":"orchestrator"}' $U/api/admin/sessions/k-orch/role >/dev/null
agent W1 ihop POST /api/status '{"status":"working","workingOn":"Checkout → payment adapter retries"}'
agent W2 ihop POST /api/status '{"status":"blocked","workingOn":"Migrating order history","blocker":"Need staging DB credentials to run the backfill"}'
agent uiux ihop POST /api/status '{"status":"working","workingOn":"Menu pass on the kiosk landing page with a deliberately long summary to prove truncation works"}'
agent K1 kiosk POST /api/status '{"status":"idle"}'
owner_task() { curl -sf -b "$J" -H 'content-type: application/json' -d "$1" $U/api/tasks >/dev/null; }
owner_task '{"to":"W1","title":"Add retries to the payment adapter"}'
owner_task '{"to":"W2","title":"Backfill order history"}'
owner_task '{"to":"K1","title":"Kiosk idle screen"}'
agent W2 ihop POST /api/questions '{"to":"owner","body":"Which staging DB should the backfill target?","isBlocking":true,"options":[{"key":"a","label":"staging-eu"},{"key":"b","label":"staging-us"}]}'
agent uiux ihop POST /api/questions '{"to":"owner","body":"Keep the dark header on the kiosk, or switch to light?"}'
sudo docker exec ccc-test-pg psql -qU postgres -d ccc_shots -c "update ccc.sessions set status='unreachable', last_heartbeat_at = now() - interval '20 minutes' where name='W3'"
echo seeded
```

Run:
```bash
sudo docker exec ccc-test-pg createdb -U postgres ccc_shots 2>/dev/null || true
```
Then restart the local server against it. Stop the background task `bykg7hpb3` with TaskStop, and start (background) from `/opt/ccc-src`:
```bash
DATABASE_URL=postgres://postgres:ccc@127.0.0.1:5544/ccc_shots CCC_ADMIN_PASSWORD=smoke-test-password CCC_PUBLIC_URL=http://localhost:18080 PORT=18080 exec node src/main.ts
```
Once `curl -sf localhost:18080/` answers, run `bash /tmp/claude-1002/-home-ahmed/3ffc892b-1d02-46ff-b71c-e140ec991ce1/scratchpad/shots/seed.sh`.
Expected: `seeded`.

- [ ] **Step 3: Point the screenshot script at the new markup**

In `/tmp/claude-1002/-home-ahmed/3ffc892b-1d02-46ff-b71c-e140ec991ce1/scratchpad/shots/shoot.mjs`:
- Replace the tab loop's click with navigation by hash. Use `await page.evaluate((t) => { location.hash = '#/' + t; }, tab);` in place of `await page.click(`.tabs button[data-tab=${tab}]`);`.
- Replace the board click with `await page.evaluate(() => { location.hash = '#/board'; });`.
- Replace the detail click with `await page.click('.srow >> nth=1');`.

- [ ] **Step 4: Capture and review the after set**

Run: `cd /tmp/claude-1002/-home-ahmed/3ffc892b-1d02-46ff-b71c-e140ec991ce1/scratchpad/shots && node shoot.mjs after && ls after-*.png | wc -l`
Expected: `done`, then `24`.

Read each `after-*.png` (board, questions, tasks, controls, detail and login, × light/dark, × desk/phone) and check them against spec §7:
- blocked and unreachable rows stand out and idle rows recede;
- there is no project picker on login;
- the Controls rows are compact;
- the answer field is labelled;
- the task actions are hidden behind ⋯;
- the All view is grouped by project.

Any defect found: fix it in the owning task's file, rerun `npm test`, recapture, then commit the fix as `fix(ui): …`.

- [ ] **Step 5: Commit the docs**

```bash
git add docs/use-cases.md docs/agent-prompts.md docs/knowledge-base.md README.md
git -c user.name=shaltut -c user.email=itshaltoot96@gmail.com commit -m "docs: point UI references at the redesigned pages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VedgXUgL6iW3TBNCGKnxmr"
```

- [ ] **Step 6: Hand the screenshots to the owner**

Send the desk light and desk dark board, questions and controls shots to Ahmed for review (spec §8) **before** any deploy. The deploy itself (tag `ccc:pre-redesign`, push, `docker compose up -d --build`, smoke test) runs under superpowers:finishing-a-development-branch after his approval.
