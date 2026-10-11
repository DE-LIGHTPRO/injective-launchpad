/**
 * Put a spread of real trades on one launch, so the chart has something to draw.
 *
 *   node scripts/seed-trades.mjs <curve-address> [count]
 *
 * WHY A SCRIPT. The candle chart, the 24h trade count, the trending strip and the
 * price series are all derived from trade history, and a launch with one trade
 * renders a single candle that proves nothing about the layout. Nobody can sign from
 * the browser pane here (no wallet extension), so the only way to look at a populated
 * chart is to put real trades on chain.
 *
 * SEPARATE TRANSACTIONS, deliberately. `candles.ts` buckets by BLOCK HEIGHT, so
 * several trades batched into one transaction land in one bucket and draw one candle.
 * These go one at a time and alternate direction, which is also what makes a candle
 * have a body rather than being a doji.
 *
 * Buys and sells only, and nothing is claimed: the claim page should have a non-zero
 * balance to show afterwards, and claiming here would hide the thing being verified.
 * It spends real testnet quote, so the amounts are small and it prints the total.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrivateKey, MsgExecuteContract, MsgBroadcasterWithPk } from '@injectivelabs/sdk-ts';
import { Network, getNetworkEndpoints } from '@injectivelabs/networks';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', 'app');

function die(msg, hint) {
  console.error(`\n  ✗ ${msg}`);
  if (hint) console.error(`    ${hint}\n`);
  process.exit(1);
}

function loadEnv(path, { secret = false } = {}) {
  if (!existsSync(path)) return;
  if (secret && (statSync(path).mode & 0o777) & 0o077) {
    die(`${path} is readable by others.`, `Run: chmod 600 ${path}`);
  }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    const k = t.slice(0, eq).trim();
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadEnv(join(HERE, '.env.local'), { secret: true });
loadEnv(join(APP, '.env.local'));

const mnemonic = process.env.INJ_MNEMONIC?.trim();
if (!mnemonic) die('No INJ_MNEMONIC.', 'Put it in scripts/.env.local, chmod 600, and re-run.');

const { NETWORK } = await import(join(APP, 'src/lib/config.ts'));

const curve = process.argv[2];
const count = Number(process.argv[3] ?? 6);
if (!curve?.startsWith('inj1')) die('Usage: node scripts/seed-trades.mjs <curve-address> [count]');

const privateKey = PrivateKey.fromMnemonic(mnemonic);
const sender = privateKey.toBech32();
const network = NETWORK.name === 'mainnet' ? Network.Mainnet : Network.Testnet;
const broadcaster = new MsgBroadcasterWithPk({ privateKey, network });
const rest = getNetworkEndpoints(network).rest;

const smart = async (addr, q) => {
  const b64 = Buffer.from(JSON.stringify(q)).toString('base64');
  const r = await fetch(`${rest}/cosmwasm/wasm/v1/contract/${addr}/smart/${b64}`);
  if (!r.ok) die(`query failed: ${r.status}`, await r.text());
  return (await r.json()).data;
};
const bal = async (denom) => {
  const d = await fetch(`${rest}/cosmos/bank/v1beta1/balances/${sender}`).then((r) => r.json());
  return BigInt(d.balances?.find((b) => b.denom === denom)?.amount ?? '0');
};

const cfg = await smart(curve, { config: {} });
const quoteDenom = cfg.quote_denom ?? NETWORK.quoteDenom;
const quoteDecimals = Number(cfg.quote_decimals ?? NETWORK.quoteDecimals);
const unit = 10n ** BigInt(quoteDecimals);

console.log(`\n  curve   ${curve}`);
console.log(`  token   ${cfg.denom}`);
console.log(`  quote   ${quoteDenom} (${quoteDecimals} decimals)`);

const quoteBefore = await bal(quoteDenom);

/*
 * A walk rather than a ramp. Equal buys draw a monotonic staircase, which hides
 * whether the candle body and the wicks are drawn the right way up; alternating with
 * sells of part of the position produces both directions.
 */
let spentTotal = 0n;
for (let i = 0; i < count; i += 1) {
  const sell = i > 0 && i % 3 === 0;
  try {
    if (sell) {
      const held = await bal(cfg.denom);
      const amount = held / 8n;
      if (amount === 0n) {
        console.log(`  ${i + 1}/${count}  skipped a sell: nothing held`);
        continue;
      }
      const res = await broadcaster.broadcast({
        msgs: MsgExecuteContract.fromJSON({
          sender,
          contractAddress: curve,
          /*
           * `min_inj_out` is the contract's own name for it and the app sends the
           * same key. It predates multi-quote support, so on a USDC launch it is a
           * minimum amount of USDC; the name is a misnomer, not a bug, and renaming
           * it would break the message shape of every deployed curve.
           *
           * The AMOUNT is not in the message: `Sell` takes only the slippage floor
           * and reads the size from the attached funds, exactly as `TradePanel`
           * does. Putting it in the message is an unknown field and cw_serde refuses
           * the whole execute.
           */
          msg: { sell: { min_inj_out: '0' } },
          funds: [{ denom: cfg.denom, amount: amount.toString() }],
        }),
      });
      if (res.code !== 0) die(`sell refused (code ${res.code})`, res.rawLog);
      console.log(`  ${i + 1}/${count}  sell  ${res.txHash}`);
    } else {
      // A different amount each time, so consecutive trades are not the same price.
      const spend = (unit * BigInt(20 + i * 17)) / 100n;
      const res = await broadcaster.broadcast({
        msgs: MsgExecuteContract.fromJSON({
          sender,
          contractAddress: curve,
          msg: { buy: { min_tokens_out: '0' } },
          funds: [{ denom: quoteDenom, amount: spend.toString() }],
        }),
      });
      if (res.code !== 0) die(`buy refused (code ${res.code})`, res.rawLog);
      spentTotal += spend;
      console.log(`  ${i + 1}/${count}  buy   ${res.txHash}`);
    }
  } catch (e) {
    die(`trade ${i + 1} failed`, e?.originalMessage ?? e?.message ?? String(e));
  }
}

const state = await smart(curve, { state: {} });
const quoteAfter = await bal(quoteDenom);
const fmt = (v) => (Number(v) / Number(unit)).toFixed(Math.min(6, quoteDecimals));

console.log(`\n  collected       ${fmt(state.inj_collected)}`);
console.log(`  creator owed    ${fmt(state.creator_owed)}`);
console.log(`  platform owed   ${fmt(state.platform_owed)}`);
console.log(`  wallet moved    ${fmt(quoteAfter - quoteBefore)} (net of gas, which is paid in ${NETWORK.gasDenom})`);
console.log(`\n  ${NETWORK.explorer}/contract/${curve}\n`);
