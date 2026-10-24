/**
 * A PAGE WHOSE WHOLE BODY IS STILL LOADING HAS TO SAY SO.
 *
 * Audit F-13. `/watchlist` rendered a heading, a subtitle, and nothing, for as long as
 * it took the page's JavaScript to run. `WatchlistBoard` gated on `ids === null` and
 * returned null, under a comment reading "render nothing rather than flashing 'empty'
 * before storage answers" - right about the hazard, wrong about the remedy. Flashing
 * "Nothing on your watchlist" would be a false statement; rendering nothing at all is
 * the same false statement with the words taken out, and a reader cannot tell a list
 * that is still coming from a list that is not there.
 *
 * IT IS NOT A BRIEF GAP, AND THE SERVER RENDER IS WHY IT CANNOT BE. The watchlist lives
 * in this browser, so no amount of server work can ever put it in the HTML. Measured by
 * parsing the response of `GET /watchlist` on the dev build: 66,467 bytes carrying
 * "Watchlist" and "Launches you have starred, in this browser.", with no `.empty-hero`
 * and no `table.board` anywhere in it. That is the whole of what a reader has until
 * hydration lands.
 *
 * WHAT THIS FILE GUARDS IS THE CLASS, NOT THE ONE COMPONENT. The pages that hand their
 * entire body to one component are discovered here rather than listed, by looking for
 * the `rows={toRows(rows)}` hand-off that every board on this site uses, so a third
 * such page is covered the day it is written instead of the day somebody remembers.
 *
 * The rule those components are held to: a `return null` may not be gated on a piece of
 * `useState`. A condition derived from props is a legitimate "there is nothing to draw"
 * - `PairPanels` returns null below two quote assets and should - but a hook state is by
 * definition a thing that starts unresolved and resolves later, which is a load, and a
 * load is the one state that must be visible. That distinction is the point: it passes
 * the panel that is correctly silent and fails the page that is silently blank.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { maskComments } from './testing/maskComments.ts';

const SRC = join(import.meta.dirname, '..');

/** Every `page.tsx` under `src/app`, found rather than listed. */
function pageFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) pageFiles(p, out);
    else if (e.name === 'page.tsx') out.push(p);
  }
  return out;
}

/**
 * The components a page hands its board rows to.
 *
 * `rows={toRows(rows)}` is the hand-off: the server has read the chain and from here on
 * the component owns what the reader sees. Anything in that position can blank a page.
 */
function boardComponents(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of pageFiles(join(SRC, 'app'))) {
    const src = maskComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/<([A-Z]\w*)\s+rows=\{toRows\(rows\)\}/g)) {
      const page = file.slice(SRC.length + 1);
      found.set(m[1], [...(found.get(m[1]) ?? []), page]);
    }
  }
  return found;
}

function componentSource(name: string): string | null {
  try {
    return maskComments(readFileSync(join(SRC, 'components', `${name}.tsx`), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The names bound by a state hook, which is to say what starts unresolved.
 *
 * The setter is optional in the pattern on purpose. A mutation that wrote
 * `const [x] = useState(1)` walked straight past an earlier version of this that
 * required `[name, setName]`, and the hole was not hypothetical in the other
 * direction either: the exemption test below asserts a component holds NO hook state,
 * so a pattern that cannot see a one-element destructure would have let that
 * exemption go stale silently. A setter-less state cannot in fact pend, since nothing
 * can resolve it, so matching it costs a false positive nobody will ever hit and
 * closes a blind spot that two separate assertions were resting on.
 *
 * `useReducer` is included because it is the same thing with more ceremony.
 */
function hookStateNames(src: string): string[] {
  const names: string[] = [];
  const pattern = /const\s*\[\s*(\w+)\s*(?:,\s*\w+\s*)?\]\s*=\s*(?:React\.)?use(?:State|Reducer)\b/g;
  for (const m of src.matchAll(pattern)) names.push(m[1]);
  return names;
}

test('the pages that hand their whole body to one component are findable', () => {
  /*
   * Anti-vacuity, and the only thing standing between this file and passing for ever by
   * measuring nothing. If the hand-off is ever written differently the discovery above
   * finds an empty set and every assertion below becomes a loop over nothing.
   */
  const found = boardComponents();
  assert.ok(found.size >= 3, `only found ${found.size} board components`);
  assert.ok(found.has('WatchlistBoard'), 'the watchlist board is not being discovered');
  assert.ok(found.has('Portfolio'), 'the portfolio is not being discovered');
  for (const name of found.keys()) {
    assert.ok(componentSource(name), `${name} was discovered but its source was not read`);
  }
});

test('no board blanks its page while a hook state is unresolved', () => {
  for (const [name, pages] of boardComponents()) {
    const src = componentSource(name);
    if (!src) continue;
    const states = hookStateNames(src);
    for (const m of src.matchAll(/if\s*\(([^)]*)\)\s*return null\s*;/g)) {
      const cond = m[1];
      const pending = states.find((s) => new RegExp(`\\b${s}\\b`).test(cond));
      assert.ok(
        !pending,
        `${name} (on ${pages.join(', ')}) returns null on \`${cond.trim()}\`, and ` +
          `\`${pending}\` is a useState. That leaves the page as a heading and nothing ` +
          `else while the read lands. Render a line that says it is loading instead.`,
      );
    }
  }
});

test('a condition derived from props may still render nothing', () => {
  /*
   * The other half, which is what makes the rule above worth having rather than a blunt
   * ban on `return null`. `PairPanels` is a second panel on a page that has a board of
   * its own, and below two quote assets there is genuinely nothing to compare, so its
   * silence is an answer. It must keep passing.
   */
  const src = componentSource('PairPanels');
  assert.ok(src, 'PairPanels was not read');
  assert.match(src, /return null\s*;/, 'the case this test exists to protect is gone');
  const states = hookStateNames(src);
  assert.deepEqual(states, [], 'PairPanels now holds hook state; re-check this exemption');
});

test('the watchlist says it is loading, in words, before storage answers', () => {
  const src = componentSource('WatchlistBoard');
  assert.ok(src, 'WatchlistBoard was not read');
  assert.match(src, /if\s*\(ids === null\)\s*\{/, 'the pending branch must still exist');
  assert.match(src, /Loading your watchlist/, 'the pending branch must say so');
  /*
   * And it must not be reachable only after the real answer. The loading line has to sit
   * above the empty state, because the empty state is the statement it exists to avoid
   * making too early.
   */
  assert.ok(
    src.indexOf('Loading your watchlist') < src.indexOf('Nothing on your watchlist'),
    'the loading line comes after the empty state, so the empty state wins first',
  );
});

test('the portfolio names the account it is reading, and does not blank', () => {
  /*
   * The sibling case, already correct, asserted so that a later simplification cannot
   * quietly turn it into the defect F-13 reported. It is also where the wording and the
   * spacing of the watchlist's line come from: two pages answering "not read yet"
   * differently is the drift that makes an interface read as unconsidered.
   */
  const src = componentSource('Portfolio');
  assert.ok(src, 'Portfolio was not read');
  assert.match(src, /if\s*\(balances === undefined\)\s*\{/, 'the pending branch must exist');
  assert.match(src, /Reading \{shortAddress\(account\.address\)\}/, 'it must name the account');
});
