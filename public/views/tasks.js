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
