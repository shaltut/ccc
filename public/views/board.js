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
