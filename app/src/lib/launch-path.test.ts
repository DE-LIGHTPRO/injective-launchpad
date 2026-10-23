import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { launchPath, launchSlug, parseLaunchRef, resolveLaunchSlug } from './launchPath.ts';
import { maskComments } from './testing/maskComments.ts';
import { EMPTY_PROFILE } from './tokenProfile.ts';
import type { Launch } from './chain.ts';

/**
 * What a launch's URL is, and what it must never be.
 *
 * `/launch/1` was a row id on the address bar. The risk in replacing it is not the
 * pretty form, it is the resolution: a ticker is NOT unique on Injective, because a
 * denom is `factory/<creator>/<SUBDENOM>` and two creators may both pick `INJINU`.
 * Sending somebody to a different token than the one they were linked to is the worst
 * thing a launchpad can do with a URL, and it would look like it worked, so the
 * ambiguous cases are the ones worth most of the assertions here.
 *
 * THE RULE CHANGED, AND SO DID THREE TESTS IN THIS FILE. Audit F-17. A plain ticker
 * used to be taken away from both launches the moment a second one copied it, and
 * resolved to a chooser. The tests below now pin the opposite, because a plain link
 * can only ever have been minted while the ticker was unique and so can only ever
 * have meant the lowest id: letting a copy break it is griefing any creator can buy,
 * and the chooser offered two identical names and let the copy win half the clicks.
 * The reasoning is on `launchPath.ts` in full. Noting it here too because the three
 * tests that changed were not weak, they were correct about a policy that was wrong,
 * and a test that encodes a claim is only as good as the claim.
 */

const launch = (id: number, symbol: string, creator = `inj1creator${id}`): Launch => ({
  id,
  denom: `factory/${creator}/${symbol}`,
  creator,
  curve: `inj1curve${id}`,
  profile: EMPTY_PROFILE,
});

test('a unique ticker is the whole slug', () => {
  const board = [launch(1, 'INJINU'), launch(2, 'VETTA')];
  assert.equal(launchPath(board[0], board), '/launch/INJINU');
  assert.equal(launchPath(board[1], board), '/launch/VETTA');
});

test('a copied ticker suffixes the copy and leaves the original alone', () => {
  const board = [launch(1, 'INJINU'), launch(7, 'INJINU'), launch(2, 'VETTA')];
  assert.equal(
    launchPath(board[0], board),
    '/launch/INJINU',
    'the first launch keeps the link it has already been shared under',
  );
  assert.equal(launchPath(board[1], board), '/launch/INJINU-7');
  // The uninvolved launch keeps the short form: a clash is between two tickers, not
  // a property of the board.
  assert.equal(launchPath(board[2], board), '/launch/VETTA');
});

test('the original keeps its link however many copies arrive', () => {
  /*
   * The griefing case. One copy is an accident; five is somebody trying to take a
   * URL, and the answer has to be the same either way.
   */
  const board = [
    launch(4, 'INJINU'),
    launch(9, 'INJINU'),
    launch(11, 'INJINU'),
    launch(40, 'INJINU'),
  ];
  assert.equal(launchPath(board[0], board), '/launch/INJINU');
  assert.deepEqual(
    board.slice(1).map((l) => launchPath(l, board)),
    ['/launch/INJINU-9', '/launch/INJINU-11', '/launch/INJINU-40'],
  );
});

test('board order does not decide who is first; the id does', () => {
  // The contract pages ascending, but nothing here may depend on that.
  const board = [launch(40, 'INJINU'), launch(4, 'INJINU')];
  assert.equal(launchPath(board[1], board), '/launch/INJINU');
  assert.equal(launchPath(board[0], board), '/launch/INJINU-40');
  assert.equal(resolveLaunchSlug('INJINU', board).launch?.id, 4);
});

test('without the board the slug is always the unambiguous form', () => {
  /*
   * A caller that cannot see the other launches must not guess. The long form is
   * correct whatever exists, which makes "I do not know" produce a working link
   * rather than a plausible one.
   */
  assert.equal(launchSlug(launch(3, 'INJINU')), 'INJINU-3');
});

