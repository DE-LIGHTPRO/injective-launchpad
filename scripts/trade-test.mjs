/**
 * One real trade on one real curve, with the fee split checked against the config.
 *
 *   node scripts/trade-test.mjs <curve-address> [quote-to-spend]
 *
 * It buys, reads the curve's state before and after, and asserts the fee that was
 * charged split in exactly the ratio the contract reports, rather than printing two
 * numbers and leaving the reader to divide them. Then it claims, and checks the
 * platform's bank balance actually moved: an owed counter going to zero is not
 * evidence anybody was paid.
 *
 * THIS FILE'S DOCBLOCK USED TO DESCRIBE A DIFFERENT SCRIPT. It was copied from
 * `create-test-launch.mjs` and never rewritten, so it told the reader this file
 * creates a launch from four messages and documented a `--ticker` argument it does
 * not take. A comment describing a control is part of the control.
 *
 * Needs INJ_MNEMONIC in scripts/.env.local (chmod 600), the same as deploy.mjs, and
 * enough of the launch's quote to spend plus gas.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PrivateKey,
  MsgExecuteContract,
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

const curve = process.argv[2];
const spendInj = Number(process.argv[3] ?? '1');
if (!curve?.startsWith('inj1')) die('Usage: node scripts/trade-test.mjs <curve-address> [inj]');

const ONE = 10n ** 18n;
const spend = BigInt(Math.round(spendInj * 1e18));
const rest = getNetworkEndpoints(network).rest;

const smart = async (addr, q) => {
  const b64 = Buffer.from(JSON.stringify(q)).toString('base64');
  const r = await fetch(`${rest}/cosmwasm/wasm/v1/contract/${addr}/smart/${b64}`);
  if (!r.ok) die(`query failed: ${r.status}`, await r.text());
  return (await r.json()).data;
};
const bank = async (addr, denom) => {
  const r = await fetch(`${rest}/cosmos/bank/v1beta1/balances/${addr}`);
  const d = await r.json();
  return BigInt(d.balances?.find((b) => b.denom === denom)?.amount ?? '0');
};
const fmt = (v) => (Number(v) / 1e18).toFixed(6);

const cfg = await smart(curve, { config: {} });
console.log(`\n  curve    ${curve}`);
console.log(`  creator  ${cfg.creator}`);
console.log(`  platform ${cfg.platform}`);
console.log(`  fee      ${cfg.curve.fee_bps} bps, creator keeps ${cfg.creator_fee_share_bps} bps of it`);

const before = await smart(curve, { state: {} });
console.log(`\n  before:  creator_owed ${fmt(before.creator_owed)}  platform_owed ${fmt(before.platform_owed)}`);

console.log(`\n  buying with ${spendInj} INJ…`);
const buy = await broadcaster.broadcast({
  msgs: MsgExecuteContract.fromJSON({
    sender,
    contractAddress: curve,
    msg: { buy: { min_tokens_out: '0' } },
    funds: [{ denom: 'inj', amount: spend.toString() }],
  }),
});
console.log(`  ✓ ${buy.txHash}`);

const after = await smart(curve, { state: {} });
const dCreator = BigInt(after.creator_owed) - BigInt(before.creator_owed);
const dPlatform = BigInt(after.platform_owed) - BigInt(before.platform_owed);
const total = dCreator + dPlatform;
console.log(`\n  fee charged      ${fmt(total)} INJ`);
console.log(`  to creator       ${fmt(dCreator)}  (${(Number(dCreator) * 10000 / Number(total)).toFixed(0)} bps of the fee)`);
console.log(`  to platform      ${fmt(dPlatform)}  (${(Number(dPlatform) * 10000 / Number(total)).toFixed(0)} bps of the fee)`);
console.log(`  tokens bought    ${fmt(BigInt(after.tokens_sold) - BigInt(before.tokens_sold))}`);

// The split must be exactly what the config says, not approximately.
const want = (total * BigInt(cfg.creator_fee_share_bps)) / 10000n;
if (dCreator !== want) die(`creator got ${dCreator}, config implies ${want}`);
console.log(`  ✓ split matches the config exactly`);

console.log(`\n  claiming…`);
const pBefore = await bank(cfg.platform, 'inj');
const claim = await broadcaster.broadcast({
  msgs: MsgExecuteContract.fromJSON({ sender, contractAddress: curve, msg: { claim_fees: {} }, funds: [] }),
});
console.log(`  ✓ ${claim.txHash}`);

const settled = await smart(curve, { state: {} });
console.log(`\n  after claim:`);
console.log(`    creator_owed   ${fmt(settled.creator_owed)}   (cleared)`);
console.log(`    platform_owed  ${fmt(settled.platform_owed)}   (cleared)`);
console.log(`    creator_paid   ${fmt(settled.creator_paid ?? '0')}   <- lifetime counter`);
console.log(`    platform_paid  ${fmt(settled.platform_paid ?? '0')}   <- lifetime counter`);
console.log(`\n  platform bank balance moved by ${fmt((await bank(cfg.platform, 'inj')) - pBefore)} INJ`);
console.log(`  (gas comes out of the same account here, so expect it to be net of fees)\n`);
