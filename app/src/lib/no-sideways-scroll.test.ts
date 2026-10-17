import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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

/**
 * The other way a narrow screen loses content: the page does not scroll, a region does,
 * and the region cannot be focused.
 *
 * WCAG 2.1.1. `overflow-x: auto` on a div gives it no tab stop, so anything past its
 * right edge is reachable by trackpad gesture and by nothing else. Measured on the
 * launch board at 375px: 106px hidden, and the hidden part began inside Market cap,
 * which is the column `globals.css` itself calls the one a board is read by. The same
 * shape was in `.raw pre`, which holds the five messages exactly as they will be
 * signed - a keyboard user could open that disclosure and read only its first screenful.
 *
 * DERIVED FROM THE CSS, NOT FROM A LIST OF FILES. Listing the two components would have
 * guarded the two instances already fixed. The defect is the class: a third table, or any
 * new scrolling panel, reintroduces it. So this reads every rule in `globals.css` that
 * turns an element into a scroll container, and requires of each that the stylesheet has
 * a `:focus-visible` rule for it (someone drew the stop) and that every element the
 * selector targets carries `tabIndex={0}` in the JSX (someone created it). Neither half
 * alone is the fix: a focus ring on an unfocusable div never paints, and a tab stop with
 * no ring is a focus nobody can see.
 */
test('every scroll container can be reached by keyboard', () => {
  const css = stripComments(CSS);

  /*
   * Scroll containers, by the declaration that makes them one. `overflow-y` is excluded
   * deliberately: a vertically scrolling region is reachable by the page's own arrow
   * keys in a way a horizontal one is not, and sweeping it in would flag `max-height`
   * panels that are not a keyboard trap. `.raw pre` is here on its `overflow-x`.
   */
  const containers: Array<{ selector: string; target: string }> = [];
  for (const m of css.matchAll(/(^|\})\s*([^{}@]+?)\s*\{([^}]*)\}/g)) {
    const selector = m[2].trim();
    if (!/overflow(-x)?:\s*(auto|scroll)/.test(m[3])) continue;
    if (selector.includes(':')) continue; // a state rule, not the container itself
    // The element the selector lands on is its last simple part: `.raw pre` is the <pre>.
    containers.push({ selector, target: selector.split(/\s+/).pop()! });
  }

  // Anti-vacuity: a regex that stopped matching would make every assertion below pass.
  assert.ok(
    containers.length >= 2,
    `only ${containers.length} scroll containers found in globals.css; this sweep is not reading the file`,
  );

  const TSX = (function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.tsx$/.test(name)) out.push(p);
    }
    return out;
  })(join(import.meta.dirname, '..'));

  const offenders: string[] = [];
  for (const { selector, target } of containers) {
    if (!new RegExp(`\\${selector}:focus-visible\\b`.replace(/\s+/g, '\\s+')).test(css)) {
      offenders.push(`${selector} scrolls but has no :focus-visible rule, so its tab stop is invisible`);
    }

    /*
     * The opening tag of every element the selector targets. A class selector is matched
     * by its className; a bare element selector by its tag. Both then have to carry
     * tabIndex on that same tag, which is why the match runs to the first `>`.
     */
    const open = target.startsWith('.')
      ? new RegExp(`<[a-zA-Z][^>]*className="[^"]*\\b${target.slice(1)}\\b[^"]*"[^>]*>`, 'g')
      : new RegExp(`<${target}(\\s[^>]*)?>`, 'g');

    let seen = 0;
    for (const file of TSX) {
      for (const tag of readFileSync(file, 'utf8').matchAll(open)) {
        seen += 1;
        if (!/tabIndex=\{0\}/.test(tag[0])) {
          offenders.push(
            `${file.split('/src/').pop()} renders ${selector} without tabIndex={0}; ` +
              'it scrolls, so what is past its edge is unreachable by keyboard',
          );
        }
      }
    }
    assert.ok(seen > 0, `${selector} has a rule but nothing renders it; this guard is pointed at a dead class`);
  }

  assert.deepEqual(offenders, [], offenders.join('\n  '));
});