test('a clash is detected regardless of case, and the slug is the displayed ticker', () => {
  /*
   * `symbolOf` uppercases, so `injinu` and `INJINU` are ONE ticker as far as anything
   * a reader sees is concerned. The slug follows what is on screen rather than what
   * is in the denom, which is why the lowercase copy is displaced by the uppercase
   * original: a reader cannot tell the two denoms apart from the ticker, so neither
   * may the URL.
   */
  const board = [launch(1, 'INJINU'), launch(2, 'injinu')];
  assert.equal(launchPath(board[0], board), '/launch/INJINU');
  assert.equal(launchPath(board[1], board), '/launch/INJINU-2');
});

test('the numeric form still resolves, and redirects to the ticker', () => {
  const board = [launch(1, 'INJINU')];
  const r = resolveLaunchSlug('1', board);
  assert.equal(r.launch?.id, 1);
  assert.equal(r.canonical, 'INJINU', 'an old link must redirect, not serve a second URL');
});

test('the canonical slug reports null when it is already canonical', () => {
  const board = [launch(1, 'INJINU')];
  assert.equal(resolveLaunchSlug('INJINU', board).canonical, null);
});

test('a ticker in the wrong case resolves and redirects', () => {
  const board = [launch(1, 'INJINU')];
  const r = resolveLaunchSlug('injinu', board);
  assert.equal(r.launch?.id, 1);
  assert.equal(r.canonical, 'INJINU');
});

test('a copied ticker still resolves, to the launch the link has always named', () => {
  /*
   * The F-17 inversion. This asserted `launch === null` and a candidate list, which
   * meant a copy could break every link already shared for the original. A plain
   * ticker is only ever handed out while it is unique, so the lowest id is not a
   * guess at what the reader wanted: it is the only launch that URL has named.
   */
  const board = [launch(1, 'INJINU'), launch(7, 'INJINU')];
  const r = resolveLaunchSlug('INJINU', board);
  assert.equal(r.launch?.id, 1);
  assert.equal(r.canonical, null, 'the plain form IS canonical for the original');
  assert.deepEqual(
    r.sameTicker.map((c) => c.id),
    [7],
    'the page still has to say the ticker is not unique',
  );
});

test('the copy is told it is the copy, by whichever route reaches it', () => {
  /*
   * The warning has to travel with the launch rather than with the entry point: the
   * two URLs that land on a copy, its suffixed slug and its bare id, never pass
   * through the ambiguous plain name at all, and that reader is the one at risk.
   */
  const board = [launch(1, 'INJINU'), launch(7, 'INJINU')];
  for (const slug of ['INJINU-7', '7']) {
    const r = resolveLaunchSlug(slug, board);
    assert.equal(r.launch?.id, 7, slug);
    assert.deepEqual(
      r.sameTicker.map((c) => c.id),
      [1],
      slug,
    );
  }
});

test('an unshared ticker reports nobody else using it', () => {
  const board = [launch(1, 'INJINU'), launch(2, 'VETTA')];
  assert.deepEqual(resolveLaunchSlug('INJINU', board).sameTicker, []);
  assert.deepEqual(resolveLaunchSlug('2', board).sameTicker, []);
});

test("the copy's bare id redirects to the suffixed form, not to the plain one", () => {
  /*
   * `/launch/7` must not canonicalise to `/launch/INJINU`, which is launch 1. Two
   * launches claiming one canonical URL is how a copy inherits an audience.
   */
  const board = [launch(1, 'INJINU'), launch(7, 'INJINU')];
  assert.equal(resolveLaunchSlug('7', board).canonical, 'INJINU-7');
  assert.equal(resolveLaunchSlug('1', board).canonical, 'INJINU');
});

test('the suffixed form picks one out of a clash', () => {
  const board = [launch(1, 'INJINU'), launch(7, 'INJINU')];
  assert.equal(resolveLaunchSlug('INJINU-7', board).launch?.id, 7);
  /*
   * The original's own suffixed form keeps resolving, because links were shared
   * under it while the old rule was live. It redirects to the plain one rather than
   * serving a second URL.
   */
  const first = resolveLaunchSlug('INJINU-1', board);
  assert.equal(first.launch?.id, 1);
  assert.equal(first.canonical, 'INJINU');
});

test('a ticker that itself ends in a dash and digits wins its own name', () => {
  /*
   * `MEME-2024` is a legal subdenom AND looks exactly like `symbol-id`. The literal
   * ticker is tried first, so a token actually called that keeps its name rather
   * than being read as MEME number 2024.
   */
  const board = [launch(5, 'MEME-2024'), launch(2024, 'MEME')];
  assert.equal(resolveLaunchSlug('MEME-2024', board).launch?.id, 5);
  assert.equal(resolveLaunchSlug('MEME', board).launch?.id, 2024);
});

