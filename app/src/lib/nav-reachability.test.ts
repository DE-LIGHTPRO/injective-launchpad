/**
 * The primary destinations are reachable on a phone, and there is one list of them.
 *
 * TWO DEFECTS, BOTH MEASURED ON THE RUNNING APP AT 375px, both of which every existing
 * test passed over:
 *
 * 1. `@media (max-width: 720px) { .top-nav { display: none } }` was one line with nothing
 *    in its place. The phone header offered the brand, Create and Connect wallet, and the
 *    six destinations behind that nav were reachable only by scrolling to the footer -
 *    2800px down on the home page. `display: none` also removes a node from the
 *    accessibility tree, so a screen-reader user on a phone had no primary nav at all,
 *    not a hidden one.
 * 2. Every control still under the WCAG 2.5.8 floor was in that footer: eight nav links
 *    at 20.8px and the footer brand at 18px. So the smallest targets in the app were the
 *    ones a phone user had no alternative to.
 *
 * And the structural cause of the first one is worth its own assertion: the destinations
 * were three hand-written lists. Each copy is locally correct, nothing errors when they
 * disagree, and the one that drifts is whichever a change forgets.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PRIMARY_NAV, CREATE_NAV, FOOTER_NAV, isNavCurrent } from './navItems.ts';
import { maskComments } from './testing/maskComments.ts';

const SRC = join(import.meta.dirname, '..');
const css = readFileSync(join(SRC, 'app', 'globals.css'), 'utf8');
const layout = readFileSync(join(SRC, 'app', 'layout.tsx'), 'utf8');
const mobileNav = readFileSync(join(SRC, 'components', 'MobileNav.tsx'), 'utf8');

/*
 * Masked with the shared helper, not a local regex. Its own docblock records what a naive
 * `//` mask does to a line holding a URL, and a second copy here would be a second place
 * for that to be relearned.
 */
const code = maskComments;

/**
 * Every file that renders a `<nav>`, found rather than named.
 *
 * THIS USED TO BE TWO FILENAMES, `layout.tsx` and `MobileNav.tsx`, and moving the header
 * nav into its own component to mark the current page broke four assertions at once -
 * not because anything regressed, but because the guard was pointed at a location
 * instead of at the thing. A guard that has to be edited every time correct code moves
 * is one somebody eventually edits in the wrong direction.
 *
 * Keyed on the element, so a fourth navigation added anywhere under `src/` is measured
 * by default rather than by remembering. Comments are masked first: the prose in this
 * project quotes markup verbatim, so an unmasked scan reads an explanation as a nav.
 */
function navSources(): Array<{ rel: string; src: string }> {
  const out: Array<{ rel: string; src: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx$/.test(entry)) {
        const src = code(readFileSync(full, 'utf8'));
        if (/<nav[\s>]/.test(src)) out.push({ rel: relative(SRC, full), src });
      }
    }
  };
  walk(SRC);
  assert.ok(out.length >= 3, `only ${out.length} files render a nav: the scan is not measuring`);
  return out;
}

const NAV_SOURCES = navSources();

/** The one file rendering `<nav className="...name...">`, which must be exactly one. */
function navNamed(name: string): { rel: string; src: string } {
  const re = new RegExp(`<nav[^>]*className="[^"]*\\b${name}\\b`);
  const found = NAV_SOURCES.filter((f) => re.test(f.src));
  assert.equal(found.length, 1, `${name} is rendered in ${found.length} files: ${found.map((f) => f.rel).join(', ')}`);
  return found[0];
}

/** The body of the block whose opening brace is at `open`, braces matched. */
function braceMatched(open: number): string {
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`the block opened at ${open} is never closed`);
}

/** Every `@media` condition mentioning a coarse pointer, with its brace-matched body. */
function coarseBlocks(): string[] {
  const out: string[] = [];
  const re = /@media[^{]*\(\s*pointer\s*:\s*coarse\s*\)[^{]*\{/g;
  for (const m of css.matchAll(re)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          out.push(css.slice(open + 1, i));
          break;
        }
      }
    }
  }
  // A broken regex would pass every assertion below by finding nothing to contradict.
  assert.ok(out.length > 0, 'no coarse-pointer block found at all: the scan is not measuring');
  return out;
}

test('the phone menu is rendered, not merely written', () => {
  /*
   * Registration is not wiring. A component that exists, compiles, and has its own tests
   * is still not a fix until something mounts it, and that is the most repeated defect in
   * the projects this one borrows its rules from.
   */
  assert.match(code(layout), /import\s*\{\s*MobileNav\s*\}/, 'layout does not import MobileNav');
  assert.match(code(layout), /<MobileNav\s*\/>/, 'MobileNav is imported and never rendered');
});

