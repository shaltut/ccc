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
    // Allowed: the click-only state of a control, or main, a tabindex=-1 focus target that is not a control.
    assert.match(m[1]!, /:focus:not\(:focus-visible\)|^\s*main\[tabindex='-1'\]:focus\s*$/, `outline removed outside an allowed selector: ${m[1]!.trim()}`);
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
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

test('index declares theme colours, the skip link, the sidebar and both fonts', () => {
  assert.match(html, /<meta name="theme-color" content="#f4f4f5" media="\(prefers-color-scheme: light\)"/);
  assert.match(html, /<meta name="theme-color" content="#09090b" media="\(prefers-color-scheme: dark\)"/);
  assert.match(html, /<body class="signed-out">/);
  assert.match(html, /<a class="skip" href="#view">/);
  assert.match(html, /<aside class="side"/);
  assert.match(html, /<a href="#\/board" data-view="board">/);
  assert.match(html, /IBM\+Plex\+Mono/);
  assert.doesNotMatch(html, /Condensed/);
  assert.match(html, /<dialog id="keys"/);
});

test('the router focus target draws no ring around the whole page', () => {
  assert.match(css, /main\[tabindex='-1'\]:focus\s*\{\s*outline:\s*none;\s*\}/);
});
