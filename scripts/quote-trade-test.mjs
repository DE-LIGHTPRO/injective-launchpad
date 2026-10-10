/**
 * Create a real launch from the command line, to prove the contracts work.
 *
 * This exists to SEPARATE TWO QUESTIONS that are otherwise answered together:
 *
 *   1. do the four messages compose a launch the chain accepts?
 *   2. does the browser's signing path encode them correctly?
 *
 * The create page answers both at once, so a failure there is ambiguous: the
 * contract could be wrong, or `app/src/lib/broadcast.ts` could be. This answers only
 * the first, with the same four messages built the same way, signed by the deploy key
 * through the SDK's own broadcaster rather than through a wallet.
 *
 * If this lands and the browser does not, the fault is the browser encoding. If
 * neither lands, it is the contract. That is worth one script.
 *
 *   node scripts/create-test-launch.mjs           # ticker defaults to TEST<n>
 *   node scripts/create-test-launch.mjs KAIJU 2   # ticker, and 2 INJ opening buy
 *
 * Needs INJ_MNEMONIC in scripts/.env.local, the same as deploy.mjs, and roughly
 * 2 INJ: Injective charges a 1 INJ tokenfactory denom creation fee, plus gas, plus
 * whatever opening buy is asked for.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PrivateKey,
  MsgExecuteContract,
  MsgCreateDenom,
  MsgMint,
  MsgBroadcasterWithPk,
} from '@injectivelabs/sdk-ts';
// Network lives in its own package, not in sdk-ts. deploy.mjs already imports it
// from here; the SDK re-exports almost everything else, which is what made the
// wrong guess look reasonable.
import { Network, getNetworkEndpoints } from '@injectivelabs/networks';

const HERE = dirname(fileURLToPath(import.meta.url));

function die(msg, hint) {
  console.error(`\n  ✗ ${msg}`);
  if (hint) console.error(`    ${hint}\n`);
  process.exit(1);
}

// Same loader and the same permission refusal as deploy.mjs: this process holds a
// seed phrase, and a file at 0644 is readable by every account on the machine.
const envPath = join(HERE, '.env.local');
if (existsSync(envPath)) {
  if ((statSync(envPath).mode & 0o777) & 0o077) {
    die('scripts/.env.local is readable by others.', 'Run: chmod 600 scripts/.env.local');
  }
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[t.slice(0, eq).trim()] === undefined) process.env[t.slice(0, eq).trim()] = v;
  }
}

const mnemonic = process.env.INJ_MNEMONIC?.trim();
if (!mnemonic) die('No INJ_MNEMONIC.', 'Put it in scripts/.env.local, chmod 600, and re-run.');


/*
 * Exercise the fee split against a live curve.
 *
 * Buy, read what accrued to each side, claim, and read the bank balances. Every
 * contract test asserts this already; what it cannot assert is that the DEPLOYED
 * bytes do it, on a real chain, with a real denom and real gas. That is the gap this
 * script closes, and it is the gap that has hidden every defect on this project.
 */
const privateKey = PrivateKey.fromMnemonic(mnemonic);
const sender = privateKey.toBech32();
const network = Network.Testnet;
const broadcaster = new MsgBroadcasterWithPk({ privateKey, network, simulateTx: true });



/*
 * Prove the whole non-INJ path on a live chain, including a TRADE.
 *
 * The previous quote test allowlisted a real 6-decimal USDC denom and launched
 * against it, which proved the curve scaled. It could not prove a trade, because the
 * deploy key holds no USDC. So this mints its own 6-decimal quote asset, which the
 * key does hold, and buys with it.
 *
 * That is the half that matters: the panel quotes, scales, and signs in the quote's
 * units, and until something spends a non-18-decimal quote against a real contract,
 * every one of those is untested wiring.
 */
const factory = process.env.NEXT_PUBLIC_FACTORY_ADDRESS?.trim()
  || readFileSync(join(HERE, '..', 'app', '.env.local'), 'utf8')
      .split('\n').find((l) => l.startsWith('NEXT_PUBLIC_FACTORY_ADDRESS='))?.split('=')[1]?.trim();
if (!factory) die('No factory address.');

