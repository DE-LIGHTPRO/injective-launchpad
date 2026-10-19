import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { maskComments } from './testing/maskComments.ts';

/**
 * Two LCD endpoints take OPPOSITE page-size parameters, and neither rejects the wrong
 * one.
 *
 * Measured against live mainnet and testnet, 16 Oct 2026:
 *
 *   /cosmos/tx/v1beta1/txs            limit=1 -> 1 result     pagination.limit=1 -> 100
 *   /cosmos/bank/v1beta1/balances     limit=2 -> 100 results  pagination.limit=2 -> 2
 *
 * THE DEFECT THIS EXISTS FOR. `countTxs` in `launchActivity.ts` sent
 * `pagination.limit=1` to the tx endpoint. Its whole purpose is to read one integer -
 * the `total` - without downloading transactions, and it is run twice per launch on
 * every board render. The parameter was ignored, so every one of those requests pulled
 * the default page of 100 full transaction bodies: on one live mainnet window,
 * 1,986,123 bytes against 6,752, a factor of 294.
 *
 * WHY A SOURCE GUARD, AND WHY IT ASSERTS BOTH DIRECTIONS. Nothing observable goes
 * wrong. The request is a 200, the `total` is correct, the counts on the board are
 * right, and the cost scales with each launch's trade count - so it is free on a
 * testnet launch with three trades and expensive exactly when the product starts
 * working. There is no runtime check that could catch it and no unit test that would,
 * because the function returns the right number either way.
 *
 * The other direction matters just as much: `pagination.limit` is CORRECT on the bank
 * endpoint, so a later sweep that makes the two "consistent" would break balance
 * reading while fixing nothing. Both halves are pinned here.
 *
 * The original comment in `launchActivity.ts` claimed it had measured an empty page,
 * citing a response with `total: "1"`. That is the tell: with one result an ignored
 * limit and an honoured one look identical. A limit must be checked against a query
 * whose total EXCEEDS it.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** Every source file that could build an LCD URL. */
function sources(): string[] {
  const out: string[] = [];
  for (const rel of readdirSync(join(ROOT, 'app', 'src'), { recursive: true })) {
    const p = String(rel);
    if (/\.tsx?$/.test(p) && !p.endsWith('.test.ts')) out.push(join(ROOT, 'app', 'src', p));
  }
  for (const f of readdirSync(join(ROOT, 'scripts'))) {
    if (f.endsWith('.mjs')) out.push(join(ROOT, 'scripts', f));
  }
  return out;
}

/**
 * The query string that follows each occurrence of `path`, comment ranges blanked.
 *
 * Sliced to the end of the enclosing template literal, because these URLs interpolate
 * and wrap across lines - a line-based read would miss `&limit=1` sitting two lines
 * below the path it belongs to. Masking is not optional: `https://` begins with `//`,
 * and a naive comment mask erases the only lines worth reading, which is how an
 * earlier guard in this directory passed while the code under it was broken.
 */
function queryStringsFor(path: string): Array<{ file: string; query: string }> {
  const found: Array<{ file: string; query: string }> = [];
  for (const file of sources()) {
    const src = maskComments(readFileSync(file, 'utf8'));
    let at = src.indexOf(path);
    while (at !== -1) {
      const end = src.indexOf('`', at);
      found.push({
        file: file.slice(ROOT.length + 1),
        query: src.slice(at, end === -1 ? at + 400 : end),
      });
      at = src.indexOf(path, at + 1);
    }
  }
  return found;
}

/**
 * The tx SEARCH sites, told apart from the single-transaction FETCH.
 *
 * `/cosmos/tx/v1beta1/txs?query=...` is the search and takes `limit` and `order_by`.
 * `/cosmos/tx/v1beta1/txs/{hash}` is a fetch by hash and takes NEITHER - it addresses
 * one transaction, so there is no page to bound and no order to choose. The path of the
 * second is a prefix of the first, so a guard that matches the path alone reports the
 * poll in `txStatus.ts` as an unbounded ascending search, which is a false positive on
 * a correct file.
 *
 * Discriminated on the character AFTER the path rather than by filename: excluding a
 * file would exempt its next URL too. A `/` marks the by-hash read; anything else,
 * including a URL assembled from a variable, is treated as a search, so an unrecognised
 * shape is measured rather than waved through.
 */
