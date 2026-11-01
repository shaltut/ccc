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
