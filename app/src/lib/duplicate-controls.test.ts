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