function txSearchSites(): Array<{ file: string; query: string }> {
  const PATH = '/cosmos/tx/v1beta1/txs';
  return queryStringsFor(PATH).filter((s) => !s.query.startsWith(`${PATH}/`));
}

test('transaction search is bounded by `limit`, which is the parameter it honours', () => {
  const sites = txSearchSites();
  assert.ok(
    sites.length >= 2,
    `only ${sites.length} tx-search call sites found; this guard measures nothing if the endpoint moved behind a helper`,
  );
  for (const { file, query } of sites) {
    assert.doesNotMatch(
      query,
      /pagination\.limit/,
      `${file} bounds a tx search with pagination.limit, which this endpoint ignores: the count is right and the response is the full default page of 100 transactions`,
    );
    assert.match(
      query,
      /[?&]limit=/,
      `${file} sends an unbounded tx search, so it downloads the default page of 100 transaction bodies`,
    );
  }
});

test('transaction search asks for the NEWEST page, because the oldest is the pruned one', () => {
  /*
   * A SECOND PARAMETER WHOSE DEFAULT IS WRONG HERE, and wrong for the same reason the
   * one above is: nothing rejects it, the `total` is correct either way, and it fails
   * only once a launch has history.
   *
   * An unspecified `order_by` means ASCENDING, so `limit=1` asks the node to load the
   * OLDEST matching transaction. The tx index reaches further back than block
   * retention does (see `volumeIn`), so that is precisely the transaction the node
   * cannot fetch, and it answers `500 height N is not available, lowest height is M`.
   *
   * Measured on live mainnet, 18 Oct 2026, four contracts discovered from recent wasm
   * activity, four probes each: unspecified 4/16 and ORDER_BY_ASC 4/16 succeeded, with
   * identical heights and totals, against ORDER_BY_DESC 16/16. `countTxs` discards the
   * body it fetches, so the parameter costs nothing and buys the whole difference.
   *
   * Asserted across every call site rather than in `launchActivity.ts`, because the
   * other site had it right and a guard that reads one file does not cover the class.
   */
  const sites = txSearchSites();
  assert.ok(
    sites.length >= 2,
    `only ${sites.length} tx-search call sites found; this guard measures nothing if the endpoint moved behind a helper`,
  );
  for (const { file, query } of sites) {
    assert.match(
      query,
      /order_by=ORDER_BY_DESC/,
      `${file} leaves the tx-search order unspecified, which means ascending: it asks the node for the oldest matching transaction, and the index outlives block retention so that is the one it cannot fetch`,
    );
  }
});

test('bank balances are bounded by `pagination.limit`, which is the opposite', () => {
  /*
   * `by_denom` returns a single balance and needs no limit, so only the plural query
   * is measured. Asserting a limit on every bank URL would fail on a correct file.
   */
  const sites = queryStringsFor('/cosmos/bank/v1beta1/balances').filter(
    (s) => !s.query.includes('by_denom'),
  );
  assert.ok(
    sites.length >= 2,
    `only ${sites.length} multi-denom bank queries found; a vacuous half of this guard is worse than none`,
  );
  for (const { file, query } of sites) {
    assert.match(
      query,
      /pagination\.limit=/,
      `${file} reads every denom an account holds with no pagination.limit, so it stops at the default 100`,
    );
    assert.doesNotMatch(
      query,
      /[?&]limit=/,
      `${file} bounds a bank query with a bare limit, which this endpoint ignores - the two endpoints disagree and this is the one that wants pagination.limit`,
    );
  }
});
