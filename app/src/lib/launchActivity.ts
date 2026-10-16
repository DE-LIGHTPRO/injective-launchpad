import { getLcdUrl, NETWORK } from './config.ts';
import { isDemoMode } from './demo.ts';
import { listTrades, currentHeight, type Trade } from './chain.ts';
import { buildSeries } from './priceSeries.ts';

/**
 * How busy a launch is, from what this chain will actually answer.
 *
 * Injective's tx search returns a `total` at the top level of the response, and it
 * accepts both `wasm.action='buy'` and `tx.height>N`, so a trade count is one request
 * that need fetch no transactions.
 *
 * THE PARAMETER IS `limit`, NOT `pagination.limit`, AND THE TWO ENDPOINTS DISAGREE.
 * `/cosmos/tx/v1beta1/txs` honours a top-level `limit` and silently IGNORES
 * `pagination.limit`; `/cosmos/bank/v1beta1/balances` is the exact opposite, honouring
 * `pagination.limit` and ignoring `limit`. Both measured against live mainnet and
 * testnet on 16 Oct 2026. Neither rejects the wrong one, so the request succeeds, the
 * `total` is correct, and the only symptom is the page size falling back to the default
 * of 100 full transaction bodies.
 *
 * On one live mainnet window that was 1,986,123 bytes against 6,752 - 294 times the
 * payload - for a request whose entire purpose is to read one integer. It was wrong
 * here for every count this board has ever taken, twice per launch per render, and it
 * grows with each launch's trade count: a new launch with three trades costs nothing,
 * so the defect arrives exactly when the product starts working.
 *
 * This comment used to claim the opposite, with evidence:
 *
 *     ?query=… AND wasm.action='buy'&pagination.limit=1
 *     -> { "txs": [], "tx_responses": [], "total": "1" }
 *
 * `total: "1"` is the tell. An ignored limit and an honoured one are indistinguishable
 * when there is only one result, and every testnet query this was checked against had
 * one or none. A measurement that cannot fail is not a measurement - re-check a limit
 * against a query whose total EXCEEDS it.
 *
 * HOLDERS ARE STILL ABSENT and that is not a gap this file can close.
 * `/cosmos/bank/v1beta1/denom_owners/<denom>` answers `code 12, Not Implemented` with
 * HTTP 501 on Injective, measured 10 Oct 2026. The tempting workaround is to derive it
 * from trade history, and it would be WRONG: a tokenfactory denom is a bank denom and
 * a bank send runs no contract code, so every transfer that happens off the curve is
 * invisible here. A number built that way would drift further from the truth the more
 * the token actually changed hands, which is the opposite of what a holder count is
 * for. nearly.trade shows holders because NEAR gives them to it; this chain does not.
 *
 * What the trade history DOES support honestly is unique traders, which is a different
 * claim and is labelled as one.
 */

export interface LaunchActivity {
  /** Executed buys, lifetime. */
  buys: number;
  /** Executed sells, lifetime. */
  sells: number;
  /** Both, which is the figure a card shows. */
  trades: number;
}

/**
 * A count-only tx search: one transaction body instead of a hundred, just for `total`.
 *
 * `limit`, never `pagination.limit` - see the header. The wrong one is not an error,
 * it is a 294x payload with the right answer in it.
 */
async function countTxs(query: string): Promise<number> {
  const url = `${getLcdUrl()}/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(
    query,
  )}&limit=1`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`tx search ${res.status}`);
  const body = (await res.json()) as { total?: unknown };
  /*
   * The total arrives as a STRING, and `Number(undefined)` is NaN rather than a
   * throw, so an endpoint that stops returning it would otherwise put NaN on a card.
   * Anything unparseable is refused here instead.
   */
  const n = Number(body?.total);
  if (!Number.isFinite(n) || n < 0) throw new Error('tx search returned no usable total');
  return n;
}

/**
 * Trade counts for one launch: two count-only requests, no transaction bodies.
 *
 * Buys and sells are counted separately rather than by subtracting the launch's other
 * transactions from a total. A launch's contract also sees `claim_fees` and
 * `graduate`, so "everything that touched this contract" is not a trade count, and the
 * difference grows every time somebody claims.
 */
export async function activityFor(curve: string): Promise<LaunchActivity> {
  if (isDemoMode()) {
    // Deterministic from the address, so the demo board does not reshuffle on every
    // render while still differing between cards.
    const seed = [...curve].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
    const buys = seed % 140;
    // `>>>`, not `>>`: the seed is unsigned, and a signed shift of one above 2^31 went
    // negative, which put "-16 trades" on a demo card.
    const sells = (seed >>> 7) % 60;
    return { buys, sells, trades: buys + sells };
  }
  const base = `wasm._contract_address='${curve}'`;
  const [buys, sells] = await Promise.all([
    countTxs(`${base} AND wasm.action='buy'`),
    countTxs(`${base} AND wasm.action='sell'`),
  ]);
  return { buys, sells, trades: buys + sells };
}

