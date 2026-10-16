/**
 * The whole lifecycle of a launch, on Injective testnet, against the deployed bytes.
 *
 *   node scripts/e2e-testnet.mjs
 *
 * Runs after `deploy.mjs`, with the same `scripts/.env.local` (chmod 600) and the new
 * factory in `NEXT_PUBLIC_FACTORY_ADDRESS` (env, or app/.env.local). Every contract test
 * already asserts these properties in cw-multi-test; what none of them can assert is
 * that the DEPLOYED wasm does, on a real chain, with real tokenfactory denoms and gas.
 *
 * WHY IT MINTS ITS OWN QUOTE. Graduating an INJ launch takes ~87 INJ, more than a
 * testnet faucet hands out. So the script creates a 6-decimal test dollar under the
 * signer's own tokenfactory namespace, allowlists it on the factory (the signer is the
 * factory admin after `deploy.mjs`), and runs the launch priced in it. That costs two
 * 1 INJ denom-creation fees plus gas, and it exercises the non-18-decimal quote path
 * the USDC support exists for. It also makes every check EXACT: gas is paid in INJ, so
 * balances in the test dollar move only by what the contracts did.
 *
 * Steps, each asserted rather than printed:
 *   1  chain id is testnet, signer is the factory admin
 *   2  test quote exists, is funded, is allowlisted with 6 decimals
 *   3  launch created; curve has NO wasm admin, runs the factory's curve code id, and
 *      holds the denom's mint key (so no one can ever mint more)
 *   4  curve buy and sell settle exactly what SimulateBuy / SimulateSell quoted
 *   5  an oversized buy graduates: partial fill, refund, pool seeded in the same tx
 *   6  contract holds exactly pool + owed fees, and exactly pool_tokens
 *   7  pool buy and sell settle exactly what was quoted
 *   8  Graduate {} is refused (already seeded); ClaimFees pays both sides
 *
 * Exit code 0 only if every step held.
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
import { Network, getNetworkEndpoints } from '@injectivelabs/networks';

const HERE = dirname(fileURLToPath(import.meta.url));

function die(msg, ...hints) {
  console.error(`\n  ✗ ${msg}`);
  for (const h of hints) if (h) console.error(`    ${h}`);
  console.error('');
  process.exit(1);
}
const ok = (msg) => console.log(`  ✓ ${msg}`);
const step = (n, msg) => console.log(`\n[${n}] ${msg}`);

// Same loader and the same permission refusal as deploy.mjs.
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
const rawKey = process.env.INJ_PRIVATE_KEY?.trim();
if (!mnemonic && !rawKey) die('No INJ_MNEMONIC or INJ_PRIVATE_KEY.', 'Put one in scripts/.env.local, chmod 600.');

const appEnv = join(HERE, '..', 'app', '.env.local');
const factory =
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS?.trim() ||
  (existsSync(appEnv)
    ? readFileSync(appEnv, 'utf8')
        .split('\n')
        .find((l) => l.startsWith('NEXT_PUBLIC_FACTORY_ADDRESS='))
        ?.split('=')[1]
        ?.trim()
    : undefined);
if (!factory) die('No factory address.', 'Set NEXT_PUBLIC_FACTORY_ADDRESS (env or app/.env.local).');

const privateKey = mnemonic ? PrivateKey.fromMnemonic(mnemonic) : PrivateKey.fromHex(rawKey.replace(/^0x/, ''));
const sender = privateKey.toBech32();
const network = Network.Testnet;
const endpoints = getNetworkEndpoints(network);
const rest = endpoints.rest;
const broadcaster = new MsgBroadcasterWithPk({ privateKey, network, endpoints, simulateTx: true });

const USD_SUB = 'e2eusd';
const USD = `factory/${sender}/${USD_SUB}`;
const USD_ONE = 10n ** 6n;
const TOKEN_ONE = 10n ** 18n;
const SEED = 1_000_000_000n * TOKEN_ONE; // the factory's fixed supply
const symbol = `E2E${Date.now().toString().slice(-5)}`;
const denom = `factory/${sender}/${symbol}`;

// ------------------------------------------------------------------ chain I/O --

async function getJson(path) {
  const r = await fetch(`${rest}${path}`);
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}
async function smart(addr, q) {
  const b64 = Buffer.from(JSON.stringify(q)).toString('base64');
  const { status, body } = await getJson(`/cosmwasm/wasm/v1/contract/${addr}/smart/${b64}`);
  if (status !== 200) die(`query ${Object.keys(q)[0]} on ${addr} failed (${status})`, JSON.stringify(body).slice(0, 300));
  return body.data;
}
async function bal(addr, d) {
  const { body } = await getJson(`/cosmos/bank/v1beta1/balances/${addr}?pagination.limit=500`);
  return BigInt(body.balances?.find((b) => b.denom === d)?.amount ?? '0');
}
async function send(msgs, label) {
  try {
    const res = await broadcaster.broadcast({ msgs });
    if (res.code !== 0) die(`${label}: chain refused (code ${res.code})`, res.rawLog);
    console.log(`    ${label}: ${res.txHash}`);
    return res;
  } catch (e) {
    die(`${label}: broadcast failed`, e?.originalMessage ?? e?.message ?? String(e));
  }
}
async function expectRefused(msgs, label) {
  try {
    const res = await broadcaster.broadcast({ msgs });
    if (res.code === 0) die(`${label} was ACCEPTED and should have been refused`, res.txHash);
  } catch {
    /* refused at simulate, which is the expected outcome */
  }
  ok(`${label} refused, as it must be`);
}
const exec = (contract, msg, funds = []) =>
  MsgExecuteContract.fromJSON({ sender, contractAddress: contract, msg, funds });
