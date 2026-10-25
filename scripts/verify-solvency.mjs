/**
 * Check that every launch on a factory can actually pay what it says it owes.
 *
 *   node scripts/verify-solvency.mjs            # the configured factory
 *   node scripts/verify-solvency.mjs inj1...    # a specific factory
 *
 * Exits non-zero if any launch is short, so a monitor can run it.
 *
 * WHY THIS IS WORTH A SCRIPT. Every other check here reads code or simulates a
 * message. This one asks the bank module what a contract actually holds and compares
 * it against the sum of every claim recorded in that contract's own state. It is the
 * only check that can catch an accounting error that the contract is internally
 * consistent about, which is the class a unit test cannot see: the contract's tests
 * assert its counters move correctly relative to each other, and would pass
 * identically if every counter were scaled by two.
 *
 * THE TWO INVARIANTS, both of which must hold exactly and not merely approximately.
 *
 * Quote side. The contract holds quote for four distinct reasons and they must sum to
 * what is in the bank:
 *
 *   inj_collected   the curve reserve, what sells are paid out of
 *   lp_bonus        creator fees routed to the pool before it exists, plus the
 *                   opening-fee premium, both waiting to be paired at graduation
 *   pool_quote      the locked pool's quote side after graduation
 *   creator_owed    fees accrued to the creator, not yet claimed
 *   platform_owed   the platform's share, not yet claimed
 *
 * A surplus is tolerated and reported, because anyone can send a contract funds and
 * that must not read as a defect. A shortfall is a failure: it means some claim cannot
 * be honoured, and the first person to find out would be whoever claims last.
 *
 * Token side. Before graduation the contract should hold the curve supply plus the LP
 * reserve, less whatever has been sold. After graduation `pool_tokens` is the whole
 * claim, because `seed_pool` folds the unsold remainder into the pool.
 *
 * Measured on testnet 25 Oct 2026 across six launches, two quote decimal scales and
 * both lifecycle states: delta zero on every one, on both sides, to the base unit.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Network, getNetworkEndpoints } from '@injectivelabs/networks';

import { loadAppEnv, loadEnvLocal } from './loadEnvLocal.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function die(msg, ...hints) {
  console.error(`\n  ✗ ${msg}`);
  for (const hint of hints) if (hint) console.error(`    ${hint}`);
  console.error('');
  process.exit(1);
}

// Read-only, so the chain comes from NEXT_PUBLIC_NETWORK like the keeper and the
// readiness check rather than from a flag. `deploy.mjs` is the exception, and only
// because it signs an upload.
loadEnvLocal(() => {});
loadAppEnv();
const netName = process.env.NEXT_PUBLIC_NETWORK?.trim() === 'mainnet' ? 'mainnet' : 'testnet';
const network = netName === 'mainnet' ? Network.Mainnet : Network.Testnet;
const rest = process.env.NEXT_PUBLIC_LCD_URL?.trim() || getNetworkEndpoints(network).rest;

const factory = process.argv[2]?.trim() || process.env.NEXT_PUBLIC_FACTORY_ADDRESS?.trim();
if (!factory) {
  die('No factory address.', 'Pass one, or set NEXT_PUBLIC_FACTORY_ADDRESS in app/.env.local.');
}

async function smart(addr, query) {
  const b64 = Buffer.from(JSON.stringify(query)).toString('base64');
  const res = await fetch(`${rest}/cosmwasm/wasm/v1/contract/${addr}/smart/${b64}`);
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 140)}`);
  const body = await res.json();
  // Rule: a 200 is not an answer. The LCD answers 200 with a `code` on some versions.
  if (body.code || body.data === undefined) {
    throw new Error(`unexpected body: ${JSON.stringify(body).slice(0, 140)}`);
  }
  return body.data;
}

/**
 * One denom's balance, asked for by name.
 *
 * NOT the plural `/balances/{addr}`, which pages and defaults to 100 denoms. A curve
 * holds two, so that read looks correct forever - and anyone can send a contract more
 * than a hundred junk tokenfactory denoms for the price of the creation fee, at which
 * point the quote or token denom falls off the end of the first page, reads as zero,
 * and this script reports a shortfall on a contract that is perfectly solvent. A
 * solvency monitor whose alarm a stranger can trigger is worse than no monitor.
 *
 * Found by `tx-search-limit.test.ts`, which was written for exactly this and caught
 * the plural read in the first draft of this file.
 */