/**
 * Counts for several launches at once.
 *
 * `null` for a launch whose count could not be read, never zero. Zero is a real and
 * common answer on a new board, so a failed read rendering as "0 trades" would be
 * indistinguishable from a launch nobody has touched, and the quiet version is the
 * one that misleads.
 */
export async function activityForAll(
  curves: string[],
): Promise<Record<string, LaunchActivity | null>> {
  const results = await Promise.allSettled(curves.map((c) => activityFor(c)));
  const out: Record<string, LaunchActivity | null> = {};
  curves.forEach((c, i) => {
    const r = results[i];
    out[c] = r.status === 'fulfilled' ? r.value : null;
  });
  return out;
}

/**
 * Distinct addresses that have traded on this curve.
 *
 * NOT HOLDERS, and the distinction is the whole point of the name. Someone who bought
 * and sold out is counted here and holds nothing; someone who received tokens in a
 * bank send never appears. It answers "how many people have traded this", which is a
 * real question and one this chain can actually answer, rather than approximating a
 * question it cannot.
 */
export function uniqueTraders(trades: Trade[]): number {
  const seen = new Set<string>();
  for (const t of trades) {
    if (t.who) seen.add(t.who);
  }
  return seen.size;
}

/**
 * Quote traded within `blocks` of the current height.
 *
 * Returns `null` rather than zero when the current height is unknown: without it there
 * is no window, and an unwindowed sum labelled "24h" is a different number wearing the
 * right label.
 *
 * Bounded by whatever `trades` was fetched with, so it UNDERSTATES a busy launch. The
 * caller must say so; `volumeIsPartial` below is how, and `LaunchEnrichment` carries the
 * answer as `volumePartial`. (This line named `volumeLabel`, which does not exist. A
 * pointer at nothing reads as a pointer at something until somebody greps.)
 */
export function volumeWithin(
  trades: Trade[],
  currentHeight: number | null,
  blocks: number,
): bigint | null {
  if (currentHeight === null) return null;
  const floor = currentHeight - blocks;
  let total = 0n;
  for (const t of trades) {
    if (t.height < floor) continue;
    total += quoteOf(t) ?? 0n;
  }
  return total;
}

/** Quote that moved in a trade, or null for anything that is not one. */
function quoteOf(t: Trade): bigint | null {
  const q = t.kind === 'buy' ? t.injIn : t.kind === 'sell' ? t.injOut : null;
  return q !== null && q > 0n ? q : null;
}

/**
 * Effective fill prices, oldest first, for a sparkline.
 *
 * DELEGATES to `priceSeries.ts`, which already owned this and owned it better: its
 * `fillPrice` takes the quote's decimals, which this did not, and that is about to
 * matter when a launch can be quoted in something other than an 18-decimal INJ.
 *
 * I wrote a second copy here before looking, which is the two-sources-for-one-fact
 * defect this project keeps finding, committed while adding a feature to find it. The
 * duplicate is gone rather than left to drift.
 */
export function priceSeries(trades: Trade[], quoteDecimals = 18): number[] {
  return buildSeries(trades, quoteDecimals).points.map((p) => p.price);
}

/**
 * Blocks in a 24 hour window on Injective.
 *
 * An APPROXIMATION from a ~0.65s target block time, and the copy that uses it says
 * "about". Block time varies, and presenting a derived window as an exact day is the
 * kind of false precision this project removes elsewhere.
 */
export const BLOCKS_PER_DAY = Math.round((24 * 60 * 60) / 0.65);

/**
 * Whether a windowed volume figure is complete.
 *
 * `trades` was fetched with a limit. If the oldest trade returned is still inside the
 * window, there may be more beyond the page and the sum is a floor rather than a
 * total. Saying "at least" is the honest form; printing it bare is not.
 */
export function volumeIsPartial(
  trades: Trade[],
  fetchedLimit: number,
  currentHeight: number | null,
  blocks: number,
): boolean {
  if (currentHeight === null) return false;
  if (trades.length < fetchedLimit) return false;
  const oldest = trades[trades.length - 1];
  return oldest !== undefined && oldest.height >= currentHeight - blocks;
}

