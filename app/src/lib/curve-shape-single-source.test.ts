import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fixedCurveFor, FIXED_CURVE, DEFAULT_FEE_BPS } from './launchLimits.ts';

/**
 * Does every drawn curve use the curve launches actually get?
 *
 * THE DEFECT THIS EXISTS FOR. The curve was flattened from 30/85 to 60/170 to halve
 * price impact. The factory changed, `launchLimits.ts` changed, and two files holding
 * their own copy of the shape did not: `CurveExplorer`, which IS the homepage hero,
 * and `demo.ts`. The hero then told every visitor graduation happens at 88 INJ when
 * the deployed curve needs about 175, and quoted a token amount for 1 INJ that no
 * launch would ever charge, directly under a docblock asserting every number is real.
 *
 * NOTHING CAUGHT IT. 245 app tests and 135 contract tests passed, the typecheck was
 * clean, and the page rendered a perfectly plausible curve. A duplicated constant
 * does not drift visibly; it drifts into looking correct. Only opening the page and
 * reading the figure against the deployed factory found it.
 *
 * So this is a source guard rather than a unit test, for the same reason the theme
 * tokens and the fee scale have one: each copy was written to be right, so nothing
 * about any of them looks wrong on the next pass.
 */

const SRC = join(import.meta.dirname, '..');

/**
 * The one file allowed to say what the shape is, plus tests.
 *
 * `curve.ts` declares the TYPE and takes a config as an argument, which is the
 * opposite of holding a copy. Anything reading the shape from the chain is building
 * a config out of measured values and is not a second definition either, so the
 * guard looks only for NUMERIC LITERALS.
 */
const DEFINES_THE_SHAPE = 'lib/launchLimits.ts';

function stripComments(src: string): string {
  // Ranges are blanked rather than removed, so reported line numbers still point at
  // the real line. A line-based filter rewrites a block comment's interior, and a
  // character scanner breaks on an apostrophe in JSX text; both happened here before.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

test('no file but launchLimits writes the curve shape as a literal', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file);
    if (rel === DEFINES_THE_SHAPE) continue;
    const src = stripComments(readFileSync(file, 'utf8'));
    /*
     * A literal is a digit or an `n`-suffixed bigint. `virtualInj: BigInt(x)` and
     * `virtualInj: r.config.virtualInj` are reads, not definitions, and both appear
     * legitimately in the code that parses a curve off the chain.
     */
    for (const key of ['virtualInj', 'virtualTokens', 'curveSupply', 'graduationTarget']) {
      /*
       * It must be an object KEY: at a line start or after `{` or `,`. A bare
       * `key\s*:\s*[0-9]` also matches the second arm of a ternary, which is how the
       * first version of this guard reported `curve.ts`'s
       * `total > cfg.virtualInj ? total - cfg.virtualInj : 0n` as a hardcoded shape.
       * A guard that cries wolf on correct code gets the guard deleted.
       */
      const re = new RegExp(`(?:^|[{,])\\s*${key}\\s*:\\s*[0-9]`, 'gm');
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const line = src.slice(0, m.index).split('\n').length;
        offenders.push(`${rel}:${line} writes ${key} as a literal`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `The curve shape is policy and lives in launchLimits.ts. Spread fixedCurveFor(decimals) instead:\n  ${offenders.join('\n  ')}`,
  );
});

test('the homepage hero prices the curve a launch actually gets', async () => {
  /*
   * The value, not just the source. The guard above would pass a file that spread
   * `fixedCurveFor` and then overrode `graduationTarget` with a read of something
   * stale, and the hero's whole claim is that its figures are what a real launch
   * would charge.
   */
  const shipped = fixedCurveFor(18);
  assert.equal(shipped.graduationTarget, FIXED_CURVE.graduationTarget);
  assert.equal(shipped.virtualInj, FIXED_CURVE.virtualInj);

  const hero = stripComments(
    readFileSync(join(SRC, 'components/CurveExplorer.tsx'), 'utf8'),
  );
  assert.match(
    hero,
    /\.\.\.fixedCurveFor\(/,
    'CurveExplorer must spread the shipped curve rather than declaring one.',
  );
  assert.match(
    hero,
    /feeBps:\s*BigInt\(DEFAULT_FEE_BPS\)/,
    'The hero quotes a trade, so its fee must be the default a new launch gets.',
  );
});

test('the create form starts at the shared default fee, in percent', () => {
  const form = stripComments(
    readFileSync(join(SRC, 'components/CreateLaunch.tsx'), 'utf8'),
  );
  /*
   * The field takes PERCENT and the constant is bps, so the form divides by 100.
   * Asserted because the two have been out of step before in the worse direction:
   * the field was switched to percent while the default stayed '100', which would
   * have defaulted every launch to a 100% fee.
   */
  assert.match(form, /feeBps:\s*String\(DEFAULT_FEE_BPS\s*\/\s*100\)/);
  assert.match(form, /feeSellBps:\s*String\(DEFAULT_FEE_BPS\s*\/\s*100\)/);
  assert.ok(
    DEFAULT_FEE_BPS % 100 === 0,
    'A default that is not a whole percent cannot be the form field’s initial value.',
  );
});
