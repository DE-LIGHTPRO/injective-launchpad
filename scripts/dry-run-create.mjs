/**
 * Simulate a real launch against the deployed factory, without broadcasting.
 *
 * WHY. Injective charges a 1 INJ tokenfactory fee on `MsgCreateDenom`, and a
 * message-shape mistake fails AFTER that fee is taken. With a 24-hour faucet
 * cooldown, one bad create costs a day. A simulate runs the same messages through
 * the same deployed contract and reports what would happen, for free.
 *
 * IT BUILDS THE MESSAGES FROM THE APP'S OWN CODE, and that is the whole point.
 * This script used to restate them: five hand-written SDK messages and a
 * `create_launch` payload of `{ denom, fee_bps }`. By the time the contract had
 * grown separate sell fees, reward routes, quote selection, profiles and rules,
 * the app was building a message this script had never simulated, and the script
 * was simulating a message the app no longer builds. It also silently omitted
 * `MsgChangeAdmin` entirely, so every run failed inside the factory's reply with
 * `unauthorized account` and the failure looked like a contract bug.
 *
 * So it imports `planLaunch` and `composeMessages` from `app/src/lib`. There is
 * exactly one definition of what a launch transaction is, and this measures it.
 * `assertPlanIsWhole` below fails loudly if the plan stops containing the admin
 * handover, because that is the step whose absence produced the confusing error.
 *
 *   node scripts/dry-run-create.mjs
 *
 * Needs INJ_MNEMONIC in scripts/.env.local (chmod 600), the same as deploy.mjs.
 * Nothing is broadcast and nothing is spent, so it does not need a funded wallet
 * beyond whatever the node wants to see to simulate at all.
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
/*
 * The app's own configuration, read before the app's modules are imported: they
 * read `NEXT_PUBLIC_*` at module scope, so this simulates against whatever the
 * deployed app is pointed at rather than against a factory restated here.
 */
loadEnv(join(APP, '.env.local'));

const mnemonic = process.env.INJ_MNEMONIC?.trim();
if (!mnemonic) die('No INJ_MNEMONIC.', 'Put it in scripts/.env.local, chmod 600, and re-run.');

const factory = process.env.NEXT_PUBLIC_FACTORY_ADDRESS?.trim();
if (!factory) die('No NEXT_PUBLIC_FACTORY_ADDRESS.', 'Set it in app/.env.local.');

/*
 * Node strips the types; the app's modules import each other with explicit `.ts`
 * extensions, which is what makes this work without a bundler. Imported after the
 * environment is loaded, for the reason above.
 */
const { planLaunch, MSG_CHANGE_ADMIN, MSG_EXECUTE } = await import(
  join(APP, 'src/lib/createLaunch.ts')
);
const { composeMessages } = await import(join(APP, 'src/lib/broadcast.ts'));
const { fixedCurveFor, FIXED_LP_RESERVE, MAX_FEE_BPS } = await import(
  join(APP, 'src/lib/launchLimits.ts')
);
const { NETWORK } = await import(join(APP, 'src/lib/config.ts'));

const privateKey = PrivateKey.fromMnemonic(mnemonic);
const sender = privateKey.toBech32();
const network = NETWORK.name === 'mainnet' ? Network.Mainnet : Network.Testnet;
const broadcaster = new MsgBroadcasterWithPk({ privateKey, network, simulateTx: true });

console.log(`\n  network  ${NETWORK.name}`);
console.log(`  factory  ${factory}`);
console.log(`  signer   ${sender}`);

const rest = getNetworkEndpoints(network).rest;
/*
 * `by_denom`, not the whole-account query with a find().
 *
 * The plural endpoint pages at 100 denoms and IGNORES a bare `limit` (it wants
 * `pagination.limit` - the tx endpoint is the other way round, measured 16 Oct 2026).
 * A real Injective account collects tokenfactory denoms, IBC assets and airdrops, so
 * `inj` falling off the first page is ordinary, and `find()` then yields undefined and
 * the `?? '0'` prints `balance 0.000000 INJ`. That is the worst direction for this
 * number to be wrong in: a dry run before a mainnet launch telling the operator their
 * funded signer is empty. One denom asked for by name cannot be paged out.
 */
const bal = await fetch(`${rest}/cosmos/bank/v1beta1/balances/${sender}/by_denom?denom=inj`).then(
  (r) => r.json(),
);
const inj = BigInt(bal.balance?.amount ?? '0');
console.log(`  balance  ${(Number(inj) / 1e18).toFixed(6)} INJ`);

