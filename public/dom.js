import { relTime } from './logic.js';
// DOM + fetch helpers. All text goes in as text nodes: agent-written content is never parsed as HTML.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (typeof value === 'boolean') el.toggleAttribute(key, value);
    else if (key === 'value') el.value = value;
    else el.setAttribute(key, String(value));
  }
  el.append(...nodes(children));
  return el;
}

function nodes(children) {
  return children
    .flat(Infinity)
    .filter((c) => c !== null && c !== undefined && c !== false)
    .map((c) => (c instanceof Node ? c : document.createTextNode(String(c))));
}

export function mount(target, ...children) {
  target.replaceChildren(...nodes(children));
}

export class Unauthorized extends Error {}

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) throw new Unauthorized('Signed out');
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
  return data;
}

/** Kept for existing callers: compact `Intl` relative time ("5m ago"). */
export const ago = relTime;

export const minutesSince = (value) => (Date.now() - new Date(value).getTime()) / 60000;

/** A button that asks for a second click before doing something hard to undo (no browser dialogs). */
export function confirmButton(label, confirmLabel, onConfirm, cls = 'quiet') {
  let armed = false;
  let timer;
  const button = h('button', {
    type: 'button',
    class: cls,
    onclick: async () => {
      if (!armed) {
        armed = true;
        button.textContent = confirmLabel;
        button.classList.add('armed');
        timer = setTimeout(() => {
          armed = false;
          button.textContent = label;
          button.classList.remove('armed');
        }, 4000);
        return;
      }
      clearTimeout(timer);
      button.disabled = true;
      try {
        await onConfirm();
      } finally {
        button.disabled = false;
      }
    },
  }, label);
  return button;
}

export function debounce(fn, ms) {
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}