const eq = (got, want, what) => {
  if (BigInt(got) !== BigInt(want)) die(`${what}: got ${got}, expected ${want}`);
};

// ---------------------------------------------------------------------- run --

step(1, 'Preflight');
const node = await getJson('/cosmos/base/tendermint/v1beta1/node_info');
const chainId = node.body?.default_node_info?.network;
if (chainId !== 'injective-888') die(`Expected injective-888, the node says ${chainId}.`);
ok(`chain ${chainId}`);
const fcfg = await smart(factory, { config: {} });
/*
 * What this factory charges to create a launch, if anything. Read rather than
 * assumed, so the script works against a free factory and a charging one alike.
 */
const launchFee = BigInt(fcfg.launch_fee ?? '0');
const launchFeeDenom = fcfg.launch_fee_denom || fcfg.quote_denom;
if (launchFee > 0n) {
  ok(`launchpad charges ${Number(launchFee) / 1e18} ${launchFeeDenom} to create a launch`);
}
if (fcfg.admin !== sender) {
  die(
    `Signer ${sender} is not the factory admin (${fcfg.admin}).`,
    'This script allowlists its own test quote, which only the admin can do.',
  );
}
ok(`signer ${sender} is factory admin; curve code id ${fcfg.curve_code_id}`);
if ((await bal(sender, 'inj')) < 3n * TOKEN_ONE) {
  die('Signer holds under 3 INJ.', 'Two 1 INJ denom-creation fees plus gas. Use the testnet faucet.');
}

step(2, `Test quote ${USD}`);
const supply = await getJson(`/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(USD)}`);
const exists = BigInt(supply.body?.amount?.amount ?? '0') > 0n;
/*
 * ENOUGH TO GRADUATE AT WHATEVER SCALE THIS QUOTE IS SET TO, derived rather than
 * hardcoded. It was a flat 1,000, which graduated a curve whose target was 170 and
 * silently became too little the moment the opening reserve was rescaled: the run
 * got all the way to step 5 and reported that an oversized buy did not graduate,
 * which reads as a contract bug and is a stale constant in the test.
 *
 * Mainnet WILL re-derive the scale (see docs/MAINNET-RUNBOOK.md), so a script that
 * only works at one scale is a script that stops working on the day it matters.
 */
const quoteSpec = (await smart(factory, { quotes: {} })).quotes.find((q) => q.denom === USD);
const quoteWhole = BigInt(quoteSpec?.virtual_quote_whole ?? '676');
// graduation is 17/6 of the opening reserve; double it, for the buy plus the
// earlier steps' spending and a margin.
const needUsd = ((quoteWhole * 17n) / 6n) * 2n * USD_ONE;
if ((await bal(sender, USD)) < needUsd) {
  const msgs = [];
  if (!exists) msgs.push(MsgCreateDenom.fromJSON({ sender, subdenom: USD_SUB }));
  msgs.push(MsgMint.fromJSON({ sender, amount: { denom: USD, amount: needUsd.toString() } }));
  await send(msgs, exists ? 'mint test quote' : 'create + mint test quote');
}
const { quotes } = await smart(factory, { quotes: {} });
if (!quotes.some((q) => q.denom === USD && q.decimals === 6)) {
  /*
   * `virtual_quote_whole` is the opening reserve in whole units of THIS asset, and
   * it is required: one constant cannot be right for both INJ and a dollar. 676
   * opens an INJ launch at about $5,000; the same number against a dollar
   * stablecoin opens one at about $630, so a dollar quote is scaled by the INJ
   * price it was derived at (7.92 on 11 Oct 2026). Running the lifecycle against a
   * properly scaled second quote is the point: it is the path a mainnet USDC pair
   * would take, and nothing else exercises it.
   */
  await send(
    exec(factory, {
      set_quote: { denom: USD, decimals: 6, virtual_quote_whole: '5354', symbol: 'E2EUSD' },
    }),
    'allowlist test quote',
  );
}
ok('test quote funded and allowlisted at 6 decimals');

