/**
 * A surface that scrolling content passes under is opaque, and glass that comes back
 * brings its accessibility override with it.
 *
 * MEASURED ON THE RUNNING APP, /risks scrolled to 900px: two lines of body copy read
 * through the sticky header as a grey ghost. `header.top` resolved to
 * `rgba(10, 11, 13, 0.92)` with `backdrop-filter: none` - an alpha sized for a blur
 * that the flat pass had already resolved away, so 8% of every line that passed
 * beneath it came through undiffused.
 *
 * Nothing could see it. The rule was declared twice, 1,647 lines apart, so neither
 * block was wrong on its own and only source order decided. And the two blocks that
 * existed to catch exactly this - `@supports not (backdrop-filter)` and
 * `@media (prefers-reduced-transparency: reduce)` - both named `header.top` and both
 * sat ABOVE the winning declaration at equal specificity, so both were dead on the one
 * selector that needed them. Forcing the query on and reading the resolved style is
 * what showed that; reading either block says the opposite.
 *
 * So these assertions resolve the cascade rather than reading a rule: they collect
 * every top-level declaration of a selector, take the last one, and resolve a `var()`
 * through `:root`. A guard that reads one block is the thing that already failed here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(import.meta.dirname, '..', 'app', 'globals.css'), 'utf8');

/*
 * Comments stripped before anything is parsed. The prose above each fix in that
 * stylesheet quotes the defective values verbatim - `rgba(10, 11, 13, 0.92)` is
 * written out in the header section - so an unmasked scan reports the explanation as
 * the defect.
 */
const src = CSS.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

/** Every top-level rule, brace-matched, with anything nested skipped whole. */
function topLevelRules(): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1) break;
    const selector = src.slice(i, open).trim();
    let depth = 0;
    let close = open;
    for (; close < src.length; close += 1) {
      if (src[close] === '{') depth += 1;
      else if (src[close] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    // An at-rule's braces wrap rules rather than declarations. Its contents are a
    // different cascade question and are deliberately not flattened in here.
    if (!selector.startsWith('@')) {
      for (const one of selector.split(',')) out.push({ selector: one.trim(), body: src.slice(open + 1, close) });
    }
    i = close + 1;
  }
  // A broken parser would pass every assertion below by finding nothing to check.
  assert.ok(out.length > 200, `only ${out.length} rules parsed: the scan is not measuring`);
  return out;
}

const RULES = topLevelRules();

/** The `:root` custom properties, so a `var()` can be resolved rather than trusted. */
function tokens(): Map<string, string> {
  const map = new Map<string, string>();
  for (const { selector, body } of RULES) {
    if (selector !== ':root') continue;
    for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map.set(m[1], m[2].trim());
  }
  assert.ok(map.size > 20, `only ${map.size} tokens read: the scan is not measuring`);
  return map;
}

const TOKENS = tokens();

/** A value with every `var(--x)` replaced by what `:root` says it is. */
function resolve(value: string, depth = 0): string {
  if (depth > 5) return value;
  const next = value.replace(/var\((--[\w-]+)(?:\s*,[^)]*)?\)/g, (whole, name) => TOKENS.get(name) ?? whole);
  return next === value ? next : resolve(next, depth + 1);
}

/** The last value this selector declares for `prop`, which is the one that renders. */
function declared(selector: string, prop: string): string | null {
  let found: string | null = null;
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'g');
  for (const { selector: s, body } of RULES) {
    if (s !== selector) continue;
    for (const m of body.matchAll(re)) found = m[1].trim();
  }
  return found;
}

/** True when any colour in the value carries an alpha below 1. */
function translucent(value: string): boolean {
  for (const m of value.matchAll(/\b(?:rgba|hsla)\(([^)]*)\)/g)) {
    const alpha = m[1].split(/[,/]/).pop()?.trim() ?? '1';
    if (Number(alpha) < 1) return true;
  }
  return /\btransparent\b/.test(value);
}

