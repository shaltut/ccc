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

/**
 * Holds the answer for UNDO_MS, then sends it. Undo cancels it before anything reaches the server.
 * Other answers being typed survive every step: render() keeps answer drafts, and the send's own refresh is
 * `live`, so it waits for open drafts. A failed send drops back to the form with the typed text still in it.
 */
function queueAnswer(ctx, q, payload, label) {
  const timer = setTimeout(async () => {
    await ctx.act(() => api('POST', `/api/questions/${q.id}/answer`, payload), `Answered Q${q.id}`, { live: true });
    ctx.state.pending.delete(q.id);
    if (ctx.state.tab === 'questions') ctx.render();
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
    value: ctx.state.drafts.get(id) ?? null,
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