/**
 * Quote traded in the window, derived from the lifetime count when the page is gone.
 *
 * A LAUNCH WITH A MEASURED ZERO TRADES HAS A KNOWN VOLUME, AND THE BOARD CALLED IT
 * UNKNOWN. `volume24h` was `trades === null ? null : volumeWithin(...)`, so a curve
 * whose trade page the answering node had pruned showed a dim dot under "Vol 24h"
 * beside a confident `0` under "Trades" - and the note below the table says a dot means
 * the figure could not be read. It had been read. Measured on the live testnet board,
 * on both INJ launches at once.
 *
 * THE INFERENCE IS SOUND BECAUSE THE TX INDEX OUTLIVES BLOCK RETENTION, which is the
 * one thing that had to be established before deriving anything. Measured against
 * `testnet.sentry.lcd.injective.network` on 16 Oct 2026, at height 144064392 with the
 * node's lowest retained height 143964505 - a window of 99,887 blocks, about 14 hours,
 * so the 24h window reaches past it and a count that stopped at the retention edge
 * would not be enough:
 *
 *   - `inj19y7…`, counting buys, answered `height 143412910 is not available`. The
 *     index FOUND a matching tx 550k blocks below retention and failed only on the
 *     block fetch, so index entries are not pruned with their blocks.
 *   - `inj1k2m8aa…` answered `total 0` for buys while its unfiltered page 500'd at
 *     height 143426568. The index holds that curve's entries from launch; no buy entry
 *     exists anywhere in its life.
 *
 * So `trades === 0` from the counts means never traded, not never read, and a launch
 * that has never traded moved zero quote in any window. That makes this a DERIVATION,
 * not an estimate - rule: a figure is measured or unknown, and a zero implied by a
 * measured zero is measured.
 *
 * It is also the more stable of the two reads. Retention is per answering node, so the
 * same page request succeeds and 500s from one minute to the next behind one hostname;
 * the count does not depend on a block being there.
 */
export function volumeIn(
  activity: LaunchActivity | null,
  trades: Trade[] | null,
  currentHeight: number | null,
  blocks: number,
): bigint | null {
  if (activity !== null && activity.trades === 0) return 0n;
  if (trades === null) return null;
  return volumeWithin(trades, currentHeight, blocks);
}

/**
 * Trades inside a block window.
 *
 * Returns 0 rather than null for an unknown height, and that is a deliberate
 * difference from `volumeWithin`. Volume is a figure shown to a reader, where zero
 * and unmeasured must not look alike. This feeds a RANKING, where the only sensible
 * place for a launch we could not measure is the bottom, and that is what 0 does.
 */
export function countWithin(trades: Trade[], currentHeight: number | null, blocks: number): number {
  if (currentHeight === null) return 0;
  const floor = currentHeight - blocks;
  return trades.filter(
    (t) => t.height >= floor && (t.kind === 'buy' || t.kind === 'sell'),
  ).length;
}

/**
 * Compact trade count: 1,871 reads better than 1871 in a dense column.
 *
 * NULL FOR AN UNKNOWN COUNT, never a string, and that return type is the whole point.
 * This used to answer `'trades unavailable'`, which is a sentence, and its one caller
 * is a numeric cell in the board - so the cell wrote
 * `tradesLabel(e.activity).replace(' trades', '')` to get the number back out. Three
 * things were wrong with that at once:
 *
 *   - The board renders an unmeasured VOLUME as a dim `·`, so the same unknown state
 *     appeared two ways in adjacent columns, and the note under the table saying "a dot
 *     in those columns means the figure could not be read" was untrue of half the rows.
 *   - `' trades'` carries a leading space, so the SINGULAR escaped the strip and a
 *     launch with one trade rendered `1 trade` among bare numbers.
 *   - A caller that has to string-strip its own helper is reading a label built for a
 *     different surface. There is no other surface: this is the only consumer.
 *
 * So the unknown is returned as a value the caller renders, rather than as prose the
 * caller edits. `null` is what the board already branches on for volume.
 *
 * `undefined` is accepted even though the type said it could not happen, and it did:
 * changing this record's value shape while the dev server was running left the old
 * shape in React state, so `.activity` read undefined and this threw straight into
 * the error boundary, blanking the board.
 *
 * That particular cause was a hot-reload artifact and cannot occur in production. The
 * reason to handle it anyway is the blast radius: the whole launch grid is inside one
 * boundary, so a label helper throwing takes the page down. A function whose entire job
 * is to turn a value into a short string should never be the thing that does that.
 */
export function tradesLabel(a: LaunchActivity | null | undefined): string | null {
  if (a === null || a === undefined) return null;
  return a.trades.toLocaleString('en-US');
}

export const QUOTE_SYMBOL = NETWORK.quoteSymbol;

