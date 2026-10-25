/**
 * The arithmetic that turns an opening market cap into `virtual_quote_whole`, and back.
 *
 * WHY IT IS A MODULE NOW. `derive-curve-scale.mjs` had it, and `deploy.mjs` needs the
 * INVERSE: given the constant an operator configured and today's price, what opening
 * cap would launches actually get? A second copy of three lines of arithmetic is two
 * answers to one question, and the whole point of the check is that the two agree.
 *
 * THE PRICE STILL BELONGS NOWHERE NEAR THE PRODUCT. `derive-curve-scale.mjs` says why
 * and the reason is unchanged: a curve that scales with a live price gives two launches
 * created an hour apart different shapes, which destroys the comparability the board is
 * built on, and puts an oracle in the path of a contract holding funds. Nothing here
 * changes that. A price is read at DEPLOY time, once, and fixes a constant that every
 * launch then shares until an admin changes it - which is the same property the script
 * has always had, not a new one.
 */

/*
 * The token side of the curve, which never scales with the quote. Mirrors
 * `CURVE_VIRTUAL_TOKENS` and `FIXED_TOTAL_SUPPLY` in the factory; if either moves,
 * this is wrong and the opening cap it reports is not the one a launch would get.
 */
export const VIRTUAL_TOKENS = 1_073_000_000;
export const TOTAL_SUPPLY = 1_000_000_000;
export const CURVE_SUPPLY = 800_000_000;
/** Graduation as a fraction of the opening reserve: `GRADUATION_NUM / DEN`. */
export const GRAD_NUM = 17;
export const GRAD_DEN = 6;

/**
 * The constant that opens a launch at `targetUsd`, at this price.
 *
 *   Opening market cap = opening spot x total supply
 *                      = (virtual_quote / virtual_tokens) x total supply
 *   so virtual_quote   = cap x virtual_tokens / total supply.
 */
export function virtualQuoteFor(targetUsd, price) {
  const capInQuote = targetUsd / price;
  return Math.round((capInQuote * VIRTUAL_TOKENS) / TOTAL_SUPPLY);
}

/** What a configured constant actually opens at, in dollars, at this price. */
export function openingCapUsd(whole, price) {
  return (whole * TOTAL_SUPPLY * price) / VIRTUAL_TOKENS;
}

/**
 * How far a configured constant has drifted from its intended cap, as a fraction.
 *
 * Signed, so a caller can say which direction without recomputing: positive means
 * launches would open ABOVE the target, which is what happens when the quote asset has
 * risen since the constant was chosen.
 */
export function driftFrom(targetUsd, whole, price) {
  return (openingCapUsd(whole, price) - targetUsd) / targetUsd;
}

/**
 * How far is too far.
 *
 * NOT A PRECISION THRESHOLD - the constant is a judgement about what a launch should
 * cost to enter, and a few percent either way is noise against that judgement. It is
 * set where a reader would notice: at 15%, a $5,000 target opening at $5,750 is a
 * different product decision than the one somebody wrote down, and below it nothing is.
 *
 * Deliberately loose rather than tight, because the cost of the two mistakes is not
 * symmetrical. Too tight stops a legitimate deployment over market noise, at the moment
 * when stopping is most expensive and a human is most likely to override the check
 * rather than understand it. Too loose ships a cap nobody chose, which an admin can
 * repoint afterwards with `SetQuote`.
 */
export const MAX_DRIFT = 0.15;

/**
 * What the quote asset is worth in dollars, read from two venues.
 *
 * TWO VENUES, AND THEY MUST AGREE. A single source that is stale or wrong produces a
 * confident number with no way to tell; two that disagree by more than a little is
 * itself the finding, so this throws rather than picking one. One venue answering is
 * returned with `provisional` set, because "only Binance replied" is a different claim
 * from "both agreed" and a caller should be able to say which it had.
 *
 * Throws rather than exiting, so the two callers can differ: the derive script stops,
 * and `deploy.mjs` carries on without a staleness check rather than letting an
 * unreachable price API block a deployment that is otherwise ready.
 */
export async function readQuotePrice(symbol) {
  if (['USDC', 'USDT', 'USD', 'DAI'].includes(symbol)) {
    return { price: 1, reads: [{ venue: 'assumed', price: 1 }], provisional: false, assumed: true };
  }
  const reads = [];
  try {
    const r = await fetch(`https://api.coinbase.com/v2/exchange-rates?currency=${symbol}`, {
      signal: AbortSignal.timeout(15_000),
    }).then((x) => x.json());
    const v = Number(r?.data?.rates?.USD);
    if (Number.isFinite(v) && v > 0) reads.push({ venue: 'Coinbase', price: v });
  } catch {
    /* one venue being unreachable is not the answer */
  }
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`, {
      signal: AbortSignal.timeout(15_000),
    }).then((x) => x.json());
    const v = Number(r?.price);
    if (Number.isFinite(v) && v > 0) reads.push({ venue: 'Binance', price: v });
  } catch {
    /* ditto */
  }
  if (reads.length === 0) throw new Error(`no venue priced ${symbol}`);
  if (reads.length === 2) {
    const [a, b] = reads.map((r) => r.price);
    const spread = Math.abs(a - b) / Math.min(a, b);
    if (spread > 0.02) {
      throw new Error(`the two venues disagree by ${(spread * 100).toFixed(1)}%`);
    }
  }
  return {
    price: reads.reduce((s, r) => s + r.price, 0) / reads.length,
    reads,
    provisional: reads.length < 2,
    assumed: false,
  };
}