async function balanceOf(addr, denom) {
  const url = `${rest}/cosmos/bank/v1beta1/balances/${addr}/by_denom?denom=${encodeURIComponent(denom)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} reading ${denom.slice(0, 40)}`);
  const body = await res.json();
  // An absent balance is a legitimate zero here; a malformed body is not.
  if (body.balance?.amount === undefined) {
    throw new Error(`unexpected balance body: ${JSON.stringify(body).slice(0, 120)}`);
  }
  return BigInt(body.balance.amount);
}

const big = (v) => BigInt(v ?? '0');

console.log(`\n  solvency check → ${netName}`);
console.log(`  factory ${factory}`);
console.log(`  via ${rest}\n`);

let launches;
try {
  launches = (await smart(factory, { launches: { limit: 100 } })).launches ?? [];
} catch (e) {
  die('The factory could not be read.', e.message);
}

if (launches.length === 0) {
  console.log('  no launches on this factory yet.\n');
  process.exit(0);
}

let short = 0;
let surplus = 0;
let unreadable = 0;

for (const l of launches) {
  const label = (l.denom ?? '').split('/').pop() ?? l.curve;
  let state;
  let cfg;
  try {
    state = await smart(l.curve, { state: {} });
    cfg = await smart(l.curve, { config: {} });
  } catch (e) {
    // One unreadable launch must not stop the others being checked, and must not be
    // silently counted as sound either.
    unreadable += 1;
    console.log(`  ? ${label.padEnd(12)} could not be read: ${String(e.message).slice(0, 70)}`);
    continue;
  }

  const curve = cfg.curve ?? {};
  const quoteDenom = cfg.quote_denom ?? curve.quote_denom ?? 'inj';
  const tokenDenom = cfg.denom ?? cfg.token_denom ?? l.denom;
  // Read after the config, because the denoms are what we ask for by name.
  const heldQuote = await balanceOf(l.curve, quoteDenom);
  const heldToken = await balanceOf(l.curve, tokenDenom);

  const owedQuote =
    big(state.inj_collected) +
    big(state.lp_bonus) +
    big(state.pool_quote) +
    big(state.creator_owed) +
    big(state.platform_owed);
  const quoteDelta = heldQuote - owedQuote;

  const migrated = Boolean(state.migrated);
  const owedTokens = migrated
    ? big(state.pool_tokens)
    : big(curve.curve_supply) + big(cfg.lp_reserve) - big(state.tokens_sold);
  const tokenDelta = heldToken - owedTokens;

  const bad = quoteDelta < 0n || tokenDelta < 0n;
  const over = quoteDelta > 0n || tokenDelta > 0n;
  if (bad) short += 1;
  else if (over) surplus += 1;

  const mark = bad ? '✗' : over ? '!' : '✓';
  const stage = migrated ? 'pool' : 'curve';
  console.log(
    `  ${mark} ${label.padEnd(12)} ${stage.padEnd(6)} quote ${quoteDelta === 0n ? 'exact' : quoteDelta.toString()}` +
      `   tokens ${tokenDelta === 0n ? 'exact' : tokenDelta.toString()}`,
  );
}

console.log('');
if (short > 0) {
  die(
    short === 1
      ? '1 launch cannot pay what its state says it owes.'
      : `${short} launches cannot pay what their state says they owe.`,
    'A shortfall means a recorded claim is unpayable. Do not launch against this build.',
  );
}
console.log(
  `  ${launches.length - unreadable} checked, all solvent` +
    (surplus > 0 ? `, ${surplus} holding a surplus (someone sent funds; not a defect)` : '') +
    (unreadable > 0 ? `, ${unreadable} unreadable` : '') +
    '\n',
);
process.exit(unreadable > 0 ? 1 : 0);
