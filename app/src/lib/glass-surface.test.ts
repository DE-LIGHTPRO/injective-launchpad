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

test('the surface a glyph sits on is opaque, so contrast cannot vary with the backdrop', () => {
  /*
   * THIS TEST USED TO ASSERT A VALUE THAT HAD NOT RENDERED IN MONTHS.
   *
   * It read `--glass-fill` for a `rgba(…, 0.38)` dark floor under a white gradient,
   * and it passed - because its regex took the FIRST declaration, and `:root`
   * declared `--glass-fill` twice: the gradient, then `var(--surface-1)` fifty lines
   * down when glass was retired. Identical property, identical block, so only source
   * order decided, and the later one won. The suite was pinning the dead half of a
   * documented override, which is the one place a green test proves least.
   *
   * The underlying concern is real and outlives the mechanism. What made glass an
   * accessibility problem was that the colour under a glyph depended on whatever
   * happened to be behind that particular card: measured on one screen, the backdrop
   * under identical 11px text ran from rgb(24,44,52) to rgb(44,36,76), the same token
   * passing in one card and failing at 2.95:1 in the next. An alpha floor BOUNDED
   * that variance. An opaque fill REMOVES it, which is why the flat pass is the
   * stronger answer rather than a retreat from this check.
   *
   * So the claim is now the one that holds: resolve the winning declaration and
   * require it to be opaque. Translucency and gradients both fail, in either
   * direction, which is what the old test was reaching for.
   */
  const decls = [...css.matchAll(/^\s*--glass-fill:\s*([^;]*);/gm)].map((m) =>
    m[1].replace(/\s+/g, ' ').trim(),
  );
  assert.ok(decls.length > 0, '--glass-fill is not declared');
  assert.equal(
    decls.length,
    1,
    `--glass-fill is declared ${decls.length} times, so only source order decides it:\n  ${decls.join('\n  ')}`,
  );

  // Follow at most one alias hop, which is how the palette is built.
  const fill = decls[0];
  const alias = /^var\(\s*(--[\w-]+)\s*\)$/.exec(fill);
  const resolved = alias
    ? (new RegExp(`^\\s*${alias[1]}:\\s*([^;]*);`, 'm').exec(css)?.[1]?.trim() ?? '')
    : fill;
  assert.ok(resolved.length > 0, `${fill} resolves to nothing`);
  assert.match(
    resolved,
    /^#[0-9a-f]{6}$/i,
    `the fill under body text is "${resolved}", which is not an opaque colour: ` +
      'an alpha or a gradient makes contrast depend on what sits behind the card',
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

test('every design token a rule reads has a declaration behind it', () => {
  /*
   * The same defect as "a class applied with no rule behind it", one level down, and
   * it had four instances - one of which put the wrong colour on the chart.
   *
   * An undeclared `var(--x)` with no fallback is invalid at computed-value time. That
   * does not error, does not warn, and does not fall back to anything sensible: the
   * property takes its inherited value if it is an inherited property and its initial
   * value otherwise. So `background: var(--surface-sunken)` became `transparent` and
   * `color: var(--text-muted)` became the parent's colour. Measured on the running
   * page, the segmented control's track was rgba(0,0,0,0) and its inactive tab was
   * rgb(236,236,239) - the same colour as the active one. Both halves looked like a
   * design decision.
   *
   * `var(--line-soft, var(--glass-border))` is the version that is hardest to catch,
   * because the fallback made the screen correct while the first name had never
   * existed. Reads with a fallback are therefore exempt here and have to be found by
   * reading, not by measuring.
   */
  const declared = new Set(
    [...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]),
  );
  // Set in TSX rather than in the stylesheet: next/font's `variable`, and the inline
  // custom properties a component computes per instance.
  for (const file of tsxFiles(root)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/variable:\s*'(--[\w-]+)'/g)) declared.add(m[1]);
    for (const m of src.matchAll(/'(--[\w-]+)'\s*:/g)) declared.add(m[1]);
  }

  const readNoFallback = new Map<string, string>();
  const readAnywhere = new Set<string>();
  const sources: [string, string][] = [['app/globals.css', css]];
  for (const file of tsxFiles(root)) sources.push([file.slice(root.length), readFileSync(file, 'utf8')]);
  for (const [where, src] of sources) {
    // Comments are prose: this file's own notes name the tokens they are about.
    const code = where.endsWith('.css') ? cssCode : src;
    for (const m of code.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
      readAnywhere.add(m[1]);
      if (m[2] === ')' && !readNoFallback.has(m[1])) readNoFallback.set(m[1], where);
    }
  }

  // A broken regex on either side passes this test by finding nothing.
  assert.ok(declared.size > 30, `only ${declared.size} tokens found declared: the scan is not measuring`);
  assert.ok(readNoFallback.size > 30, `only ${readNoFallback.size} unguarded reads found: the scan is not measuring`);

  const phantom = [...readNoFallback].filter(([name]) => !declared.has(name));
  assert.deepEqual(
    phantom.map(([name, where]) => `${name} (read in ${where})`),
    [],
    'tokens read with no fallback and never declared: these resolve to inherited or initial, silently',
  );

  /*
   * And the other direction, which is how the chart got a black price tag.
   *
   * `--on-ticker` was declared with a comment recording the measurement behind it -
   * dark rather than white because white on the green fill is 2.4:1 and fails - and
   * nothing read it. The one element that needed it asked for `--on-accent`, so the
   * tag rendered in the initial `black` instead: close enough to the intended
   * #0a0d12 that no screenshot would show it, and the recorded measurement never
   * reached the screen. A token and its only reader had different names and each
   * half looked complete.
   */
  const unread = [...declared].filter(
    (name) => !readAnywhere.has(name) && !/^--font-/.test(name),
  );
  assert.deepEqual(
    unread,
    [],
    'tokens declared and read by nothing: either a reader names it differently, or it is a lever that moves nothing',
  );
});

