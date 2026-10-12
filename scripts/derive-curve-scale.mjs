/**
 * What `virtual_quote_whole` should be, for a target opening market cap.
 *
 *   node scripts/derive-curve-scale.mjs            # $5,000, measured against INJ now
 *   node scripts/derive-curve-scale.mjs 10000      # a different target
 *   node scripts/derive-curve-scale.mjs 5000 USDC  # for a dollar-denominated quote
 *   node scripts/derive-curve-scale.mjs 5000 INJ --price=7.92   # a price you trust
 *
 * WHY THIS IS A SCRIPT. The opening reserve is chosen so a launch opens at a
 * particular market cap in dollars, and the dollar figure is a PREMISE about one
 * day's INJ price, not a property of the constant. 676 was derived at INJ $7.92 on
 * 11 Oct 2026. On mainnet morning that premise has to be re-measured and the
 * constant re-derived, and doing that by hand is three lines of arithmetic nobody
 * should be doing under time pressure with real money on the other side.
 *
 * IT DOES NOT ADD A PRICE FEED TO THE PRODUCT, and that distinction matters. The app
 * has no oracle and must not get one: a curve that scales with a live price means
 * two launches created an hour apart have different shapes, which destroys the
 * comparability the whole board is built on, and puts an oracle in the path of a
 * contract holding funds. This reads a price ONCE, prints a number, and a human
 * decides whether to use it. That is the only place a price belongs here.
 *
 * It prints what the curve would then do: where it opens, where it graduates, and
 * what the price impact of a few buy sizes would be, because those are the figures
 * the number is actually chosen for.
 */

const TARGET_USD = Number(process.argv[2] ?? 5000);
const QUOTE = (process.argv[3] ?? 'INJ').toUpperCase();

if (!Number.isFinite(TARGET_USD) || TARGET_USD <= 0) {
  console.error(`\n  ✗ Not a target market cap: ${process.argv[2]}\n`);
  process.exit(1);
}

/*
 * The token side of the curve, which never scales with the quote. Mirrors
 * `CURVE_VIRTUAL_TOKENS` and `FIXED_TOTAL_SUPPLY` in the factory; if either moves,
 * this is wrong and the opening cap it reports is not the one a launch would get.
 */
const VIRTUAL_TOKENS = 1_073_000_000;
const TOTAL_SUPPLY = 1_000_000_000;
const CURVE_SUPPLY = 800_000_000;
/** Graduation as a fraction of the opening reserve: `GRADUATION_NUM / DEN`. */
const GRAD_NUM = 17;
const GRAD_DEN = 6;

/**
 * The quote's price in dollars.
 *
 * TWO VENUES, AND THEY MUST AGREE. A single source that is stale or wrong produces a
 * confident number with no way to tell; two that disagree by more than a little is
 * itself the finding, and the script refuses rather than picking one. A dollar
 * stablecoin is taken as a dollar, which is an assumption stated rather than a
 * measurement, and it is the right one for choosing a constant.
 */
