/**
 * A popover restores focus when it CLOSES, and never on the first render.
 *
 * Measured on the running app, /portfolio at a cold load with no wallet connected and
 * nothing clicked: `document.activeElement` was the Connect wallet button. The restore
 * effect in `ConnectWallet` ran on mount, where `open` is false and the active element is
 * the body - the two conditions it used to decide a close had just happened. So on every
 * page load it took focus from the top of the document, which puts a keyboard user past
 * the skip link before their first Tab and drops a screen reader into the header.
 *
 * `open === false` cannot tell a close from a first render. A ref that records whether
 * the popover was ever opened can, and that is the whole fix - which is why this guard
 * reads for the ref rather than for the `focus()` call. Every component in this app that
 * dismisses itself through `useDismissOnEscape` is found by scanning for that import, so
 * a third popover added later is covered without anyone remembering to add it here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { maskComments } from './testing/maskComments.ts';

const SRC = join(import.meta.dirname, '..');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/*
 * Comments masked with the shared helper, so the prose above each fix - which names the
 * very calls these assertions look for - cannot satisfy them.
 */
const code = maskComments;

/** Every component that dismisses itself on Escape or an outside click. */
function popovers(): Array<{ file: string; body: string }> {
  const out: Array<{ file: string; body: string }> = [];
  for (const file of sources(SRC)) {
    // The hook's own module declares the name and is not a caller of it. Without this it
    // matched the scan and then failed the call-shape check against its own signature.
    if (file.endsWith('useDismissOnEscape.ts')) continue;
    const body = code(readFileSync(file, 'utf8'));
    if (/useDismissOnEscape\s*\(/.test(body)) out.push({ file, body });
  }
  // A broken scan would pass everything below by finding nothing to check.
  assert.ok(out.length >= 2, `only ${out.length} popovers found: the scan is not measuring`);
  return out;
}

test('a popover tells a close apart from its first render before restoring focus', () => {
  for (const { file, body } of popovers()) {
    if (!/triggerRef\.current\?\.focus\(\)/.test(body)) continue;
    assert.match(
      body,
      /everOpened\.current\s*=\s*true/,
      `${file} restores focus and never records that it was opened, so it runs on mount`,
    );
    assert.match(
      body,
      /if\s*\(\s*!everOpened\.current\s*\)\s*return/,
      `${file} does not bail out of the restore on a render where it was never open`,
    );
  }
});

test('focus is restored only when it was lost, never pulled back from elsewhere', () => {
  /*
   * An outside click moves focus to whatever was clicked, and dragging it back to the
   * trigger from there is its own bug. Unmounting the focused node is what drops the
   * active element to the body, so that is the one state worth restoring from.
   */
  for (const { file, body } of popovers()) {
    if (!/triggerRef\.current\?\.focus\(\)/.test(body)) continue;
    assert.match(
      body,
      /document\.activeElement/,
      `${file} restores focus without checking whether focus was actually lost`,
    );
    assert.match(
      body,
      /===\s*document\.body/,
      `${file} does not test for the body, which is where a removed node leaves focus`,
    );
  }
});

test('the dismiss hook is told which container it belongs to', () => {
  /*
   * `useDismissOnEscape` fires on `mousedown`, which precedes `click`. A container
   * selector that does not match the popover reads every click inside it as an outside
   * click, closes before the `click` lands, and its links then silently do not navigate.
   * The third argument is required rather than defaulted for exactly that reason: a
   * default would have carried the first caller's selector into the second one in
   * silence.
   */
  const hook = code(readFileSync(join(SRC, 'lib', 'useDismissOnEscape.ts'), 'utf8'));
  assert.match(
    hook,
    /within:\s*string\s*\)/,
    'the container selector is optional again, so a new caller can inherit a wrong one',
  );
  assert.ok(!/within\s*=\s*['"]/.test(hook), 'the container selector has a default again');

  for (const { file, body } of popovers()) {
    const call = /useDismissOnEscape\(([^;]*)\)/.exec(body);
    assert.ok(call, `${file} matched the scan and then did not parse`);
    assert.ok(
      /,\s*['"][.#][\w-]+['"]\s*\)?\s*$/.test(call[1].trim()),
      `${file} does not pass a container selector to useDismissOnEscape`,
    );
  }
});
