import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { maskComments } from './testing/maskComments.ts';

/**
 * A constant the runbook tells you to derive must be a constant the deploy can receive.
 *
 * THE DEFECT THIS EXISTS FOR. Step 6 of the mainnet runbook runs
 * `derive-curve-scale.mjs`, which measures the INJ price and prints the opening virtual
 * reserve for a target market cap. Step 7 then ran `deploy.mjs`, which instantiated the
 * factory with the literal `'676'`. The derive script's own closing line printed the
 * figure it had just computed as a shell COMMENT:
 *
 *     INJ_LAUNCH_FEE=0.2 node scripts/deploy.mjs   # with quote_virtual_whole 676
 *
 * So an operator following the runbook exactly on 16 Oct 2026 would derive 590, deploy
 * 676, and get launches opening at $5,727 against the $5,000 they had just chosen. No
 * error, no warning, and the only evidence anywhere was the market cap itself.
 *
 * Each of the three pieces was locally reasonable - a documented script, a documented
 * literal, a helpful copyable command - and the hole was between them. That is the
 * class: a value that is measured in one place and hardcoded in another, with prose
 * carrying it across the gap.
 *
 * WHY A SOURCE GUARD. Running `deploy.mjs` broadcasts transactions and spends gas, so
 * there is no unit test of the real path. What can be pinned is that the three surfaces
 * agree: the deploy reads the variable and refuses on mainnet without it, the derive
 * script emits a command that carries the number, and the runbook names the variable
 * without handing over a literal to copy.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** Comment ranges blanked so prose explaining a rule cannot satisfy or break it. */
const code = (rel: string) => maskComments(readFileSync(join(ROOT, rel), 'utf8'));

const DEPLOY = code('scripts/deploy.mjs');
const DERIVE = readFileSync(join(ROOT, 'scripts', 'derive-curve-scale.mjs'), 'utf8');
const DERIVE_CODE = code('scripts/derive-curve-scale.mjs');
const RUNBOOK = readFileSync(join(ROOT, 'docs', 'MAINNET-RUNBOOK.md'), 'utf8');
const ENV_EXAMPLE = readFileSync(join(ROOT, 'scripts', '.env.example'), 'utf8');

test('the instantiate message takes the reserve from configuration, not a literal', () => {
  assert.match(
    DEPLOY,
    /quote_virtual_whole: quoteVirtualWhole\(\)/,
    'the opening reserve is no longer read through the resolver',
  );
  /*
   * The literal is what regressed once already. It may still appear as the testnet
   * default inside the resolver, so this looks for it as the instantiate value - the
   * one position where it cannot be overridden by an operator.
   */
  assert.doesNotMatch(
    DEPLOY,
    /quote_virtual_whole:\s*'[0-9]/,
    'the opening reserve is a hardcoded literal in the instantiate message again',
  );
});

test('mainnet refuses an unset reserve rather than defaulting to a dated premise', () => {
  const fn = DEPLOY.slice(
    DEPLOY.indexOf('function quoteVirtualWhole()'),
    DEPLOY.indexOf('function launchFeeBaseUnits()'),
  );
  assert.ok(fn.length > 100, 'the resolver could not be located, so nothing below was measured');
  assert.match(fn, /netName === 'mainnet'/, 'the resolver no longer distinguishes mainnet');
  assert.match(fn, /\bdie\(/, 'the resolver no longer refuses, so an unset value takes a default');
  /*
   * Whole quote units, not base units. 590 and 590000000000000000000 are both plausible
   * to type and differ by 1e18, which would put the opening market cap of every launch
   * on the platform off by that factor.
   */
  assert.match(fn, /\^\[1-9\]\[0-9\]\*\$/, 'the value is no longer validated as a whole number');
});

test('the derive script emits a command that carries the number it derived', () => {
  /*
   * Read with comments intact, because the point is the printed output and a `#` in a
   * template literal is not a comment. Then asserted against the masked copy too, so
   * the paragraph explaining the old broken line cannot be what satisfies this.
   */
  assert.match(
    DERIVE_CODE,
    /INJ_QUOTE_VIRTUAL_WHOLE=\$\{whole\}/,
    'the derive script no longer prints the derived constant into the deploy command',
  );
  const printed = DERIVE.match(/# with quote_virtual_whole/g) ?? [];
  assert.ok(
    printed.length === 0 || !DERIVE_CODE.includes('# with quote_virtual_whole'),
    'the derived figure is a shell comment again, which is how it reached nothing',
  );
});

test('the runbook names the variable and does not offer a literal to copy', () => {
  assert.match(
    RUNBOOK,
    /Carry the number into step 7 as `INJ_QUOTE_VIRTUAL_WHOLE`/,
    'the runbook no longer tells the operator where the derived number goes',
  );
  const deployBlock = RUNBOOK.slice(RUNBOOK.indexOf('### 7. Deploy'));
  const command = deployBlock.slice(0, deployBlock.indexOf('node scripts/deploy.mjs'));
  assert.ok(command.length > 50, 'step 7 command block not found, so nothing was measured');
  assert.match(
    command,
    /INJ_QUOTE_VIRTUAL_WHOLE=/,
    'step 7 no longer passes the reserve, so a mainnet deploy stops partway through',
  );
  /*
   * A number here would be copied. The whole defect was somebody deploying a figure
   * they had not derived, and a runbook that prints one is the most persuasive place
   * for that to happen - it is the line you paste.
   */
  assert.doesNotMatch(
    command,
    /INJ_QUOTE_VIRTUAL_WHOLE=[0-9]/,
    'step 7 carries a copyable literal, which re-creates the deploy-what-you-did-not-derive defect',
  );
});

test('the variable is documented where an operator configures the deploy', () => {
  assert.match(ENV_EXAMPLE, /^INJ_QUOTE_VIRTUAL_WHOLE=$/m, 'the variable left .env.example');
  assert.match(
    ENV_EXAMPLE,
    /derive-curve-scale\.mjs/,
    'the documentation no longer points at the script that derives the value',
  );
});
