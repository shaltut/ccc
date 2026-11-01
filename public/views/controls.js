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