/**
 * The plan still contains every step a launch needs.
 *
 * `MsgChangeAdmin` is named explicitly because its absence is not a shape error:
 * the first four messages succeed, the factory's reply tries to hand the denom's
 * mint key to the curve, and the chain answers `unauthorized account` from inside
 * a reply handler. That reads as a broken contract. It is a missing message.
 */
function assertPlanIsWhole(plan) {
  const urls = plan.messages.map((m) => m.typeUrl);
  for (const required of [MSG_CHANGE_ADMIN, MSG_EXECUTE]) {
    if (!urls.includes(required)) {
      die(
        `The launch plan has no ${required}.`,
        'A simulate without it fails inside the factory reply and looks like a contract bug.',
      );
    }
  }
  if (urls.indexOf(MSG_CHANGE_ADMIN) > urls.indexOf(MSG_EXECUTE)) {
    die('The admin handover is ordered AFTER the execute.', 'The factory must be admin before it runs.');
  }
}

/** A launch the app could actually produce, with a ticker nothing else can collide with. */
function buildPlan({ label, quoteDenom, extras = {} }) {
  const quoteDecimals = quoteDenom === NETWORK.quoteDenom ? NETWORK.quoteDecimals : 6;
  const curve = { ...fixedCurveFor(quoteDecimals), feeBps: 100n };
  const plan = planLaunch({
    creator: sender,
    symbol: `DRY${label}${Math.floor(Math.random() * 900 + 100)}`,
    name: `Dry run ${label}`,
    description: 'Simulated. Never broadcast.',
    curve,
    lpReserve: FIXED_LP_RESERVE,
    factory,
    quoteDenom,
    ...extras,
  });
  assertPlanIsWhole(plan);
  return plan;
}

/** Simulate, and report how far the chain got rather than only pass/fail. */
async function simulate(title, plan) {
  const msgs = composeMessages(plan, sender);
  process.stdout.write(`\n  ${title}: ${msgs.length} messages… `);
  try {
    const sim = await broadcaster.simulate({ msgs });
    const gas = sim?.gasInfo?.gasUsed ?? sim?.result?.gasUsed ?? 'unknown';
    console.log(`✓ accepted (gas ${gas})`);
    return true;
  } catch (e) {
    const m = String(e?.message ?? e);
    console.log('✗ refused');
    console.log(`    ${m.slice(0, 400)}`);
    /*
     * An honest reading of WHERE it failed. `message index: N` is the message the
     * chain was running, and anything at index 0 means the denom fee stopped it
     * before the factory was ever reached, so the run says nothing about shape.
     */
    const idx = m.match(/message index: (\d+)/)?.[1];
    if (idx !== undefined) {
      const at = plan.messages[Number(idx)]?.typeUrl ?? 'unknown';
      console.log(`    failed at message ${idx} of ${plan.messages.length}: ${at}`);
      if (Number(idx) === 0) {
        console.log(`    Message 0 is the 1 INJ denom fee, so the factory was never`);
        console.log(`    reached. This run does NOT clear the message shape.`);
      }
    }
    if (/unknown field|missing field|unknown variant|invalid type|parse/i.test(m)) {
      console.log(`    MESSAGE SHAPE MISMATCH. This is the failure that costs 1 INJ.`);
    }
    return false;
  }
}

/*
 * TWO SHAPES, because the optional fields are the ones a deployed factory can be
 * too old to understand. The plain launch omits them and an older factory accepts
 * it; the maximal one sends every field the create form can produce, so a factory
 * that predates them is caught here rather than after the denom fee is charged.
 *
 * `fee_sell_bps` is set to the cap deliberately: the contract refuses anything
 * above `MAX_FEE_BPS`, so this also proves the cap is deployed and that the
 * boundary value itself is allowed.
 */
const plain = buildPlan({ label: 'A', quoteDenom: NETWORK.quoteDenom });
const maximal = buildPlan({
  label: 'B',
  quoteDenom: NETWORK.quoteDenom,
  extras: {
    feeSellBps: MAX_FEE_BPS,
    rewardRoute: 'pool',
    profile: { image: 'https://example.com/logo.png', website: 'https://example.com' },
    rules: { max_per_wallet: (10n ** 24n).toString() },
  },
});

const results = [
  await simulate('plain launch', plain),
  await simulate('every optional field', maximal),
];

if (results.every(Boolean)) {
  console.log(`\n  ✓ The deployed factory accepts what the app builds, in both shapes.`);
  console.log(`    The only thing between this and a real launch is the 1 INJ denom fee.\n`);
} else {
  console.log(`\n  ✗ At least one shape would fail AFTER the 1 INJ fee was charged.\n`);
  process.exit(1);
}
