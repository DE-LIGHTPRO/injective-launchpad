/**
 * Does the browser's curve arithmetic agree with the contract's, unit for unit?
 *
 * AUDIT F-08. The client re-implements the bonding curve in TypeScript, and that
 * arithmetic is what prints "you will receive X" above the button. The audit's note was
 * mild - one sample matched, add CI tests - and the exposure is not mild: a systematic
 * divergence would be wrong for every trade on every launch, silently, in the one
 * number this product exists to state before you sign. `contract-mirror.test.ts` pins
 * the CONSTANTS the two sides share; nothing compared their OUTPUTS.
 *
 * It is free to check. The curve answers `SimulateBuy` and `SimulateSell` as smart
 * queries, so this needs no gas, no key and no signature: it asks the chain what it
 * would do and asks `curve.ts` the same question about the same state.
 *
 *   node scripts/curve-parity.mjs                 # every live launch, several sizes
 *   node scripts/curve-parity.mjs INJPAD          # one ticker
 *
 * THE OPENING WINDOW IS EXCLUDED FROM THE STRICT COMPARISON, and that exclusion is a
 * finding rather than a convenience. During a launch's opening window the premium
 * decays with time, and the two sides read different clocks: `feeBpsAt(rules, base,
 * now)` takes `now` from the browser, the contract takes it from the block. So a
 * mismatch there measures clock skew, not arithmetic, and reporting it as an
 * arithmetic defect would be the measurement error this project keeps recording. Those
 * launches are reported separately, with the premium each side used, because the skew
 * is itself worth knowing: it is a real difference between the quote shown and the fill.
 *
 * Reuses the app's own readers and the app's own `curve.ts`. Reimplementing either here
 * would compare this script against the chain and prove nothing about the product.
 */
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '..', 'app', 'src', 'lib');
const load = (f) => import(pathToFileURL(join(LIB, f)).href);

const { listLaunches, getLaunchDetail } = await load('chain.ts');
const { quoteBuyWithPremium, quoteSell } = await load('curve.ts');
const { feeBpsAt } = await load('launchRules.ts');
const { getLcdUrl, NETWORK } = await load('config.ts');

const want = (process.argv[2] ?? '').toUpperCase();

