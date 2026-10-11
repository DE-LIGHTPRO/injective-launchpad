import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { launchPath, launchSlug, parseLaunchRef, resolveLaunchSlug } from './launchPath.ts';
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

test('a shared ticker carries the id, on both launches', () => {
  const board = [launch(1, 'INJINU'), launch(7, 'INJINU'), launch(2, 'VETTA')];
  assert.equal(launchPath(board[0], board), '/launch/INJINU-1');
  assert.equal(launchPath(board[1], board), '/launch/INJINU-7');
  // The uninvolved launch keeps the short form: a clash is between two tickers, not
  // a property of the board.
  assert.equal(launchPath(board[2], board), '/launch/VETTA');
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
   * is in the denom, which is why both clash and both carry an id.
   */
  const board = [launch(1, 'INJINU'), launch(2, 'injinu')];
  assert.equal(launchPath(board[0], board), '/launch/INJINU-1');
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

test('an ambiguous ticker resolves to nobody and lists the candidates', () => {
  const board = [launch(1, 'INJINU'), launch(7, 'INJINU')];
  const r = resolveLaunchSlug('INJINU', board);
  assert.equal(r.launch, null, 'picking one would send someone to the wrong token');
  assert.deepEqual(
    r.candidates.map((c) => c.id),
    [1, 7],
  );
});

test('the suffixed form picks one out of a clash', () => {
  const board = [launch(1, 'INJINU'), launch(7, 'INJINU')];
  assert.equal(resolveLaunchSlug('INJINU-7', board).launch?.id, 7);
  assert.equal(resolveLaunchSlug('INJINU-1', board).launch?.id, 1);
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
  assert.deepEqual(r.candidates, []);
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