const rest = getNetworkEndpoints(network).rest;
const smart = async (addr, q) => {
  const r = await fetch(`${rest}/cosmwasm/wasm/v1/contract/${addr}/smart/${Buffer.from(JSON.stringify(q)).toString('base64')}`);
  if (!r.ok) die(`query failed ${r.status}`, await r.text());
  return (await r.json()).data;
};

const ONE = 10n ** 18n;
const SIX = 10n ** 6n;
const tag = Math.floor(Math.random() * 9000 + 1000);
const QSYM = `TUSD${tag}`;
const qDenom = `factory/${sender}/${QSYM}`;
const TSYM = `PAIR${tag}`;
const tDenom = `factory/${sender}/${TSYM}`;

console.log(`\n  1. minting a SIX decimal quote asset ${QSYM}`);
let r = await broadcaster.broadcast({
  msgs: [
    MsgCreateDenom.fromJSON({ sender, subdenom: QSYM }),
    MsgMint.fromJSON({ sender, amount: { denom: qDenom, amount: (10_000n * SIX).toString() } }),
  ],
});
if (r.code !== 0) die('mint failed', r.rawLog);
console.log(`     ✓ 10,000 ${QSYM} (6dp)`);

console.log(`\n  2. allowlisting it as a quote at 6 decimals`);
r = await broadcaster.broadcast({
  msgs: MsgExecuteContract.fromJSON({
    sender, contractAddress: factory,
    msg: { set_quote: { denom: qDenom, decimals: 6 } }, funds: [],
  }),
});
if (r.code !== 0) die('allowlist failed', r.rawLog);

console.log(`\n  3. launching ${TSYM} priced in ${QSYM}`);
r = await broadcaster.broadcast({
  msgs: [
    MsgCreateDenom.fromJSON({ sender, subdenom: TSYM }),
    MsgMint.fromJSON({ sender, amount: { denom: tDenom, amount: (1_000_000_000n * ONE).toString() } }),
    MsgExecuteContract.fromJSON({
      sender, contractAddress: factory,
      msg: { create_launch: { denom: tDenom, fee_bps: 100, quote_denom: qDenom } },
      funds: [{ denom: tDenom, amount: (1_000_000_000n * ONE).toString() }],
    }),
  ],
});
if (r.code !== 0) die('launch failed', r.rawLog);
const list = await smart(factory, { launches: {} });
const launch = list.launches[list.launches.length - 1];
const cfg = await smart(launch.curve, { config: {} });
console.log(`     ✓ curve ${launch.curve}`);
console.log(`     virtual_inj ${cfg.curve.virtual_inj} · target ${cfg.curve.graduation_target}`);

console.log(`\n  4. BUYING with 10 ${QSYM} (10000000 base units at 6dp)`);
const spend = 10n * SIX;
r = await broadcaster.broadcast({
  msgs: MsgExecuteContract.fromJSON({
    sender, contractAddress: launch.curve,
    msg: { buy: { min_tokens_out: '0' } },
    funds: [{ denom: qDenom, amount: spend.toString() }],
  }),
});
if (r.code !== 0) die('BUY FAILED', r.rawLog);
console.log(`     ✓ ${r.txHash}`);

const st = await smart(launch.curve, { state: {} });
const fee = BigInt(st.creator_owed) + BigInt(st.platform_owed);
console.log(`\n  collected        ${st.inj_collected} (${Number(st.inj_collected) / 1e6} ${QSYM})`);
console.log(`  tokens sold      ${(Number(st.tokens_sold) / 1e18).toLocaleString()}`);
console.log(`  fee charged      ${fee} (${Number(fee) / 1e6} ${QSYM}, expect 1% of 10 = 0.1)`);
console.log(`  to creator       ${st.creator_owed}  (expect 70000 = 70%)`);
console.log(`  to platform      ${st.platform_owed}  (expect 30000 = 30%)`);

const ok = cfg.curve.virtual_inj === '30000000'
  && cfg.curve.graduation_target === '85000000'
  && fee === 100_000n
  && st.creator_owed === '70000'
  && st.platform_owed === '30000';
console.log(`\n  ${ok ? '✓ a six-decimal quote scales, trades, and splits correctly' : '✗ SOMETHING IS WRONG'}\n`);
if (!ok) process.exit(1);
