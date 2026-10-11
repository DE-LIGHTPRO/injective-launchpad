/**
 * Touch targets meet WCAG 2.5.8 AA (24 x 24 CSS px) on a coarse pointer.
 *
 * Measured at 375px on a correctly rendered page: the segmented buttons are 37px
 * tall and were always fine, but two standalone links were 14 and 15px high —
 * the breadcrumb and the explorer links in a metric row. Neither is a word inside
 * a sentence, so the inline exception does not cover them.
 *
 * TWO HALVES, AND THE SECOND IS THE ONE THAT GETS MISSED. A selector-based rule
 * reaches a control only if the control matches the selector, so asserting the CSS
 * exists proves nothing on its own. This checks the rule AND that the markup
 * actually produces those selectors. In a sibling project every control measured
 * under the floor turned out to have an empty className, which is exactly the case
 * a CSS-only assertion passes over.
 *
 * It also asserts the rule does NOT grow the text, because the fix must not
 * reflow every phone layout to enlarge a hit area nobody can see.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = join(import.meta.dirname, '..');
const css = readFileSync(join(APP, 'app', 'globals.css'), 'utf8');

/** The body of the `@media (pointer: coarse)` block, brace-matched. */
function coarseBlock(): string {
  const at = css.search(/@media\s*\(\s*pointer\s*:\s*coarse\s*\)\s*\{/);
  assert.ok(at >= 0, 'there is no @media (pointer: coarse) block at all');
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error('the coarse-pointer block is not closed');
}


/** The coarse block's rules, split into selector and body. */
function coarseRules(): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const block = coarseBlock();
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of block.matchAll(re)) {
    out.push({ selector: m[1].trim(), body: m[2] });
  }
  assert.ok(out.length >= 2, `expected at least two rules, parsed ${out.length}`);
  return out;
}

test('the hit area is sized only under a coarse pointer', () => {
  /*
   * Scoped to coarse on purpose. A 14px text link is comfortable with a mouse, and
   * this rule is about thumbs; applying it everywhere would change desktop density
   * to fix something desktop does not have.
   */
  const block = coarseBlock();
  assert.match(block, /height:\s*24px/, 'the coarse block does not set a 24px height');
  assert.match(block, /::after/, 'the area must come from a pseudo-element');
  assert.match(block, /position:\s*absolute/, 'the pseudo-element must not take layout space');
  assert.match(block, /position:\s*relative/, 'the anchor needs to be the positioning context');
});

test('it enlarges the hit area without growing the text', () => {
  // Padding or font-size would reflow the layout on every phone to fix a hit area
  // that is invisible. The pseudo-element changes neither.
  const block = coarseBlock();
  assert.ok(!/font-size/.test(block), 'the coarse block changes font-size, which reflows');
  assert.ok(!/(^|[^-])padding:/.test(block), 'the coarse block adds padding, which reflows');
});

test('the markup actually produces the selectors the rule targets', () => {
  /*
   * The half that gets missed. Each selector is checked against the source that
   * renders it, so a rule aimed at a class nothing uses fails here rather than
   * silently protecting nothing.
   */
  const detail = readFileSync(join(APP, 'app', 'launch', '[slug]', 'page.tsx'), 'utf8');

  // `.note > a` — the breadcrumb.
  assert.match(detail, /className="note"[\s\S]{0,120}<Link/, 'no link inside a .note wrapper');
  // `.metric-row a` / `.v > a` — the explorer links.
  assert.match(detail, /className="metric-row"/, 'no metric-row in the detail page');
  assert.match(detail, /<a\s[\s\S]{0,200}NETWORK\.explorer/, 'no explorer anchor to size');

  /*
   * Checked against BOTH rules, not just the block.
   *
   * Mutation found this: pointing the base rule at a class nothing uses passed,
   * because the selector was still present further down in the `::after` list and
   * a substring search over the whole block found it there. The contract is that
   * each selector appears in the rule establishing the positioning context AND in
   * the rule that sets the height; either alone does nothing.
   */
  const rules = coarseRules();
  const positioning = rules.filter((r) => /position:\s*relative/.test(r.body));
  const sizing = rules.filter((r) => /height:\s*24px/.test(r.body));
  assert.ok(positioning.length > 0, 'no rule establishes a positioning context');
  assert.ok(sizing.length > 0, 'no rule sets the 24px height');

  for (const sel of ['.note > a', '.metric-row a']) {
    assert.ok(
      positioning.some((r) => r.selector.includes(sel)),
      `${sel} has no positioning context, so its ::after would resolve elsewhere`,
    );
    assert.ok(
      sizing.some((r) => r.selector.includes(sel)),
      `${sel} is never given the 24px height`,
    );
  }
});

test('the floor is the standard one, not a number someone liked', () => {
  // 24px is WCAG 2.5.8 AA. Recording it here means a future change to 20 or 28 has
  // to argue with the standard rather than with a preference.
  assert.match(coarseBlock(), /height:\s*24px/);
});

test('every standalone link class is in the coarse-pointer block', () => {
  /*
   * WHY THIS IS A LIST AND NOT A MEASUREMENT. The hit area comes from an `::after`,
   * so `getBoundingClientRect()` on the anchor reports the text box and calls a
   * correct 44px target a broken 21px one. I made that exact mistake measuring the
   * live site, after the stylesheet had written the warning down.
   *
   * What CAN be checked from source is that a class used as a standalone link is
   * covered by the coarse-pointer rule at all. `.ticker-sym` was not, and rendered a
   * 19px target on a phone with no pseudo-element behind it, while the tests here
   * stayed green because they checked the classes they already knew about.
   */
  const css = readFileSync(join(import.meta.dirname, '..', 'app', 'globals.css'), 'utf8');
  const coarse = css.slice(css.indexOf('@media (pointer: coarse)'));
  for (const cls of ['.ticker-sym', '.pairs-row', '.note > a', '.metric-row a']) {
    assert.ok(
      coarse.includes(cls),
      `${cls} is a standalone link and is not sized for a coarse pointer`,
    );
  }
});