test('a suffix whose ticker disagrees with its id is a miss, never a swap', () => {
  /*
   * The dangerous near-miss. A stale link carrying the right number and a different
   * ticker must not quietly serve whatever is at that id: that is how somebody buys
   * the wrong token believing they followed a link to the right one.
   */
  const board = [launch(1, 'INJINU'), launch(7, 'VETTA')];
  assert.equal(resolveLaunchSlug('INJINU-7', board).launch, null);
});

test('an unknown ticker resolves to nothing rather than to the first launch', () => {
  const board = [launch(1, 'INJINU')];
  const r = resolveLaunchSlug('NOPE', board);
  assert.equal(r.launch, null);
  assert.deepEqual(r.sameTicker, []);
});

test('an empty or absent segment is refused', () => {
  assert.equal(parseLaunchRef(''), null);
  assert.equal(parseLaunchRef('   '), null);
  assert.equal(resolveLaunchSlug('', [launch(1, 'A')]).launch, null);
});

test('a percent-encoded ticker is decoded before it is matched', () => {
  const board = [launch(1, 'A.B')];
  assert.equal(resolveLaunchSlug('A%2EB', board).launch?.id, 1);
});

test('an id beyond safe integers is refused rather than rounded', () => {
  // `Number('9007199254740993')` silently becomes ...992, which would resolve to a
  // different launch than the one named.
  assert.equal(parseLaunchRef('9007199254740993'), null);
});

/**
 * The resolver can only tell the page the ticker is shared; the page has to say it.
 *
 * A source guard because the thing being protected is a sentence, and `sameTicker`
 * compiles and type-checks perfectly well while being destructured and ignored. That
 * is exactly how the old chooser's one real contribution would have been lost in
 * replacing it: resolving the plain link to the original is only safe if the reader
 * on either page is told the name is not an identity.
 */
test('the launch page warns when a ticker is shared, and no longer asks the reader to pick', () => {
  const src = maskComments(
    readFileSync(join(import.meta.dirname, '..', 'app/launch/[slug]/page.tsx'), 'utf8'),
  );
  assert.match(src, /sameTicker,\s*canonical\s*\}\s*=\s*resolveLaunchSlug/, 'must be read');
  assert.match(src, /\{sameTicker\.length > 0 && \(/, 'must be rendered, not just read');
  assert.match(src, /sameTicker\.map\(/, 'the other launches must be reachable from here');
  assert.match(
    src,
    /firstOfTicker\s*=\s*!sameTicker\.some\(\(o\) => o\.id < launch\.id\)/,
    'which one came first must come from the same list the links do',
  );
  assert.match(src, /This is not the first token called \$\{symbol\}/, 'the copy says so');
  assert.match(src, /Another token is also called \$\{symbol\}/, 'the original says so too');
  assert.match(
    src,
    /the name is not\s+an identity/,
    'the reason has to be on the screen, not only in the heading',
  );
  // The chooser, and the only sentence it had. Its return rendered a 200 with no
  // launch on it, which `notFound()` now handles as the 404 it always was.
  assert.ok(!/pick the one you meant/.test(src), 'the blind chooser must not come back');
  assert.ok(!/\bcandidates\b/.test(src), 'the old field name must not linger');
});

/**
 * No component may build a launch URL by hand.
 *
 * The short form is only safe when the whole board says the ticker is unique, so a
 * component holding a filtered list (the creator page, the watchlist, the ticker's
 * eight newest) cannot work it out. They read `path` off the row, which `toRow`
 * resolves once where the full list exists. This is a source guard because the
 * failure is a link that works, just not to the same place as the one next to it.
 */
test('nothing interpolates a launch URL', () => {
  const SRC = join(import.meta.dirname, '..');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || entry.endsWith('.test.ts')) continue;
      const rel = relative(SRC, full);
      // `launchPath.ts` is where the base path is allowed to be written.
      if (rel === 'lib/launchPath.ts') continue;
      const src = readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
      const re = /\/launch\/\$\{/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        offenders.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
  };
  walk(SRC);
  assert.deepEqual(
    offenders,
    [],
    `Use the row's \`path\`, or \`launchPath(launch, board)\`:\n  ${offenders.join('\n  ')}`,
  );
});