/** A smart query, base64 as the LCD wants it. */
async function smart(contract, msg) {
  const q = Buffer.from(JSON.stringify(msg)).toString('base64');
  const url = `${getLcdUrl()}/cosmwasm/wasm/v1/contract/${contract}/smart/${q}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
  const body = await res.json();
  /*
   * A 200 is not a result. This endpoint answers a refused query with 200 and an error
   * document, which is how a parity run could otherwise report a clean pass having
   * compared `undefined` with `undefined`.
   */
  if (body?.data === undefined) throw new Error(`no data in response: ${JSON.stringify(body).slice(0, 160)}`);
  return body.data;
}

const INJ = 10n ** 18n;
/** Sizes spanning dust to a size that may empty the curve and trigger a refund. */
const BUY_SIZES = [1n, 10n ** 12n, INJ / 100n, INJ / 10n, INJ, 10n * INJ, 1000n * INJ];

const absent = new Set();
let compared = 0;
let fieldsCompared = 0;
let mismatches = 0;
const skewed = [];

console.log(`\n  curve parity against ${NETWORK.name}\n  ${getLcdUrl()}\n`);

const launches = await listLaunches();
// A launch has no `symbol`: the ticker is the tail of the tokenfactory denom.
const tickerOf = (l) => (l.denom.split('/').pop() ?? l.denom).toUpperCase();
const chosen = want ? launches.filter((l) => tickerOf(l) === want) : launches;
if (chosen.length === 0) {
  console.log(`  no launch matched ${want || '(any)'}; nothing to compare`);
  process.exit(1);
}

for (const l of chosen) {
  let d;
  try {
    d = await getLaunchDetail(l.curve);
  } catch (e) {
    console.log(`  ${tickerOf(l)}  SKIPPED: ${e.message.slice(0, 90)}`);
    continue;
  }
  if (d.migrated) {
    // Graduated: the curve no longer prices anything, the locked pool does.
    console.log(`  ${tickerOf(l)}  graduated, curve no longer quotes`);
    continue;
  }

  const base = Number(d.config.feeBps);
  const now = Math.floor(Date.now() / 1000);
  const charged = feeBpsAt(d.rules ?? {}, base, now);
  const premiumBps = Math.max(0, charged - base);
  const inWindow = premiumBps > 0;
  console.log(
    `  ${tickerOf(l)}  ${l.curve.slice(0, 12)}…  base ${base}bps${inWindow ? `  OPENING WINDOW, premium ${premiumBps}bps` : ''}`,
  );

  for (const injIn of BUY_SIZES) {
    let chain;
    try {
      chain = await smart(l.curve, { simulate_buy: { inj_in: injIn.toString() } });
    } catch (e) {
      console.log(`      buy ${injIn}  chain refused: ${e.message.slice(0, 70)}`);
      continue;
    }
    const js = quoteBuyWithPremium(d.config, d.state, injIn, BigInt(premiumBps));
    /*
     * ONLY FIELDS THE CHAIN ACTUALLY RETURNED. The live testnet curves run an older
     * code id than `contracts/curve` and do not report `early_fee_premium`, and
     * `BigInt(undefined)` throws while `Number(undefined)` would have quietly compared
     * NaN. A field this curve's code does not report is unmeasurable here, not zero,
     * and is counted as skipped so a run cannot pass by comparing nothing.
     */
    const pairs = [
      ['tokens_out', chain.tokens_out, js.tokensOut],
      ['fee', chain.fee, js.fee],
      ['refund', chain.refund, js.refund],
      ['early_fee_premium', chain.early_fee_premium, js.earlyFeePremium],
    ]
      .filter(([k, raw]) => {
        if (raw !== undefined) return true;
        absent.add(k);
        return false;
      })
      .map(([k, raw, mine]) => [k, BigInt(raw), mine]);
    const bad = pairs.filter(([, a, b]) => a !== b);
    const gradDiff = Boolean(chain.graduates) !== Boolean(js.graduates);
    if (inWindow) {
      if (bad.length || gradDiff) skewed.push({ symbol: tickerOf(l), injIn, bad, premiumBps });
      continue;
    }
    compared += 1;
    fieldsCompared += pairs.length;
    if (bad.length || gradDiff) {
      mismatches += 1;
      console.log(`      buy ${injIn}  MISMATCH`);
      for (const [k, a, b] of bad) console.log(`          ${k}: chain ${a}  js ${b}  diff ${b - a}`);
      if (gradDiff) console.log(`          graduates: chain ${chain.graduates}  js ${js.graduates}`);
    }
  }

  // Sell needs tokens that exist on the curve, so scale off what it has sold.
  const sold = d.state.tokensSold ?? 0n;
  const sizes = sold > 0n ? [1n, sold / 1000n || 1n, sold / 10n || 1n, sold] : [];
  for (const tokensIn of sizes) {
    let chain;
    try {
      chain = await smart(l.curve, { simulate_sell: { tokens_in: tokensIn.toString() } });
    } catch (e) {
      console.log(`      sell ${tokensIn}  chain refused: ${e.message.slice(0, 70)}`);
      continue;
    }
    const js = quoteSell(d.config, d.state, tokensIn);
    compared += 1;
    const bad = [
      ['inj_out', chain.inj_out, js.injOut],
      ['fee', chain.fee, js.fee],
    ]
      .filter(([k, raw]) => {
        if (raw !== undefined) return true;
        absent.add(k);
        return false;
      })
      .map(([k, raw, mine]) => [k, BigInt(raw), mine])
      .filter(([, a, b]) => a !== b);
    if (bad.length) {
      mismatches += 1;
      console.log(`      sell ${tokensIn}  MISMATCH`);
      for (const [k, a, b] of bad) console.log(`          ${k}: chain ${a}  js ${b}  diff ${b - a}`);
    }
  }
}

console.log(`\n  ${compared} comparisons outside any opening window, ${fieldsCompared} field checks, ${mismatches} mismatched`);
if (absent.size) {
  console.log(`  fields the deployed curve code does not report, so not compared: ${[...absent].join(', ')}`);
}
if (skewed.length) {
  console.log(`\n  ${skewed.length} comparison(s) inside an opening window differed.`);
  console.log('  That is the two clocks, not the arithmetic: the browser premium comes from');
  console.log('  Date.now() and the contract\'s from block time. Worth knowing because it is');
  console.log('  a real gap between the quote shown and the fill, but it is not a curve defect.');
  for (const s of skewed.slice(0, 5)) {
    console.log(`    ${s.symbol} buy ${s.injIn} premium ${s.premiumBps}bps: ${s.bad.map(([k, a, b]) => `${k} chain ${a} js ${b}`).join(', ')}`);
  }
}
if (compared === 0) {
  console.log('\n  NOTHING WAS COMPARED, which is a failure and not a pass.');
  process.exit(1);
}
process.exit(mismatches === 0 ? 0 : 1);
