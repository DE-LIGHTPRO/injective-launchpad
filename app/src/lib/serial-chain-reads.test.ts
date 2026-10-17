/**
 * A READ THAT IS THE SAME FOR EVERY ITEM BELONGS OUTSIDE THE LOOP, AND A READ THAT
 * NEEDS NOTHING BELONGS IN THE SAME TURN AS THE ONE BEFORE IT.
 *
 * Both halves of that were broken here, and neither failed - they only cost time, which
 * is why nothing noticed. Measured against the configured LCD, five samples each:
 * `launches` 155ms, `quotes` 169ms, `blocks/latest` 173ms. A round trip is the unit.
 *
 *  - THE FRONT PAGE awaited `loadRows()` and then `currentHeight()`, under a comment
 *    saying the height was read "alongside the rows, so one slow call does not serialise
 *    behind another". It was read second. `currentHeight` carries a 4s timeout and its
 *    own comment saying a slow node "delays nothing", so a stalling node held the whole
 *    board behind a decorative column for up to four seconds.
 *  - `loadRows` awaited `listLaunches()` then `listQuotes()`, two queries to one contract
 *    that need nothing from each other, on all four pages that render the board.
 *  - THE LAUNCH PAGE paid four phases in a row - board, detail, quote, trade history -
 *    where the quote read takes no argument and could have ridden with the detail.
 *  - WORST: `ClaimFees` called `resolveQuote` inside its per-launch fan-out, and
 *    `resolveQuote` is `listQuotes()` plus a local find. Ten launches meant ten
 *    byte-identical queries for a list identical across the board, a third of that
 *    page's requests. Nothing cached them: `smartQuery` is a bare `fetch` and the
 *    component is client-side, so Next's request dedupe never saw it.
 *
 * The comments are the lesson. Three of the four sites carried prose asserting the
 * parallelism they did not have, so reading the explanation was worse than reading
 * nothing. These assertions read the BINDING and the CALL SITE instead.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { maskComments } from './testing/maskComments.ts';

const SRC = new URL('..', import.meta.url).pathname;

/** Every shipped source file, comments masked. Tests and this file excluded. */
function sources(): Array<{ path: string; src: string }> {
  const out: Array<{ path: string; src: string }> = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        out.push({ path: p.slice(SRC.length), src: maskComments(readFileSync(p, 'utf8')) });
      }
    }
  };
  walk(SRC.replace(/\/$/, ''));
  // Anti-vacuity: a walk that found nothing would pass everything below. 90 shipped
  // files today, so this is a floor on the walk working rather than a count to maintain.
  assert.ok(out.length > 60, `only ${out.length} source files walked: not measuring`);
  return out;
}

const SOURCES = sources();

/** The text between a `(` at `open` and its matching `)`. */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open);
}

/**
 * Reads whose result is the same for every launch on the board, so calling one per
 * launch is duplication rather than work. `resolveQuote` is here because it IS
 * `listQuotes()` - that is the whole reason it was invisible inside the fan-out.
 */
const BOARD_WIDE = ['listQuotes', 'listLaunches', 'resolveQuote'];

test('a board-wide read is never inside a per-launch fan-out', () => {
  let fanOuts = 0;
  for (const { path, src } of SOURCES) {
    for (const m of src.matchAll(/\bmapWithConcurrency\s*(?:<[^(]*?>\s*)?\(/g)) {
      const open = src.indexOf('(', m.index + 'mapWithConcurrency'.length);
      const body = balanced(src, open);
      fanOuts += 1;
      for (const fn of BOARD_WIDE) {
        assert.ok(
          !new RegExp(`\\b${fn}\\s*\\(`).test(body),
          `${path} calls ${fn}() inside a mapWithConcurrency fan-out, so it repeats one identical request per item`,
        );
      }
    }
  }
  // Anti-vacuity: the regex missing every fan-out would pass this silently.
  assert.ok(fanOuts >= 2, `only ${fanOuts} fan-out site(s) found: the scan is not measuring`);
});

/**
 * True when one `Promise.all([…])` in this file starts both of these reads.
 *
 * The ARGUMENT LIST, not the binding. The first draft read the enclosing declaration
 * and required it to destructure a tuple, which failed on the launch page: it declares
 * `let launch, detail, facts, quotes` ahead of the try block and assigns into them, so
 * there is no `const` to read and the guard reported a correct file as broken. What
 * "share one turn" actually means is that both calls are started before either is
 * awaited, and that is visible in the argument list whatever the binding looks like.
 */
function startedTogether(src: string, call: RegExp, other: string): boolean {
  for (const m of src.matchAll(/\bPromise\.all\s*\(/g)) {
    const args = balanced(src, src.indexOf('(', m.index + 'Promise.all'.length));
    if (call.test(args) && new RegExp(`\\b${other}\\s*\\(`).test(args)) return true;
  }
  return false;
}

/**
 * Pinned per site rather than derived, deliberately.
 *
 * The general rule - a zero-argument read never needs its own turn - is true and not
 * safely checkable from source: `listLaunches()` is awaited alone and correctly in three
 * places where it is the first read in its function, and a guard that cannot see
 * function boundaries would fail all three. A guard that fails on correct code is one
 * somebody deletes, so this names the four sites that were measured wrong and says why
 * it is a list.
 */
const SHARE_A_TURN: Array<{ file: string; call: RegExp; with: string }> = [
  // The board and the block height: independent, and the height has a 4s timeout.
  { file: 'app/page.tsx', call: /\bcurrentHeight\s*\(/, with: 'loadRows' },
  // The launches and the quote allowlist: two queries to one contract, four pages.
  { file: 'lib/boardRows.ts', call: /\blistQuotes\s*\(/, with: 'listLaunches' },
  // The quote allowlist rides with the detail on the page a trader lands on.
  { file: 'app/launch/[slug]/page.tsx', call: /\blistQuotes\s*\(/, with: 'getLaunchDetail' },
];

test('two reads that need nothing from each other share one turn', () => {
  for (const { file, call, with: other } of SHARE_A_TURN) {
    const src = maskComments(readFileSync(`${SRC}${file}`, 'utf8'));
    // The call must still be there at all, or this is pinning a site that has moved.
    assert.match(src, call, `${file} no longer calls ${call.source}`);
    assert.ok(
      startedTogether(src, call, other),
      `${file} awaits ${call.source} on its own turn instead of starting it with ${other}()`,
    );
  }
});

test('the quote allowlist has one reader that fetches and one that picks', () => {
  /*
   * `resolveQuote` is the convenience, `quoteFromList` is the pick. The split exists so
   * a caller holding the list does not re-fetch it, and it is only worth anything while
   * the fetching one stays a thin wrapper: a second copy of the decimals fallback is how
   * two screens come to disagree about a launch's decimals, which scales every figure on
   * them.
   */
  const chain = maskComments(readFileSync(`${SRC}lib/chain.ts`, 'utf8'));
  const open = chain.indexOf('{', chain.indexOf('export async function resolveQuote'));
  const body = chain.slice(open, chain.indexOf('\n}', open));
  assert.match(body, /\bquoteFromList\s*\(/, 'resolveQuote no longer delegates to quoteFromList');
  assert.ok(
    !/NETWORK\.quoteDecimals/.test(body),
    'resolveQuote has its own copy of the decimals fallback, so the two can disagree',
  );
});
