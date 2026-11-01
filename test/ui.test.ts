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

test('app.js and style.css served', async () => {
  assert.equal((await t.app.request('/app.js')).status, 200);
  assert.equal((await t.app.request('/style.css')).status, 200);
  assert.equal((await t.app.request('/nope.js')).status, 404);
});

test('stream requires owner', async () => {
  assert.equal((await t.app.request('/api/stream')).status, 401);
});

test('stream opens for owner as event-stream', async () => {
  const controller = new AbortController();
  const res = await t.owner('/api/stream', { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  controller.abort();
  await res.body?.cancel().catch(() => {});
});

test('events endpoint is owner only and filters by session', async () => {
  const token = await t.newDevice('ui');
  await t.agent(token, 'EV1')('/api/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"activity":true}' });
  await t.agent(token, 'EV1')('/api/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"workingOn":"x"}' });
  assert.equal((await t.agent(token, 'EV1')('/api/events')).status, 403);
  const res = await t.owner('/api/events?session=EV1&limit=10');
  const events = (await res.json()).events as { sessionName: string }[];
  assert.ok(events.length >= 1);
  assert.ok(events.every((e) => e.sessionName === 'EV1'));
});

test('project picker: remembered safely, falls back to All when its project is gone', async () => {
  const src = await readFile(new URL('app.js', PUBLIC), 'utf8');
  assert.match(src, /api\('GET', '\/api\/projects'\)/);
  assert.match(src, /try \{\s*return localStorage\.getItem\(PROJECT_KEY\)/);
  assert.match(src, /state\.project && !state\.projects\.some\(\(p\) => p\.name === state\.project\)/);
  // The move-to-project call lives in app.js or a view module, wherever Controls is rendered.
  const all = (await Promise.all((await jsFiles()).map((f) => readFile(f, 'utf8')))).join('\n');
  assert.match(all, /\/project`, \{ project \}/);
  const html = await readFile(new URL('index.html', PUBLIC), 'utf8');
  assert.match(html, /<select id="project"/);
});
test('the detail view is its own module', async () => {
  const src = await readFile(new URL('views/detail.js', PUBLIC), 'utf8');
  assert.match(src, /export async function renderDetail\(ctx, dialog, name\)/);
  assert.match(src, /export function describeEvent\(/);
});
test('queued answers have an undo window and guard against closing the page', async () => {
  const app = await readFile(new URL('app.js', PUBLIC), 'utf8');
  assert.match(app, /addEventListener\('beforeunload'[^\n]*state\.pending\.size/);
  const q = await readFile(new URL('views/questions.js', PUBLIC), 'utf8');
  assert.match(q, /const UNDO_MS = 5000;/);
  assert.match(q, /clearTimeout\(p\.timer\)/);
  assert.match(q, /export function questionsView\(ctx\)/);
});
test('a changed select or an open row menu also counts as a draft', async () => {
  const src = await readFile(new URL('app.js', PUBLIC), 'utf8');
  assert.match(src, /#view \[data-dirty\], #view details\.menu\[open\]/);
  const tasks = await readFile(new URL('views/tasks.js', PUBLIC), 'utf8');
  assert.match(tasks, /export function tasksView\(ctx\)/);
});
