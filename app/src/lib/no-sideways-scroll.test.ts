import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Can any layout push the page sideways on a narrow screen?
 *
 * WHY STATIC AND NOT MEASURED. A browser measurement is the better evidence and was
 * not available: the pane this session can drive is collapsed, so `innerWidth` and
 * `clientWidth` both read 0 and every element "overflows" a zero-width viewport. A
 * reading taken then is worse than none, because it looks like a result. This checks
 * the two shapes that actually cause it, which is durable in a way one measurement
 * on one viewport is not.
 *
 * `repeat(auto-fit, minmax(240px, 1fr))` cannot shrink below 240px, so on a 320px
 * phone with padding it forces a horizontal scrollbar. Written
 * `minmax(min(240px, 100%), 1fr)` the track collapses instead.
 */

const CSS = readFileSync(join(import.meta.dirname, '..', 'app', 'globals.css'), 'utf8');

function stripComments(s: string): string {
  /*
   * NEWLINES ARE PRESERVED. Replacing a multi-line comment with plain spaces
   * destroys its line breaks, so every line number after the first block comment
   * shifts. This guard reported its one real finding at line 238, inside a comment,
   * when the code was at line 350; the finding was right and the location was not,
   * which is the way a measurement wastes the most time.
   */
  return s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

test('every grid track can shrink below its own floor', () => {
  const css = stripComments(CSS);
  const offenders: string[] = [];
  for (const m of css.matchAll(/minmax\(\s*([^,)]+)\s*,/g)) {
    const floor = m[1].trim();
    // A percentage, `auto`, `0` or an already-wrapped `min(...)` are all safe.
    if (/^(auto|0|min\()/.test(floor) || floor.endsWith('%')) continue;
    if (/^\d/.test(floor)) {
      const at = css.slice(0, m.index).split('\n').length;
      offenders.push(`line ${at}: minmax(${floor}, …) cannot shrink below ${floor}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'a grid track has a hard floor; wrap it as minmax(min(Npx, 100%), 1fr)',
  );
});

test('flex rows holding their own content declare min-width', () => {
  /*
   * The other half of the same defect. A flex child defaults to `min-width: auto`,
   * which refuses to shrink below its content, so one long token name or address in
   * a row pushes the whole page sideways.
   *
   * Checked on the row classes added for the board's newer panels, which are the
   * ones carrying addresses and symbols of unbounded length.
   */
  const css = stripComments(CSS);
  for (const cls of ['.trending-row', '.pairs-row', '.hill-row', '.claim-rows']) {
    const block = css.match(new RegExp(`\\${cls}\\s*\\{[^}]*\\}`))?.[0];
    assert.ok(block, `${cls} has no rule; this guard needs re-pointing`);
    if (/display:\s*flex/.test(block!)) {
      assert.match(block!, /min-width:\s*0/, `${cls} is a flex row without min-width: 0`);
    }
  }
});