/** How many trades one enrichment pass reads. Bounds both the series and the sum. */
export const ENRICH_TRADE_LIMIT = 40;

export interface LaunchEnrichment {
  activity: LaunchActivity | null;
  /** Quote traded in about 24h, or null when unknown. */
  volume24h: bigint | null;
  /** True when the sum is a floor rather than a total. */
  volumePartial: boolean;
  /**
   * Trades inside the same window the volume covers.
   *
   * A COUNT, which is the only activity measure comparable ACROSS pairs: volume is
   * denominated in each launch's quote, so ranking an INJ launch against a USDC one
   * by volume ranks amounts of different assets. A trade is a trade in any pair.
   *
   * Counted from the page of trades already fetched, so it costs nothing, and it is
   * bounded by that page the same way the volume is.
   */
  trades24h: number;
  /** Effective prices from real fills, oldest first. Empty when nothing has traded. */
  series: number[];
  traders: number;
}

/**
 * Everything the board shows about a launch's activity, in one pass.
 *
 * THREE REQUESTS PER LAUNCH, AND THAT IS THE DESIGN CONSTRAINT. Two count-only tx
 * searches for the lifetime trade total, and one page of trades that serves the
 * sparkline, the 24h sum and the trader count together. Fetching trades twice, once
 * for the chart and once for volume, would have been the obvious shape and would have
 * doubled the cost of the page's main surface for no new information.
 *
 * There is no indexer behind this, so the board is N-heavy by construction. The
 * mitigation is that this runs AFTER the board paints, and that `Promise.allSettled`
 * means one unreachable curve costs that card its numbers rather than the page its
 * content.
 *
 * A FAILED TRADE READ IS `null`, NOT AN EMPTY PAGE, and for a while it was the empty
 * page. `listTrades` was caught into `[]`, which every helper below then treated as a
 * launch that has genuinely never traded - so a curve whose history the answering node
 * had pruned rendered `Vol 24h 0.00` beside `trades unavailable`, in adjacent columns
 * of one row. Measured on the live testnet board, on both E2EUSD launches at once.
 *
 * The helpers were not the problem. `volumeWithin` returns null rather than zero for
 * an unknown height and says in its own comment that zero and unmeasured must not look
 * alike; `LaunchList` renders null as a dim placeholder. Both halves were right and
 * this line had already thrown the distinction away before either ran.
 *
 * `loadTradeView` - the launch page, reading the same endpoint through the same
 * module - got this right from the start, returning `kind: 'error'` because "the node
 * was unreachable is not evidence about whether it traded". One branch of one product
 * held the principle the other branch dropped.
 */
export async function enrichLaunch(
  curve: string,
  height: number | null,
): Promise<LaunchEnrichment> {
  const [act, trades] = await Promise.all([
    activityFor(curve).catch(() => null),
    listTrades(curve, ENRICH_TRADE_LIMIT).catch(() => null),
  ]);
  return {
    activity: act,
    volume24h: volumeIn(act, trades, height, BLOCKS_PER_DAY),
    /*
     * Not partial, because "at least N" is a claim about a figure we have. With no
     * figure there is nothing to qualify, and the volume is null anyway. A zero derived
     * from a measured zero is not partial either: there is nothing it could understate.
     */
    volumePartial: trades === null ? false : volumeIsPartial(trades, ENRICH_TRADE_LIMIT, height, BLOCKS_PER_DAY),
    /*
     * Still 0 on failure, deliberately and for the reason `countWithin` already gives
     * for an unknown height: this feeds a RANKING, not a readout, and the only
     * sensible place for a launch nobody could measure is the bottom.
     */
    trades24h: trades === null ? 0 : countWithin(trades, height, BLOCKS_PER_DAY),
    series: trades === null ? [] : priceSeries(trades),
    traders: trades === null ? 0 : uniqueTraders(trades),
  };
}

/**
 * Enrich several launches.
 *
 * The height is read ONCE and shared. Reading it per launch would put each card's 24h
 * window at a slightly different instant, and two cards whose windows disagree is the
 * sort of quiet inconsistency that makes a visitor distrust every number on the page.
 */
export async function enrichAll(
  curves: string[],
): Promise<Record<string, LaunchEnrichment>> {
  const out: Record<string, LaunchEnrichment> = {};
  if (curves.length === 0) return out;
  const height = await currentHeight().catch(() => null);
  const results = await Promise.allSettled(curves.map((c) => enrichLaunch(c, height)));
  curves.forEach((c, i) => {
    const r = results[i];
    if (r.status === 'fulfilled') out[c] = r.value;
  });
  return out;
}