test('a radius that has a step on the scale is written as that step', () => {
  /*
   * The scale was documented and unenforced, and it drifted exactly the way rule 25
   * describes for colour: `--radius-lg` was 14px while FIVE panels restated a `12px`
   * literal over it, so the token named a value most of its own surface had stopped
   * using. On the home page that left nine panels of identical 1032px width and
   * identical hairline alternating 12 and 14 down one column - one decision that reached
   * under half of what it applied to, and invisible to review because each rule is
   * locally plausible.
   *
   * This asserts the cheap half, which is the half that drifts: a literal that EQUALS a
   * declared step is always a mistake, because it restates a value the token already
   * owns and silently stops tracking it. Compared in pixels, since the scale is written
   * in px and the spacing scale next door is written in rem - a string compare there
   * reports every literal off-scale and proves nothing.
   *
   * Values with no step (8px on controls, 2px on the progress bars) are NOT failures
   * here. Naming them means either renaming two tokens across thirty call sites or
   * collapsing three control radii into one, and both are design decisions; the radius
   * block carries the measurement so the next person decides with it rather than
   * guessing. A guard that failed on them would be a guard someone deletes.
   */
  const px = (v: string): number | null => {
    const m = /^(-?[\d.]+)(px|rem)$/.exec(v.trim());
    if (!m) return null;
    return m[2] === 'rem' ? parseFloat(m[1]) * 16 : parseFloat(m[1]);
  };

  const steps = new Map<number, string>();
  for (const m of cssCode.matchAll(/^\s*(--radius-[\w-]+):\s*([^;]+);/gm)) {
    const p = px(m[2]);
    if (p !== null) steps.set(p, m[1]);
  }
  // A broken regex here would pass this test by finding no steps to compare against.
  assert.ok(steps.size >= 4, `only ${steps.size} radius steps found: the scan is not measuring`);

  const lines = css
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n');
  const restated: string[] = [];
  let seen = 0;
  for (let i = 0; i < lines.length; i += 1) {
    for (const m of lines[i].matchAll(/\bborder(?:-[a-z]+)*-radius\s*:\s*([^;}]+)/g)) {
      for (const token of m[1].trim().split(/\s+/)) {
        if (token.includes('(')) continue;
        const p = px(token);
        if (p === null || p === 0) continue;
        seen += 1;
        const step = steps.get(Math.abs(p));
        if (step) restated.push(`${token} is ${step} (line ${i + 1}: ${lines[i].trim().slice(0, 72)})`);
      }
    }
  }
  assert.ok(seen > 0, 'no literal radii found at all: the scan is not measuring');

  assert.deepEqual(
    restated,
    [],
    'these radii equal a declared step and are written as a literal, so the token no longer controls them',
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
