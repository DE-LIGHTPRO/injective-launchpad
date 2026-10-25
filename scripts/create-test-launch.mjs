/**
 * Create a real launch from the command line, to prove the contracts work.
 *
 * This exists to SEPARATE TWO QUESTIONS that are otherwise answered together:
 *
 *   1. do the messages compose a launch the chain accepts?
 *   2. does the browser's signing path encode them correctly?
 *
 * The create page answers both at once, so a failure there is ambiguous: the
 * contract could be wrong, or the wallet encoding could be. This answers only the
 * first, with the messages built by the app's own `planLaunch` and `composeMessages`,
 * signed by the deploy key through the SDK's broadcaster rather than through a wallet.
 *
 * If this lands and the browser does not, the fault is the browser encoding. If
 * neither lands, it is the contract. That is worth one script.
 *
 * IT IMPORTS THE APP'S BUILDERS RATHER THAN RESTATING THEM. It used to restate
 * them, with a comment saying "the same four messages `planLaunch` builds" beside a
 * list of five, and a `create_launch` payload of `{ denom, fee_bps }` that had
 * stopped matching the app several fields ago. A script that spends a 1 INJ denom
 * fee to verify the real path must not be verifying a different path. The sibling
 * `dry-run-create.mjs` had the same defect, and in its case the restated list was
 * missing `MsgChangeAdmin` entirely.
 *
 *   node scripts/create-test-launch.mjs           # ticker defaults to TEST<n>
 *   node scripts/create-test-launch.mjs KAIJU 2   # ticker, and 2 INJ opening buy
 *
 * Needs INJ_MNEMONIC in scripts/.env.local, the same as deploy.mjs, and roughly
 * 2 INJ: Injective charges a 1 INJ tokenfactory denom creation fee, plus gas, plus
 * whatever opening buy is asked for. Run `dry-run-create.mjs` first; it simulates
 * this for free, and the fee is charged in the same transaction that would fail.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrivateKey, MsgBroadcasterWithPk } from '@injectivelabs/sdk-ts';
// Network lives in its own package, not in sdk-ts. deploy.mjs already imports it
// from here; the SDK re-exports almost everything else, which is what made the
// wrong guess look reasonable.
import { Network, getNetworkEndpoints } from '@injectivelabs/networks';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', 'app');

function die(msg, hint) {
  console.error(`\n  ✗ ${msg}`);
  if (hint) console.error(`    ${hint}\n`);
  process.exit(1);
}

/** `KEY=value` lines from a file, without overwriting anything already set. */
function loadEnv(path, { secret = false } = {}) {
  if (!existsSync(path)) return;
  // Same permission refusal as deploy.mjs for the file that holds a seed phrase:
  // 0644 is readable by every account on the machine, and a seed cannot be rotated.
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
// Before the app's modules are imported: they read `NEXT_PUBLIC_*` at module scope.
loadEnv(join(APP, '.env.local'));

const mnemonic = process.env.INJ_MNEMONIC?.trim();
if (!mnemonic) die('No INJ_MNEMONIC.', 'Put it in scripts/.env.local, chmod 600, and re-run.');

const factory = process.env.NEXT_PUBLIC_FACTORY_ADDRESS?.trim();
if (!factory) die('No factory address.', 'Set NEXT_PUBLIC_FACTORY_ADDRESS in app/.env.local.');

// Node strips the types; the app's modules import each other with explicit `.ts`
// extensions, which is what makes this work without a bundler.
const { planLaunch, describePlan } = await import(join(APP, 'src/lib/createLaunch.ts'));
const { composeMessages } = await import(join(APP, 'src/lib/broadcast.ts'));
const { fixedCurveFor, FIXED_LP_RESERVE } = await import(join(APP, 'src/lib/launchLimits.ts'));
const { NETWORK } = await import(join(APP, 'src/lib/config.ts'));
const { factoryLaunchFee } = await import(join(APP, 'src/lib/chain.ts'));

const rewardRoute = (process.env.INJ_REWARD_ROUTE ?? 'creator').toLowerCase();
if (!['creator', 'pool'].includes(rewardRoute)) {
  die(`INJ_REWARD_ROUTE must be "creator" or "pool", not ${rewardRoute}`);
}
const symbol = (process.argv[2] ?? `TEST${Date.now().toString().slice(-4)}`).toUpperCase();
const openingBuyQuote = Number(process.argv[3] ?? 0);

const privateKey = PrivateKey.fromMnemonic(mnemonic);
const sender = privateKey.toBech32();
const network = NETWORK.name === 'mainnet' ? Network.Mainnet : Network.Testnet;

const curve = { ...fixedCurveFor(NETWORK.quoteDecimals), feeBps: 100n };
const initialBuy = BigInt(Math.round(openingBuyQuote * 10 ** NETWORK.quoteDecimals));

/*
 * The launchpad's own charge, read from the factory rather than assumed. The app
 * does exactly this; a script that hardcoded zero would pass on a free testnet and
 * fail on a configured mainnet, which is the wrong way round for a script whose job
 * is to catch that before a creator does.
 */
const launchFee = await factoryLaunchFee();
if (launchFee.amount > 0n) {
  console.log(`  launchpad fee: ${Number(launchFee.amount) / 1e18} ${launchFee.denom}`);
}

let plan;
try {
  plan = planLaunch({
    creator: sender,
    symbol,
    name: symbol,
    description: 'Created by scripts/create-test-launch.mjs to verify the contracts.',
    /*
     * Stored on the FACTORY as well as in bank metadata, which is the only copy the
     * app can read back: Injective answers a per-denom `denoms_metadata` with 501.
     */
    profile: {
      description:
        'A test launch for Vetta. Fixed supply, one bonding curve, liquidity that locks itself at graduation.',
    },
    /*
     * THE ROUTE WAS NOT SETTABLE, SO ONE OF THE TWO WAS UNTESTABLE. `planLaunch` has
     * taken `rewardRoute` for a while and this script never passed it, so every launch
     * it has ever made was creator-routed - and the pool route is the half that carried
     * "a pool-routed launch stranded the creator's share on every trade after
     * graduation". A script whose job is verifying the contracts could not reach the
     * branch the bug was in.
     */
    ...(rewardRoute !== 'creator' ? { rewardRoute } : {}),
    curve,
    lpReserve: FIXED_LP_RESERVE,
    factory,
    ...(initialBuy > 0n ? { initialBuy } : {}),
    ...(launchFee.amount > 0n ? { launchFee } : {}),
  });
} catch (e) {
  // The app's own validation, reached before anything is signed, which is the whole
  // reason it lives in a pure function: this is the same refusal the form would show.
  die(`The launch is invalid (${e.field ?? 'input'}).`, e.message);
}

console.log(`\n  Creating a launch on ${factory}`);
console.log(`  network: ${NETWORK.name}`);
console.log(`  signer:  ${sender}`);
console.log(`  denom:   ${plan.denom}`);
if (initialBuy > 0n) console.log(`  opening buy: ${openingBuyQuote} ${NETWORK.quoteSymbol}`);
console.log('');
// The same sentences the create page shows before signing, from the same function,
// so what this script does is readable without reading the message list.
for (const line of describePlan(plan, curve, FIXED_LP_RESERVE, initialBuy)) {
  console.log(`    - ${line}`);
}

try {
  const res = await new MsgBroadcasterWithPk({
    privateKey,
    network,
    endpoints: getNetworkEndpoints(network),
  }).broadcast({ msgs: composeMessages(plan, sender) });

  /*
   * A 200 is not a landed transaction. The broadcaster resolves with the chain's own
   * `code`, and anything but zero is a refusal that arrived looking like a success.
   */
  if (res.code !== 0) {
    die(`The chain refused it (code ${res.code}).`, res.rawLog);
  }
  console.log(`\n  ✓ launched. tx ${res.txHash}`);
  console.log(`  ${NETWORK.explorer}/transaction/${res.txHash}`);
  console.log(`\n  The board should show it: https://injpad.vercel.app/\n`);
} catch (e) {
  die('Broadcast failed.', e?.originalMessage ?? e?.message ?? String(e));
}