/** Every selector that is sticky or fixed, wherever it declares it. */
function pinnedSelectors(): string[] {
  const out = new Set<string>();
  for (const { selector, body } of RULES) {
    if (/(?:^|;)\s*position\s*:\s*(sticky|fixed)/.test(body)) out.add(selector);
  }
  return [...out];
}

test('a sticky or fixed surface is opaque, because content passes under it', () => {
  const pinned = pinnedSelectors();
  assert.ok(pinned.length > 0, 'nothing is sticky or fixed at all: the scan is not measuring');

  for (const selector of pinned) {
    const bg = declared(selector, 'background') ?? declared(selector, 'background-color');
    // No background is not a defect: `.trade-col` is sticky and shows the page through
    // itself on purpose, because there is nothing between it and the ground.
    if (!bg || bg === 'none') continue;
    const value = resolve(bg);
    assert.ok(
      !translucent(value),
      `${selector} is pinned over scrolling content with a translucent background (${bg} -> ${value})`,
    );
  }
});

test('a pinned surface is declared once, so no source order decides what it looks like', () => {
  /*
   * The alpha and the blur it was sized for were 1,647 lines apart. Each block read
   * correctly on its own, which is why this is asserted as a count rather than as a
   * value: a second declaration is the defect, whatever it happens to say today.
   */
  for (const selector of pinnedSelectors()) {
    const count = RULES.filter((r) => r.selector === selector).length;
    assert.equal(count, 1, `${selector} is pinned and declared ${count} times at the top level`);
  }
});

/** Every rule whose `backdrop-filter` resolves to something other than `none`. */
function blurred(): string[] {
  const out: string[] = [];
  for (const { selector, body } of RULES) {
    for (const m of body.matchAll(/(?:^|;)\s*-?(?:webkit-)?backdrop-filter\s*:\s*([^;]+)/g)) {
      const value = resolve(m[1].trim());
      if (value !== 'none') out.push(`${selector}: ${m[1].trim()} -> ${value}`);
    }
  }
  return out;
}

test('a blur brings a reduced-transparency override back with it', () => {
  /*
   * A tripwire, not a measurement. Nothing blurs today - `--glass-blur` is `none` and
   * `--glass-blur-heavy` has no readers left at all - so the two blocks that used to
   * compensate for a blur were deleted rather than left reading as considered.
   *
   * Keyed on BLUR rather than on any alpha, because a chip at 8% over an opaque card
   * is a tint and not something to see through, and a guard that fails on correct
   * markup is one somebody deletes.
   *
   * Stated as a condition on purpose. The version this replaces required the block to
   * exist unconditionally, so it stayed green for months after the blur it compensated
   * for was switched off, while the block itself had gone wrong in two directions
   * nobody could see from the test.
   */
  const found = blurred();
  if (found.length === 0) return;
  assert.match(
    src,
    /@media\s*\(\s*prefers-reduced-transparency\s*:\s*reduce\s*\)/,
    `these blur: ${found.join('; ')} - reduced transparency is an accessibility setting and nothing honours it`,
  );
});

test('a blur never becomes the containing block for a fixed child', () => {
  /*
   * `backdrop-filter` makes an element a containing block for `position: fixed`, so a
   * fixed descendant positions against that element rather than against the viewport.
   * On a sibling project this clipped a dialog's full-screen backdrop to the panel
   * that opened it: in the DOM, announced to a screen reader, and a thousand pixels
   * below the fold.
   *
   * Nothing blurs here, so there is nothing to be contained by - which is why this is
   * a condition rather than an exemption list. The version it replaces exempted
   * `body::before` and `body::after` by name, and when those were deleted it became
   * two empty arrays compared to each other.
   */
  const found = blurred();
  if (found.length === 0) return;
  const fixed = RULES.filter((r) => /(?:^|;)\s*position\s*:\s*fixed/.test(r.body)).map((r) => r.selector);
  assert.deepEqual(
    fixed,
    [],
    `${found.length} rule(s) blur, so check these fixed elements are not inside one: ${fixed.join(', ')}`,
  );
});