async function priceUsd(symbol) {
  /*
   * AN OPERATOR'S OWN PRICE WINS, and this is not a convenience. Both venues were
   * unreachable from this machine while GitHub answered fine, which on launch
   * morning would mean the script refuses and the constant gets worked out by hand
   * under time pressure instead. A price somebody has checked and typed is better
   * than arithmetic done in a terminal, and it is stated as theirs in the output.
   */
  const override = process.argv.find((a) => a.startsWith('--price='));
  if (override) {
    const v = Number(override.slice('--price='.length));
    if (!Number.isFinite(v) || v <= 0) {
      console.error(`\n  \u2717 Not a price: ${override}\n`);
      process.exit(1);
    }
    console.log(`  using the price you supplied: ${symbol}/USD ${v} (not measured here)`);
    return v;
  }
  if (['USDC', 'USDT', 'USD', 'DAI'].includes(symbol)) {
    console.log(`  ${symbol} is taken as $1.00 (an assumption, not a measurement)`);
    return 1;
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

  if (reads.length === 0) {
    console.error(`\n  ✗ No venue priced ${symbol}. Nothing is derived from a guess.\n`);
    process.exit(1);
  }
  for (const r of reads) console.log(`  ${r.venue.padEnd(9)} ${symbol}/USD  ${r.price}`);

  if (reads.length === 2) {
    const [a, b] = reads.map((r) => r.price);
    const drift = Math.abs(a - b) / Math.min(a, b);
    if (drift > 0.02) {
      console.error(
        `\n  ✗ The two venues disagree by ${(drift * 100).toFixed(1)}%. That is the finding;` +
          `\n    re-run when they agree rather than picking one.\n`,
      );
      process.exit(1);
    }
  } else {
    console.log('  only one venue answered: treat the result as provisional.');
  }
  return reads.reduce((s, r) => s + r.price, 0) / reads.length;
}

console.log(`\n  target opening market cap: $${TARGET_USD.toLocaleString('en-US')}\n`);
const price = await priceUsd(QUOTE);

/*
 * Opening market cap = opening spot x total supply
 *                    = (virtual_quote / virtual_tokens) x total supply
 * so virtual_quote = cap x virtual_tokens / total supply.
 */
const capInQuote = TARGET_USD / price;
const exact = (capInQuote * VIRTUAL_TOKENS) / TOTAL_SUPPLY;
const whole = Math.round(exact);

// What that constant actually produces, which is the thing being chosen.
const openingCap = (whole * TOTAL_SUPPLY) / VIRTUAL_TOKENS;
const gradTarget = Math.floor((whole * GRAD_NUM) / GRAD_DEN);
const k = whole * VIRTUAL_TOKENS;
const ceiling = k / (VIRTUAL_TOKENS - CURVE_SUPPLY) - whole;
const remaining = k / (whole + gradTarget);
const endSpot = (whole + gradTarget) / remaining;
const gradCap = endSpot * TOTAL_SUPPLY;

const money = (v) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

console.log(`\n  virtual_quote_whole = ${whole}\n`);
console.log(`  opens at       ${openingCap.toFixed(2)} ${QUOTE}   ${money(openingCap * price)}`);
console.log(`  graduates at   ${gradTarget} ${QUOTE} raised       ${money(gradTarget * price)}`);
console.log(`  graduation cap ${gradCap.toFixed(0)} ${QUOTE}   ${money(gradCap * price)}`);
console.log(`  curve ceiling  ${ceiling.toFixed(0)} ${QUOTE}, target is ${((gradTarget / ceiling) * 100).toFixed(1)}% of it`);
console.log(`  price multiple x${(endSpot / (whole / VIRTUAL_TOKENS)).toFixed(2)} from open to graduation`);

/*
 * PRICE IMPACT AT THE OPEN, because that is what the scale is really for: the curve
 * was flattened because a modest buy moved the price too far, and a target market
 * cap is a proxy for that. Printed so the number is chosen on what it does rather
 * than on what it is.
 */
console.log(`\n  price impact at the open, 1% fee included:`);
for (const spend of [1, 5, 10, 50, 100].map((n) => n / price).filter((v) => v > 0)) {
  const afterFee = spend * 0.99;
  const out = VIRTUAL_TOKENS - (whole * VIRTUAL_TOKENS) / (whole + afterFee);
  const impact = (spend / out / (whole / VIRTUAL_TOKENS) - 1) * 100;
  console.log(`    ${money(spend * price).padStart(6)}  ${impact.toFixed(2)}%`);
}

console.log(`\n  Set it at deploy:`);
console.log(`    INJ_LAUNCH_FEE=0.2 node scripts/deploy.mjs   # with quote_virtual_whole ${whole}`);
console.log(`  or afterwards, as admin: SetQuote { denom, decimals, virtual_quote_whole: "${whole}" }`);
console.log(
  `\n  The dollar figure is a premise about today's ${QUOTE} price, not a property of` +
    `\n  the constant. Re-derive rather than carrying this number forward.\n`,
);
