import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Is the same action offered twice on one screen?
 *
 * THE DEFECT THIS EXISTS FOR. The create page showed two identical "Connect wallet"
 * buttons at once: one in the header and one in the Sign card. Both wrote to the same
 * shared store, so they did exactly the same thing, and a reader seeing two of a
 * control has to work out whether they differ. They did not.
 *
 * It was not obviously wrong when each was written. The in-panel button predates the
 * shared wallet store, when connecting in the header genuinely did NOT reach the
 * panel; once the store landed the button became a duplicate, and nothing failed.
 * That is the shape to guard: a control that stopped being necessary rather than one
 * that was wrong to add.
 */

const COMPONENTS = join(import.meta.dirname, '..', 'components');
const LAYOUT = join(import.meta.dirname, '..', 'app', 'layout.tsx');

test('the wallet connect control lives in exactly one place', () => {
  /*
   * The header is `position: sticky`, measured on the deployed site, so its button is
   * on screen at every scroll position. Anything else rendering `<ConnectWallet>` is
   * therefore a second copy of a control the reader can already see.
   */
  const layout = readFileSync(LAYOUT, 'utf8');
  assert.ok(layout.includes('<ConnectWallet'), 'the header lost its connect button');

  const offenders = readdirSync(COMPONENTS)
    .filter((f) => f.endsWith('.tsx'))
    .filter((f) => f !== 'ConnectWallet.tsx')
    .filter((f) => /<ConnectWallet[\s/>]/.test(readFileSync(join(COMPONENTS, f), 'utf8')));

  assert.deepEqual(
    offenders,
    [],
    'a component renders its own connect button; the sticky header already has one',
  );
});

/*
 * A LAUNCH'S STAGE IS DECIDED IN ONE PLACE, and the board had a second one.
 *
 * `StatusChip` exists because the list and the detail page each derived the label from
 * `graduated` alone and both said "live" on a launch whose start time had not arrived.
 * The board then went on rendering its own `<span className="tag tag-pool">Pool</span>`
 * for the graduated case, so three of the four stages came from the component and the
 * fourth came from a hardcoded span: the same defect, surviving for one stage, in the
 * file the component was written to fix.
 *
 * It was also the reason `StatusChip` could keep `migrated = false` as a default. The
 * board never passed it and never suffered, because the branch above it meant the chip
 * only ever saw launches that had not graduated. Remove the span and the default becomes
 * live: it would label a launch trading against its locked pool "graduated".
 */
const STAGE_SOURCES = ['launchStatus(', 'statusLabel('];

test('nothing but the chip decides what stage a launch is in', () => {
  const SRC = join(import.meta.dirname, '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.tsx')) files.push(p);
    }
  };
  walk(SRC);

  const renderers: string[] = [];
  const offenders: string[] = [];
  for (const file of files) {
    const rel = file.slice(SRC.length + 1);
    const src = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
      .replace(/\/\/[^\n]*/g, '');
    if (/<StatusChip\b/.test(src)) renderers.push(rel);
    if (rel === 'components/StatusChip.tsx') continue;
    for (const call of STAGE_SOURCES) {
      if (src.includes(call)) offenders.push(`${rel}: calls ${call})`);
    }
    // The replaced span, by its class rather than by its word: "Pool" is a reasonable
    // thing to write and `tag-pool` was only ever this one label.
    if (/tag-pool/.test(src)) offenders.push(`${rel}: renders its own stage badge`);
  }

  /*
   * Anti-vacuity, and it is the half that matters here: a guard that only forbids the
   * second source passes perfectly on a product that has lost the first. The board and
   * the detail page are both named, because those are the two screens whose
   * disagreement is the defect on record.
   */
  assert.ok(
    renderers.includes('components/LaunchList.tsx'),
    'the board no longer renders StatusChip, so its stage label is coming from somewhere else',
  );
  assert.ok(
    renderers.length >= 2,
    `expected the chip on more than one screen, found ${renderers.join(', ') || 'none'}`,
  );
  assert.deepEqual(offenders, [], 'a second place decides what a launch is');
});

test('the chip is told both late stages, never left to assume one', () => {
  /*
   * `migrated` separates "graduated" from "in pool" and nothing else does. Defaulted, it
   * is wrong for every launch that has one - which, since `exec_buy` seeds the pool in
   * the same transaction that fills the curve, is every graduated launch there is.
   */
  const src = readFileSync(join(COMPONENTS, 'StatusChip.tsx'), 'utf8');
  for (const prop of ['graduated', 'migrated']) {
    assert.match(src, new RegExp(`\\b${prop}\\s*:\\s*boolean`), `${prop} is not a required boolean`);
    assert.doesNotMatch(src, new RegExp(`\\b${prop}\\s*\\?\\s*:`), `${prop} is optional`);
    assert.doesNotMatch(src, new RegExp(`\\b${prop}\\s*=\\s*(true|false)`), `${prop} is defaulted`);
  }
});

test('the header connect button is reachable from anywhere', () => {
  /*
   * The whole argument for removing the in-panel buttons is that the header one is
   * always visible. If the header ever stops being sticky, those panels need their
   * own control back and this test is the thing that says so.
   */
  const css = readFileSync(join(import.meta.dirname, '..', 'app', 'globals.css'), 'utf8');
  /*
   * The selector is `header.top`, found by reading the stylesheet rather than
   * guessed. My first version matched `header {` and failed against correct CSS,
   * which is a test reporting its own pattern as a defect in the code.
   */
  const block = css.match(/header\.top\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(block, 'the `header.top` rule is gone; this guard needs re-pointing');
  assert.match(
    block,
    /position:\s*sticky/,
    'the header is no longer sticky, so its connect button is not always reachable',
  );
});
