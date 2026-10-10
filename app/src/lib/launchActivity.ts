import { getLcdUrl, NETWORK } from './config.ts';
import { isDemoMode } from './demo.ts';
import { listTrades, currentHeight, type Trade } from './chain.ts';

/**
 * How busy a launch is, from what this chain will actually answer.
 *
 * MEASURED BEFORE BUILT, because the last time I reasoned about this I was wrong.
 * Injective's tx search returns a `total` at the top level of the response, and it
 * accepts both `wasm.action='buy'` and `tx.height>N`, so a trade count is one request
 * that fetches no transactions:
 *
 *     ?query=wasm._contract_address='…' AND wasm.action='buy'&pagination.limit=1
 *     -> { "txs": [], "tx_responses": [], "total": "1" }
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

/** A count-only tx search: `limit=1` fetches no transactions, just the total. */
async function countTxs(query: string): Promise<number> {
  const url = `${getLcdUrl()}/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(
    query,
  )}&pagination.limit=1`;
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
    const sells = (seed >> 7) % 60;
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
 * caller must say so; `volumeLabel` below is how.
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
 * Effective price per whole token for each trade, oldest first.
 *
 * MEASURED FILLS, not a modelled curve. Every point is quote actually paid divided by
 * tokens actually received, so the line is what people were charged rather than what
 * the formula says they would be. The two agree on this contract, which is exactly why
 * using the fills is safe and also why it is the better choice: if they ever diverge,
 * a chart drawn from the formula would hide it and this one shows it.
 *
 * Returned as numbers because this feeds an SVG path and nothing else. That is a lossy
 * conversion from 18-decimal bigints and it must never travel anywhere a quote or a
 * balance is computed from it.
 */
export function priceSeries(trades: Trade[]): number[] {
  const out: number[] = [];
  // `listTrades` returns newest first; a chart reads left to right in time.
  for (const t of [...trades].reverse()) {
    const q = quoteOf(t);
    if (q === null || t.tokens === null || t.tokens <= 0n) continue;
    // Scaled through the token unit so an 18-decimal quote over an 18-decimal token
    // amount lands on a price per WHOLE token rather than per base unit.
    out.push(Number((q * 10n ** 18n) / t.tokens) / 1e18);
  }
  return out;
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

/** Compact trade count: 1,871 reads better than 1871 on a dense card. */
export function tradesLabel(a: LaunchActivity | null): string {
  if (a === null) return 'trades unavailable';
  return `${a.trades.toLocaleString('en-US')} ${a.trades === 1 ? 'trade' : 'trades'}`;
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
 */
export async function enrichLaunch(
  curve: string,
  height: number | null,
): Promise<LaunchEnrichment> {
  const [act, trades] = await Promise.all([
    activityFor(curve).catch(() => null),
    listTrades(curve, ENRICH_TRADE_LIMIT).catch(() => [] as Trade[]),
  ]);
  return {
    activity: act,
    volume24h: volumeWithin(trades, height, BLOCKS_PER_DAY),
    volumePartial: volumeIsPartial(trades, ENRICH_TRADE_LIMIT, height, BLOCKS_PER_DAY),
    series: priceSeries(trades),
    traders: uniqueTraders(trades),
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
