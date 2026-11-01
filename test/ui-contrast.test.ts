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
