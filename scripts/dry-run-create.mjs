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
  MsgCreateDenom,
  MsgMint,
  MsgSetDenomMetadata,
  MsgChangeAdmin,
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
 * DRY RUN. Builds the exact transaction the create page builds and SIMULATES it.
 *
 * Nothing is broadcast and nothing is spent. The point is the faucet's 24-hour
 * cooldown: Injective charges a 1 INJ denom-creation fee on `MsgCreateDenom`, and a
 * message-shape mistake fails AFTER that fee is taken, so a bad create costs a day.
 * A simulate runs the same messages through the same contract and reports what would
 * happen, for free.
 */
const privateKey = PrivateKey.fromMnemonic(mnemonic);
const sender = privateKey.toBech32();
const network = Network.Testnet;
const broadcaster = new MsgBroadcasterWithPk({ privateKey, network, simulateTx: true });

const factory = process.env.NEXT_PUBLIC_FACTORY_ADDRESS?.trim()
  || readFileSync(join(HERE, '..', 'app', '.env.local'), 'utf8')
      .split('\n').find((l) => l.startsWith('NEXT_PUBLIC_FACTORY_ADDRESS='))?.split('=')[1]?.trim();
if (!factory) die('No factory address.');

const ONE = 10n ** 18n;
const SEED = 1_000_000_000n * ONE;
const SYMBOL = `DRY${Math.floor(Math.random() * 9000 + 1000)}`;
const denom = `factory/${sender}/${SYMBOL}`;

console.log(`\n  factory  ${factory}`);
console.log(`  signer   ${sender}`);
console.log(`  denom    ${denom}`);

const rest = getNetworkEndpoints(network).rest;
const bal = await fetch(`${rest}/cosmos/bank/v1beta1/balances/${sender}`).then((r) => r.json());
const inj = BigInt(bal.balances?.find((b) => b.denom === 'inj')?.amount ?? '0');
console.log(`  balance  ${(Number(inj) / 1e18).toFixed(6)} INJ`);

/*
 * THE SAME FOUR MESSAGES THE APP BUILDS, in the same order. `create_launch` carries
 * only what the deployed contract's enum declares: cw_serde denies unknown fields, so
 * an extra key here is a refusal after the denom fee has been charged.
 */
const msgs = [
  MsgCreateDenom.fromJSON({ sender, subdenom: SYMBOL }),
  MsgMint.fromJSON({ sender, amount: { denom, amount: SEED.toString() } }),
  MsgSetDenomMetadata.fromJSON({
    sender,
    metadata: {
      description: 'Dry run. Never broadcast.',
      denomUnits: [
        { denom, exponent: 0, aliases: [] },
        { denom: SYMBOL, exponent: 18, aliases: [] },
      ],
      base: denom, display: SYMBOL, name: SYMBOL, symbol: SYMBOL,
      uri: '', uriHash: '', decimals: 18,
    },
  }),
  MsgExecuteContract.fromJSON({
    sender,
    contractAddress: factory,
    msg: { create_launch: { denom, fee_bps: 100 } },
    funds: [{ denom, amount: SEED.toString() }],
  }),
];

/**
 * Does the deployed contract accept the create_launch message we build?
 *
 * Simulated ON ITS OWN, with a denom the wallet does not hold, so it cannot pass the
 * contract's own checks. That is the point: the ERROR tells us how far it got. A
 * complaint about the seed or the denom means the message PARSED and the contract was
 * reasoning about it. A complaint about an unknown or missing field means the shape is
 * wrong, and that is the failure that would cost the 1 INJ fee for real.
 */
async function probeCreateShape() {
  const fake = `factory/${sender}/SHAPEPROBE`;
  try {
    await broadcaster.simulate({
      msgs: [
        MsgExecuteContract.fromJSON({
          sender,
          contractAddress: factory,
          msg: { create_launch: { denom: fake, fee_bps: 100 } },
          funds: [],
        }),
      ],
    });
    console.log(`  ✓ create_launch accepted outright`);
  } catch (e) {
    const m = String(e?.message ?? e);
    if (/unknown field|missing field|unknown variant|invalid type|parse/i.test(m)) {
      console.log(`  ✗ MESSAGE SHAPE REJECTED. This is what would waste the fee:`);
      console.log(`    ${m.slice(0, 300)}`);
      process.exit(1);
    }
    console.log(`  ✓ shape ACCEPTED: the contract parsed it and refused on its own`);
    console.log(`    rules, which is what it should do for a denom nobody holds.`);
    console.log(`    refusal: ${(m.match(/: ([^[]{10,160})/)?.[1] ?? m.slice(0, 160)).trim()}`);
  }
}

console.log(`\n  simulating ${msgs.length} messages (nothing is broadcast)…`);
try {
  const sim = await broadcaster.simulate({ msgs });
  const gas = sim?.gasInfo?.gasUsed ?? sim?.result?.gasUsed ?? 'unknown';
  console.log(`  ✓ SIMULATION PASSED`);
  console.log(`    gas used: ${gas}`);
  console.log(`\n  The contract accepted the message shape. The only thing standing`);
  console.log(`  between this and a real launch is the 1 INJ denom-creation fee.`);
} catch (e) {
  const m = String(e?.message ?? e);
  console.log(`  ✗ SIMULATION FAILED`);
  console.log(`    ${m.slice(0, 400)}`);
  if (/insufficient funds|spendable/i.test(m)) {
    /*
     * HONEST READING. This fails at MESSAGE INDEX 0, the denom-creation fee, so
     * nothing after it ran and `create_launch` was never evaluated. It proves the
     * funds are the blocker; it does NOT prove the contract accepts the message.
     * That is what the second simulate below is for.
     */
    console.log(`\n  Failed on the 1 INJ denom fee at message 0, so messages 1-3`);
    console.log(`  were never reached. Checking the create_launch shape separately…`);
    await probeCreateShape();
    process.exit(0);
  }
  if (/unknown field|missing field|parse/i.test(m)) {
    console.log(`\n  MESSAGE SHAPE MISMATCH. This would have cost the 1 INJ fee.`);
  }
  process.exit(1);
}
