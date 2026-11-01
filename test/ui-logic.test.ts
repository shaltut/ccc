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
    ['#/session/W2?status=blocked', { ...board, session: 'W2', status: 'blocked' }],
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

test('a session route keeps the board status filter behind the drawer', () => {
  const r = { view: 'board', project: 'ihop', status: 'blocked', session: 'W2' };
  assert.equal(L.formatRoute(r), '#/session/W2?project=ihop&status=blocked');
  assert.deepEqual(L.parseRoute('#/session/W2?project=ihop&status=blocked'), r);
  assert.equal(L.parseRoute('#/session/W2?status=nonsense').status, '');
});

test('latestOnly drops a slower, older call so it cannot overwrite a newer one', async () => {
  const resolvers: Array<(v: string) => void> = [];
  const fetchIt = L.latestOnly(() => new Promise<string>((r) => resolvers.push(r)));
  const older = fetchIt();
  const newer = fetchIt();
  resolvers[1]!('new');
  resolvers[0]!('old');
  assert.deepEqual(await newer, { value: 'new' });
  assert.equal(await older, null);
});
