import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { maskComments } from './testing/maskComments.ts';
import { graduationProgress, type CurveConfig, type CurveState } from './curve.ts';

/**
 * Does a graduated launch stop describing itself as still climbing?
 *
 * AUDIT F-06, and it is the same defect this page already records once. A comment
 * beside the token rows says "THREE ROWS ABOUT THE CURVE, AND MIGRATION INVALIDATED
 * ALL THREE" - those were fixed, and the rows on the QUOTE side were left behind.
 *
 * Measured on testnet E2E88375, a graduated launch: the page read "Progress to
 * graduation 100.0%" for an event that is over, "Graduates at 15,169 E2EUSD" in the
 * future tense for one that already happened, and "Pool liquidity 6,724.38" beside it,
 * less than half that target with nothing explaining the gap. The word "graduated"
 * appeared nowhere a visitor could see it: only in the `<meta name="description">`,
 * which reaches crawlers and link previews and no reader.
 *
 * AND THE 100% WAS NEVER A MEASUREMENT. The contract zeroes `injCollected` when it
 * seeds the pool, so the figure it would be derived from is gone - that same launch
 * reports a recorded raise of exactly 0, which is the audit's "0 raised at 100%".
 * `graduationProgress` returns 1 on `st.graduated` for precisely that reason, which is
 * correct and is also why the percentage is the wrong thing to print.
 */

const PAGE = maskComments(
  readFileSync(join(import.meta.dirname, '..', 'app', 'launch', '[slug]', 'page.tsx'), 'utf8'),
);

test('a zeroed raise still reports full progress, not none', () => {
  /*
   * The behaviour the page depends on, pinned here rather than left as a comment:
   * a graduated curve's `injCollected` is 0, and without the `graduated` branch a
   * finished launch would draw an empty bar.
   */
  const cfg = { graduationTarget: 15_169_000_000n } as unknown as CurveConfig;
  const graduated = { injCollected: 0n, graduated: true } as unknown as CurveState;
  const fresh = { injCollected: 0n, graduated: false } as unknown as CurveState;
  assert.equal(graduationProgress(cfg, graduated), 1, 'a graduated launch reads as 0% progress');
  assert.equal(graduationProgress(cfg, fresh), 0);
  // Half way, to show the ordinary path still measures rather than short-circuiting.
  const half = { injCollected: 7_584_500_000n, graduated: false } as unknown as CurveState;
  assert.ok(Math.abs(graduationProgress(cfg, half) - 0.5) < 0.001);
});

test('the quote-side rows change tense once the launch has graduated', () => {
  /*
   * Asserted on the page source because these are server-rendered rows with no seam to
   * call. Each is checked as a PAIR of label and condition: a past-tense label that is
   * not conditional would be wrong on every live launch, which is the same defect
   * pointing the other way.
   */
  for (const [past, present] of [
    ['Graduated at', 'Graduates at'],
    ['Status', 'Progress to graduation'],
  ] as const) {
    assert.match(
      PAGE,
      new RegExp(`detail\\.pool \\? '${past}' : '${present}'`),
      `the "${present}" row does not switch to "${past}" on a graduated launch, so it reads ` +
        `as still climbing toward something that is over`,
    );
  }
  // And the percentage is not printed for a finished launch.
  assert.match(
    PAGE,
    /detail\.pool \? 'Graduated' : `\$\{\(progress \* 100\)\.toFixed\(1\)\}%`/,
    'a graduated launch still prints a progress percentage derived from a zeroed field',
  );
});

test('the pool figure is explained, and only where there is a pool', () => {
  /*
   * The target and the pool balance genuinely do not reconcile - part of the raise
   * seeds the pool, the rest was paid out as fees, and the balance then moves with
   * trading - so the gap needs a sentence or the only available reading is that money
   * went missing.
   *
   * Conditional, because on a live launch there is no pool and the sentence would be
   * describing something that does not exist.
   */
  assert.match(
    PAGE,
    /\{detail\.pool && \(\s*<p className="note"/,
    'the pool figure is unexplained, or is explained on launches that have no pool',
  );
  assert.match(PAGE, /not the amount[\s\S]{0,20}raised/, 'nothing says the pool figure is not the raise');
  /*
   * AND NO INVENTED RAISE. The audit asked for "raised at graduation" and the chain
   * does not retain it: `injCollected` is zeroed and the split cannot be reversed. A
   * figure derived from the target and the pool balance would look plausible and be
   * measured by nobody, which is the one thing this product claims not to do.
   */
  assert.doesNotMatch(
    PAGE,
    /[Rr]aised at graduation/,
    'the page shows a raised-at-graduation figure, which the contract zeroes and nothing can recover',
  );
});
