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
 * Prove multi-quote against a live chain.
 *
 * Allowlist a SIX decimal quote, launch against it, and read the curve back. The
 * scaling is the whole risk: 18-decimal constants against a 6-decimal quote put the
 * graduation target at 85 trillion, which nothing can ever reach, and nothing about
 * the launch would look wrong until somebody tried to graduate it.
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

const QUOTE6 = 'erc20:0x05148C203a48103da989090CC882543eF8724f78'; // USDC, 6 decimals
const ONE = 10n ** 18n;
const SYMBOL = `SIX${Math.floor(Math.random() * 9000 + 1000)}`;
const denom = `factory/${sender}/${SYMBOL}`;
const SEED = 1_000_000_000n * ONE;

console.log(`\n  factory ${factory}`);
console.log(`  allowlisting ${QUOTE6.slice(0, 28)}… at 6 decimals`);
await broadcaster.broadcast({
  msgs: MsgExecuteContract.fromJSON({
    sender, contractAddress: factory,
    msg: { set_quote: { denom: QUOTE6, decimals: 6 } }, funds: [],
  }),
});
const quotes = await smart(factory, { quotes: {} });
console.log(`  allowlist now: ${quotes.quotes.map((q) => `${q.denom.slice(0, 14)}…(${q.decimals})`).join(', ')}`);

console.log(`\n  launching ${SYMBOL} paired with the 6-decimal quote…`);
const res = await broadcaster.broadcast({
  msgs: [
    MsgCreateDenom.fromJSON({ sender, subdenom: SYMBOL }),
    MsgMint.fromJSON({ sender, amount: { denom, amount: SEED.toString() } }),
    MsgExecuteContract.fromJSON({
      sender, contractAddress: factory,
      msg: { create_launch: { denom, fee_bps: 100, quote_denom: QUOTE6 } },
      funds: [{ denom, amount: SEED.toString() }],
    }),
  ],
});
if (res.code !== 0) die('launch failed', res.rawLog);
console.log(`  ✓ ${res.txHash}`);

const list = await smart(factory, { launches: {} });
const last = list.launches[list.launches.length - 1];
const cfg = await smart(last.curve, { config: {} });
console.log(`\n  quote_denom        ${cfg.quote_denom.slice(0, 32)}…`);
console.log(`  virtual_inj        ${cfg.curve.virtual_inj}   (expect 30000000 = 30 USDC)`);
console.log(`  graduation_target  ${cfg.curve.graduation_target}   (expect 85000000 = 85 USDC)`);
console.log(`  curve_supply       ${cfg.curve.curve_supply}  (unscaled: tokens are 18dp)`);
const ok = cfg.curve.virtual_inj === '30000000' && cfg.curve.graduation_target === '85000000'
  && cfg.curve.curve_supply === (800_000_000n * ONE).toString();
console.log(`\n  ${ok ? '✓ the curve scaled to the quote' : '✗ SCALING WRONG'}\n`);
if (!ok) process.exit(1);
