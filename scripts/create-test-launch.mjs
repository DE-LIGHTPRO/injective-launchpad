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

const factory = process.env.NEXT_PUBLIC_FACTORY_ADDRESS?.trim()
  ?? readFileSync(join(HERE, '..', 'app', '.env.local'), 'utf8')
    .split('\n')
    .find((l) => l.startsWith('NEXT_PUBLIC_FACTORY_ADDRESS='))
    ?.split('=')[1]
    ?.trim();
if (!factory) die('No factory address.', 'Set NEXT_PUBLIC_FACTORY_ADDRESS in app/.env.local.');

const symbol = (process.argv[2] ?? `TEST${Date.now().toString().slice(-4)}`).toUpperCase();
const openingBuyInj = Number(process.argv[3] ?? 0);

const privateKey = PrivateKey.fromMnemonic(mnemonic);
const sender = privateKey.toBech32();
const denom = `factory/${sender}/${symbol}`;

const ONE = 10n ** 18n;
const CURVE_SUPPLY = 800_000_000n * ONE;
const LP_RESERVE = 200_000_000n * ONE;
const SEED = CURVE_SUPPLY + LP_RESERVE;
const openingBuy = BigInt(Math.round(openingBuyInj * 1e18));

console.log(`\n  Creating a launch on ${factory}`);
console.log(`  signer: ${sender}`);
console.log(`  denom:  ${denom}`);
if (openingBuy > 0n) console.log(`  opening buy: ${openingBuyInj} INJ`);

/*
 * The same four messages `planLaunch` builds, in the same order, with the same
 * two-unit denom metadata. Written out rather than imported because that file is
 * TypeScript inside the Next app; keeping them side by side is the point, and
 * `test/create-launch.test.ts` is what pins the shape either way.
 */
const msgs = [
  MsgCreateDenom.fromJSON({ sender, subdenom: symbol }),
  MsgMint.fromJSON({ sender, amount: { denom, amount: SEED.toString() } }),
  MsgSetDenomMetadata.fromJSON({
    sender,
    metadata: {
      description: 'Created by scripts/create-test-launch.mjs to verify the contracts.',
      denomUnits: [
        { denom, exponent: 0, aliases: [] },
        { denom: symbol, exponent: 18, aliases: [] },
      ],
      base: denom,
      display: symbol,
      name: symbol,
      symbol,
      uri: '',
      uriHash: '',
      decimals: 18,
    },
  }),
  MsgExecuteContract.fromJSON({
    sender,
    contractAddress: factory,
    msg: {
      create_launch: {
        denom,
        /*
         * The curve is no longer sent. Its shape is policy written by the factory,
         * so the only number left here is the fee; `cw_serde` denies unknown fields,
         * so leaving `curve` or `lp_reserve` in fails the execute AFTER the 1 INJ
         * denom-creation fee has been charged in the same transaction.
         */
        fee_bps: 100,
        ...(openingBuy > 0n ? { initial_buy: openingBuy.toString() } : {}),
      },
    },
    funds: [
      { denom, amount: SEED.toString() },
      ...(openingBuy > 0n ? [{ denom: 'inj', amount: openingBuy.toString() }] : []),
    ],
  }),
];

try {
  const res = await new MsgBroadcasterWithPk({
    privateKey,
    network: Network.Testnet,
    endpoints: getNetworkEndpoints(Network.Testnet),
  }).broadcast({ msgs });

  /*
   * A 200 is not a landed transaction. The broadcaster resolves with the chain's own
   * `code`, and anything but zero is a refusal that arrived looking like a success.
   */
  if (res.code !== 0) {
    die(`The chain refused it (code ${res.code}).`, res.rawLog);
  }
  console.log(`\n  ✓ launched. tx ${res.txHash}`);
  console.log(`  https://testnet.explorer.injective.network/transaction/${res.txHash}`);
  console.log(`\n  The board should show it: https://injpad.vercel.app/\n`);
} catch (e) {
  die('Broadcast failed.', e?.originalMessage ?? e?.message ?? String(e));
}
