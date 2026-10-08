/**
 * The glass surface, and the two ways it goes wrong silently.
 *
 * Glassmorphism has an accessibility failure mode that does not look like one: a
 * pane that passes the full ambient through makes the colour a glyph sits on
 * depend on whatever happens to be behind that particular card. Measured on one
 * screen of this app before the floor was added, the backdrop under identical
 * 11px text ran from rgb(24,44,52) to rgb(44,36,76), and the same token passed in
 * one card and failed at 2.95:1 in the next. A screenshot of the card that passes
 * shows nothing wrong.
 *
 * The second way is cheaper and worse: a class applied in JSX with no rule behind
 * it. `.err-text` was applied in three places in `TradePanel` and defined
 * nowhere, so the SEVERE price-impact tier rendered exactly like an ordinary row.
 * Every branch was correct and the only missing half was the one a user can see.
 *
 * Both are source-readable, and neither is reachable from a unit test of the
 * components, which is why they are checked here against the stylesheet itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const css = readFileSync(join(root, 'app/globals.css'), 'utf8');
/** Comments are prose, and a class named only in prose is not a defined class. */
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');

const tsxFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? tsxFiles(p) : p.endsWith('.tsx') ? [p] : [];
  });

test('every class the JSX applies has a rule behind it', () => {
  const defined = new Set([...cssCode.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  const missing: string[] = [];

  for (const file of tsxFiles(root)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      const raw = m[1] ?? m[2] ?? '';
      /*
       * Interpolations are dropped, not split.
       *
       * The first version of this check split on whitespace without stripping
       * `${...}` first, so `mono spark-change ${change >= 0 ? …}` produced a
       * phantom class named `change` and the check reported a defect in correct
       * code. A guard that invents findings gets ignored, which costs more than
       * not having it.
       */
      for (const cls of raw.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
        if (!cls || !/^[a-zA-Z][\w-]*$/.test(cls)) continue;
        if (!defined.has(cls)) missing.push(`${cls} (${file.slice(root.length)})`);
      }
    }
  }

  assert.deepEqual(missing, [], `classes applied with no CSS rule:\n  ${missing.join('\n  ')}`);
});

test('the glass fill keeps a dark floor under the white gradient', () => {
  /*
   * The floor is what bounds how much ambient reaches the text, so it is the
   * accessibility control rather than a tint. A white-only fill is the version
   * that measured 2.95:1, and it looks identical in a screenshot of any card
   * that happens to sit over a dark patch.
   */
  const fill = /--glass-fill:([\s\S]*?);\n/.exec(css)?.[1] ?? '';
  assert.ok(fill.length > 0, '--glass-fill is not declared');
  const floor = /rgba\(\s*\d+,\s*\d+,\s*\d+,\s*(0?\.\d+)\s*\)\s*,\s*rgba/.exec(fill);
  assert.ok(floor, `--glass-fill has no solid dark layer:\n${fill}`);
  assert.ok(
    Number(floor[1]) >= 0.3,
    `the dark floor is ${floor[1]}, which lets too much ambient through`,
  );
});

test('glass degrades to a solid surface where it cannot be drawn', () => {
  /*
   * Without `backdrop-filter` the fill is a few percent of white over nothing,
   * so body text would sit directly on the ambient gradient. It is unsupported
   * in fewer browsers than it used to be and still switched off by privacy and
   * low-power settings, which no user-agent string reports.
   */
  assert.match(
    css,
    /@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/,
    'no @supports fallback for a browser without backdrop-filter',
  );
  assert.match(
    css,
    /@media \(prefers-reduced-transparency: reduce\)/,
    'reduced transparency is an accessibility setting, not a preference to override',
  );

  // Both must actually turn the blur off rather than merely restyle the border.
  const reduced = /@media \(prefers-reduced-transparency: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  assert.match(reduced, /backdrop-filter:\s*none/, 'reduced transparency leaves the blur running');
});

test('a backdrop-filtered surface contains no fixed-position child', () => {
  /*
   * `backdrop-filter` makes an element a containing block for `position: fixed`,
   * so a fixed descendant positions against the card instead of the viewport. On
   * a sibling project this clipped a dialog's full-screen backdrop to the panel
   * that opened it, and the dialog was invisible below the fold while being
   * announced to a screen reader.
   *
   * Checked as a property of the stylesheet: the only fixed elements may be the
   * ambient layers on body, which are not inside anything.
   */
  const fixedSelectors: string[] = [];
  for (const m of cssCode.matchAll(/([^{}]+)\{([^{}]*position:\s*fixed[^{}]*)\}/g)) {
    for (const sel of m[1].split(',')) fixedSelectors.push(sel.trim());
  }
  assert.deepEqual(
    fixedSelectors.filter((s) => !/^body::(before|after)$/.test(s)),
    [],
    'a fixed element other than the ambient layers: check it is not inside a glass surface',
  );
});

test('a state modifier outranks the base colour it exists to override', () => {
  /*
   * The half that a "does this class exist" check cannot see.
   *
   * `.err-text` was defined, applied to three nodes, and visibly correct on two
   * of them: `.metric-row .k` is specificity 0,2,0 and a bare `.err-text` is
   * 0,1,0, so the LABEL of a severe price-impact row stayed muted grey while its
   * value went red. Measured on the running page at 180.16% impact. A modifier
   * that loses to the rule it is modifying is worse than an absent one, because
   * it reads as styled everywhere it happens to win.
   *
   * So: any colour modifier the JSX puts on a `.k` or `.v` must carry the
   * compound form. Derived from the JSX rather than listed, so a third tier
   * added later is covered without anyone remembering this test exists.
   */
  const needed = new Set<string>();
  for (const file of tsxFiles(root)) {
    for (const m of readFileSync(file, 'utf8').matchAll(/'((?:k|v)(?: mono)? [\w-]+)'/g)) {
      const parts = m[1].split(/\s+/);
      const base = parts[0];
      for (const mod of parts.slice(1)) {
        if (mod === 'mono') continue;
        needed.add(`${base}.${mod}`);
      }
    }
  }
  assert.ok(needed.size > 0, 'found no modified .k/.v classNames: the scan is not measuring');

  const missing = [...needed].filter(
    (pair) => !cssCode.includes(`.metric-row .${pair}`),
  );
  assert.deepEqual(
    missing,
    [],
    `modifiers that lose to .metric-row's own colour:\n  ${missing.map((p) => `.metric-row .${p}`).join('\n  ')}`,
  );
});