test('the header nav and its replacement swap at the same width', () => {
  /*
   * The pair is the assertion, not either half. One breakpoint moved and the other left
   * alone gives a width with two navigations or - the shipped case - a width with none,
   * and neither throws anything a test could otherwise see.
   */
  const at = /@media\s*\(\s*max-width:\s*(\d+)px\s*\)\s*\{/g;
  let width: string | null = null;
  let body = '';
  for (const m of css.matchAll(at)) {
    const block = braceMatched(m.index + m[0].length - 1);
    if (!/\.top-nav\s*\{[^}]*display:\s*none/.test(block)) continue;
    width = m[1];
    body = block;
    break;
  }
  assert.ok(width, '.top-nav is not hidden at any max-width, so there is no breakpoint to match');

  /*
   * Asserted INSIDE that block's own braces. The first version matched from the `@media`
   * through `[\s\S]*?` to the first `.mobile-nav { display: ...`, and a mutation that
   * split the pair into two queries at 720px and 680px passed it: the lazy wildcard
   * simply ran on into the next block and found the declaration there. A guard whose
   * match can leave the region it is scoped to is not scoped to anything.
   */
  assert.match(
    body,
    /\.mobile-nav\s*\{\s*display:\s*(?!none)/,
    `.top-nav hides at ${width}px and .mobile-nav is not shown in that same block`,
  );

  // And it must be absent above the breakpoint, or both navigations render side by side.
  assert.match(
    css,
    /(^|\n)\.mobile-nav\s*\{\s*display:\s*none/,
    '.mobile-nav has no default of display:none, so it also renders beside the header nav',
  );
});

test('the three navigations read from one list', () => {
  /*
   * Asserted as the ABSENCE of a hand-written destination rather than the presence of a
   * `.map`, because a second hand-written copy beside a correct loop is exactly the state
   * this is meant to catch.
   *
   * The brand is excluded by its class, not by its href. Both logos link to `/`, which is
   * also the Launches destination, so matching on the href alone reported the two of them
   * as drift - a measurement that fails on correct markup is one somebody deletes. Create
   * is excluded the same way: its destination comes from `CREATE_NAV` and only its label
   * is local, because the header has a button's worth of room and the footer has a line.
   */
  const written = [...code(layout).matchAll(/<Link\s+href="(\/[^"]*)"([^>]*)>/g)]
    .filter((m) => !/className="(brand|nav-create)"/.test(m[2]))
    .map((m) => m[1]);
  const fromList = new Set(PRIMARY_NAV.map((i) => i.href));
  const strays = written.filter((h) => fromList.has(h));
  assert.deepEqual(
    strays,
    [],
    'these destinations are hand-written in the layout as well as declared in navItems',
  );

  // Asserted against whichever file renders each nav, so the three can live wherever
  // they need to - the header's moved out of the layout to get `usePathname`.
  assert.match(navNamed('top-nav').src, /PRIMARY_NAV\.map/, 'the header nav does not render PRIMARY_NAV');
  assert.match(navNamed('footer-nav').src, /FOOTER_NAV\.map/, 'the footer nav does not render FOOTER_NAV');
  assert.match(navNamed('mobile-nav-menu').src, /PRIMARY_NAV\.map/, 'the phone menu does not render PRIMARY_NAV');
});

test('every navigation says which page you are on, through one resolver', () => {
  /*
   * MEASURED ON THE RUNNING APP before this: on `/`, all six header links resolved to
   * `rgb(161,166,176)` on `rgba(0,0,0,0)` and not one carried `aria-current`. The page
   * the visitor was reading looked exactly like the five they were not, on every route,
   * and a screen reader was told there was no current destination at all.
   *
   * The phone menu had been marking it since the day it was written - with its own
   * inline `pathname === item.href`. So this is the shape of defect `navItems.ts` was
   * created for, one level down: the decision existed, in one of the copies, as an
   * expression rather than as a function. Both now call `isNavCurrent`, and a third nav
   * is caught by the loop rather than by review.
   */
  for (const name of ['top-nav', 'mobile-nav-menu']) {
    const { rel, src } = navNamed(name);
    assert.match(src, /aria-current=\{/, `${rel} never marks a current page`);
    assert.match(src, /isNavCurrent\(/, `${rel} decides the current page itself instead of calling isNavCurrent`);
  }

  // And the resolver itself, because the prefix half is the part that is easy to get
  // wrong in the direction nobody sees: `/` is a prefix of every path.
  assert.equal(isNavCurrent('/', '/'), true);
  assert.equal(isNavCurrent('/risks', '/'), false, 'Launches lights up on every page');
  assert.equal(isNavCurrent('/risks', '/risks'), true);
  assert.equal(isNavCurrent('/portfolio/inj1abc', '/portfolio'), true, 'a sub-route is not its own section');
  assert.equal(isNavCurrent('/portfolios', '/portfolio'), false, 'a longer name matched as a prefix');
  assert.equal(isNavCurrent(null, '/risks'), false);

  // The visible state and the announced one are the same attribute, so they cannot drift.
  assert.match(
    css,
    /\.top-nav a\[aria-current=['"]page['"]\]\s*\{/,
    'the header nav has no style for the current page, so the attribute is announced and invisible',
  );
});

test('the footer carries every primary destination, plus Create', () => {
  // The derivation, not the literal: appending Create instead of splicing it second would
  // move Risks off the end, which is a decision about what a visitor sees.
  for (const item of PRIMARY_NAV) {
    assert.ok(
      FOOTER_NAV.some((f) => f.href === item.href),
      `${item.href} is in the header nav and not in the footer`,
    );
  }
  assert.ok(FOOTER_NAV.includes(CREATE_NAV), 'the footer has lost the Create destination');
  assert.equal(FOOTER_NAV.length, PRIMARY_NAV.length + 1);
  assert.equal(FOOTER_NAV[FOOTER_NAV.length - 1].href, PRIMARY_NAV[PRIMARY_NAV.length - 1].href);
});

test('Risks is last and present everywhere, because that is the point of it', () => {
  // Somebody looking for what can go wrong should not have to go looking. Recorded here
  // so that reordering the list is a decision rather than an edit.
  assert.equal(PRIMARY_NAV[PRIMARY_NAV.length - 1].href, '/risks');
});

test('the footer nav meets the touch floor, which no class-based rule reached', () => {
  /*
   * These links carry no className of their own, and the coarse-pointer sizing in this
   * stylesheet is class-based, so none of it reached them: nine failures at 375px, all of
   * them here. The selector has to name the nav rather than the link, which is the shape
   * of fix a hand-maintained list of link classes will not suggest.
   */
  const blocks = coarseBlocks().join('\n');
  for (const sel of ['.footer-nav a', '.site-footer .brand']) {
    assert.ok(blocks.includes(sel), `${sel} is not sized for a coarse pointer`);
  }
  /*
   * READ OUT OF THIS RULE, not out of the joined blocks. Searching the whole coarse
   * region for `min-height: 24px` passed with the footer floor mutated to 20px, because
   * `button { min-height: 24px }` four selectors away satisfied it: the assertion was
   * measuring a different control's floor and reporting it as this one's. Found by
   * mutation, which is the only thing that could have found it.
   */
  const rule = /\.footer-nav a,\s*\.site-footer \.brand\s*\{([^}]*)\}/.exec(blocks);
  assert.ok(rule, 'the footer links and brand are not sized by one rule');
  const min = /min-height:\s*(\d+)px/.exec(rule[1]);
  assert.ok(min, 'the footer rule sets no minimum height');
  assert.ok(Number(min[1]) >= 24, `the footer floor is ${min[1]}px, under the WCAG 2.5.8 24px`);
});

test('the phone menu rows are sized unconditionally, not only on a coarse pointer', () => {
  /*
   * 44px, and outside the coarse block on purpose. This menu only exists below 720px,
   * where the pointer is a thumb in every case that matters, and a pointer media query
   * is a guess about hardware rather than a fact about it - a touchscreen laptop reports
   * `fine`. Sizing it unconditionally cannot be wrong, because nothing else is competing
   * for the width.
   */
  const rule = /\.mobile-nav-menu\s+a\s*\{([^}]*)\}/.exec(code(css));
  assert.ok(rule, 'there is no rule sizing the phone menu rows');
  const min = /min-height:\s*(\d+)px/.exec(rule[1]);
  assert.ok(min, 'the phone menu rows have no minimum height');
  assert.ok(Number(min[1]) >= 24, `phone menu rows are ${min[1]}px, under the 24px floor`);
});

test('a navigation added later has to say how its targets are sized', () => {
  /*
   * A tripwire rather than a measurement. The classes below are the navigations whose
   * target sizes have been measured on a device width; a fourth one added without being
   * named here fails this instead of shipping unexamined, which is how the footer nav
   * stayed 20.8px while the touch-target tests stayed green.
   */
  const known = new Set(['top-nav', 'footer-nav', 'mobile-nav-menu']);
  const found = new Set<string>();
  for (const { src } of NAV_SOURCES) {
    for (const m of src.matchAll(/<nav\s[^>]*className="([^"]+)"/g)) found.add(m[1].trim());
  }
  assert.ok(found.size >= 3, `only ${found.size} navs found: the scan is not measuring`);
  assert.deepEqual(
    [...found].filter((c) => !known.has(c)),
    [],
    'this navigation has no recorded touch-target measurement',
  );
});
