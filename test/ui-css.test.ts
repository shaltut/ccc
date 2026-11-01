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
test('board rows truncate long text instead of widening the layout', () => {
  assert.match(css, /\.srow\s*\{[^}]*grid-template-columns:[^;]*minmax\(0, 1fr\)/);
  assert.match(css, /\.srow \.summary\s*\{[^}]*min-width:\s*0[^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.srow \.name\s*\{[^}]*text-overflow:\s*ellipsis/);
});
test('the session detail is a right-hand drawer', () => {
  assert.match(css, /\.drawer\s*\{[^}]*margin:\s*0 0 0 auto[^}]*height:\s*100dvh/);
  assert.match(css, /\.drawer\[open\]\s*\{[^}]*animation:\s*slide-in/);
});