step(3, `Create launch ${symbol}`);
await send(
  [
    MsgCreateDenom.fromJSON({ sender, subdenom: symbol }),
    MsgMint.fromJSON({ sender, amount: { denom, amount: SEED.toString() } }),
    MsgSetDenomMetadata.fromJSON({
      sender,
      metadata: {
        description: 'Created by scripts/e2e-testnet.mjs',
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
    MsgChangeAdmin.fromJSON({ sender, denom, newAdmin: factory }),
    exec(
      factory,
      { create_launch: { denom, fee_bps: 100, quote_denom: USD } },
      /*
       * THE LAUNCHPAD'S OWN FEE, read from the factory rather than assumed absent.
       * This script restated the funds and went stale the moment a launch fee could
       * be configured: it would pass on a free testnet and fail on a configured
       * mainnet, which is the wrong way round for the script that exists to prove
       * the lifecycle before mainnet. The same staleness bit
       * `create-test-launch.mjs` an hour earlier.
       *
       * The fee's denom is INJ and the launch is priced in the test dollar, so the
       * two are separate coins here and do not merge. On an INJ-priced launch they
       * would arrive as one, which is why the factory splits by subtraction.
       */
      [
        { denom, amount: SEED.toString() },
        ...(launchFee > 0n ? [{ denom: launchFeeDenom, amount: launchFee.toString() }] : []),
      ],
    ),
  ],
  'create launch',
);
const launch = await smart(factory, { launch_by_denom: { denom } });
const curve = launch.curve;
ok(`curve ${curve}`);
const info = (await getJson(`/cosmwasm/wasm/v1/contract/${curve}`)).body?.contract_info;
if (info?.admin) die(`Curve has a wasm admin (${info.admin}); its liquidity is not locked.`);
ok('curve has no wasm admin: its code can never be replaced');
eq(info?.code_id, fcfg.curve_code_id, 'curve code id');
ok(`curve runs code id ${info.code_id}, the factory's`);
const authority = (
  // Injective's route takes creator and subdenom as two path segments, not the whole
  // `factory/...` denom: /denoms/{creator}/{sub_denom}/authority_metadata.
  await getJson(`/injective/tokenfactory/v1beta1/denoms/${sender}/${symbol}/authority_metadata`)
).body?.authority_metadata?.admin;
if (authority !== curve) {
  die(`Denom admin is ${authority}, not the curve.`, 'Whoever holds it can mint without limit.');
}
ok('the curve holds the mint key; the supply is fixed for good');

step(4, 'Curve buy and sell settle exactly what was quoted');
let spend = 5n * USD_ONE;
let sim = await smart(curve, { simulate_buy: { inj_in: spend.toString() } });
let t0 = await bal(sender, denom);
let u0 = await bal(sender, USD);
await send(exec(curve, { buy: { min_tokens_out: sim.tokens_out } }, [{ denom: USD, amount: spend.toString() }]), 'curve buy');
eq((await bal(sender, denom)) - t0, sim.tokens_out, 'tokens received');
eq(u0 - (await bal(sender, USD)), spend, 'quote spent');
ok(`bought ${sim.tokens_out} base units for 5 test USD, as quoted`);

const half = (await bal(sender, denom)) / 2n;
let sell = await smart(curve, { simulate_sell: { tokens_in: half.toString() } });
u0 = await bal(sender, USD);
await send(exec(curve, { sell: { min_inj_out: sell.inj_out } }, [{ denom, amount: half.toString() }]), 'curve sell');
eq((await bal(sender, USD)) - u0, sell.inj_out, 'quote received on sell');
ok(`sold half for ${sell.inj_out} test-USD units, as quoted`);

step(5, 'An oversized buy graduates and seeds the pool in the same transaction');
/*
 * DERIVED FROM THE CURVE, not a constant. Enough to pass the graduation target from
 * wherever this curve has got to, plus a margin so the buy is genuinely oversized
 * and the partial fill and refund are exercised rather than landing exactly on the
 * line. A hardcoded figure here is a test that passes at one scale and reports a
 * contract bug at any other.
 */
const gradCfg = await smart(curve, { config: {} });
const gradState = await smart(curve, { state: {} });
const remaining =
  BigInt(gradCfg.curve.graduation_target) - BigInt(gradState.inj_collected);
spend = (remaining * 12n) / 10n + USD_ONE;
sim = await smart(curve, { simulate_buy: { inj_in: spend.toString() } });
if (!sim.graduates) {
  die(
    `A ${Number(spend) / Number(USD_ONE)} test-USD buy did not graduate the curve.`,
    JSON.stringify(sim),
  );
}
u0 = await bal(sender, USD);
t0 = await bal(sender, denom);
await send(exec(curve, { buy: { min_tokens_out: sim.tokens_out } }, [{ denom: USD, amount: spend.toString() }]), 'graduating buy');
eq((await bal(sender, denom)) - t0, sim.tokens_out, 'tokens on graduating buy');
eq(u0 - (await bal(sender, USD)), spend - BigInt(sim.refund), 'quote spent net of refund');
ok(`partial fill with a refund of ${sim.refund}`);
let st = await smart(curve, { state: {} });
if (!st.graduated || !st.migrated) die('Graduated buy did not seed the pool.', JSON.stringify(st));
ok(`pool seeded: ${st.pool_quote} quote units against ${st.pool_tokens} token units`);

step(6, 'Exact accounting: nothing stranded, nothing leaked');
eq(await bal(curve, USD), BigInt(st.pool_quote) + BigInt(st.creator_owed) + BigInt(st.platform_owed), 'contract quote balance');
eq(await bal(curve, denom), st.pool_tokens, 'contract token balance');
ok('contract holds exactly pool + owed fees, and exactly the pool tokens');

step(7, 'The locked pool trades, and settles exactly what was quoted');
spend = 3n * USD_ONE;
sim = await smart(curve, { simulate_buy: { inj_in: spend.toString() } });
t0 = await bal(sender, denom);
await send(exec(curve, { buy: { min_tokens_out: sim.tokens_out } }, [{ denom: USD, amount: spend.toString() }]), 'pool buy');
eq((await bal(sender, denom)) - t0, sim.tokens_out, 'tokens from pool buy');
const exit = (await bal(sender, denom)) / 3n;
sell = await smart(curve, { simulate_sell: { tokens_in: exit.toString() } });
u0 = await bal(sender, USD);
await send(exec(curve, { sell: { min_inj_out: sell.inj_out } }, [{ denom, amount: exit.toString() }]), 'pool sell');
eq((await bal(sender, USD)) - u0, sell.inj_out, 'quote from pool sell');
st = await smart(curve, { state: {} });
eq(await bal(curve, USD), BigInt(st.pool_quote) + BigInt(st.creator_owed) + BigInt(st.platform_owed), 'contract quote balance after pool trades');
ok('pool buy and sell exact; accounting still exact');

step(8, 'Fallbacks and fees');
await expectRefused(exec(curve, { graduate: {} }), 'a second seeding (Graduate {})');
const ccfg = await smart(curve, { config: {} });
const owedC = BigInt(st.creator_owed);
const owedP = BigInt(st.platform_owed);
const c0 = await bal(ccfg.creator, USD);
const p0 = await bal(ccfg.platform, USD);
await send(exec(curve, { claim_fees: {} }), 'claim fees');
const after = await smart(curve, { state: {} });
eq(after.creator_owed, 0n, 'creator_owed after claim');
eq(after.platform_owed, 0n, 'platform_owed after claim');
if (ccfg.creator === ccfg.platform) {
  eq((await bal(ccfg.creator, USD)) - c0, owedC + owedP, 'creator+platform payout');
} else {
  eq((await bal(ccfg.creator, USD)) - c0, owedC, 'creator payout');
  eq((await bal(ccfg.platform, USD)) - p0, owedP, 'platform payout');
}
ok(`fees paid: creator ${owedC}, platform ${owedP} (70/30)`);

console.log(`
  All 8 steps held against the deployed contracts.

  launch   ${symbol}  (${denom})
  curve    ${curve}
  explorer https://testnet.injscan.com/contract/${curve}
`);
