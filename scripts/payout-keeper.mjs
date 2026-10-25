/**
 * Pay every launch's accrued fees out to its creator and to the platform.
 *
 *   node scripts/payout-keeper.mjs            # sweep once
 *   node scripts/payout-keeper.mjs --dry-run  # report what it would pay, send nothing
 *
 * Run it on a schedule (cron, a systemd timer, a Vercel cron hitting a function)
 * for payouts every fifteen minutes. See `docs/PAYOUT-KEEPER.md`.
 *
 * WHY THIS IS A SCRIPT AND NOT A CONTRACT FEATURE. A CosmWasm contract cannot
 * schedule itself. There is no on-chain timer on Injective: a contract only ever
 * runs because somebody sent it a message, so "every fifteen minutes" has to come
 * from outside the chain. The two honest ways to do it are paying out inside every
 * trade, which charges every trader gas for somebody else's payout and makes a
 * blocked recipient break trading for everyone, or a keeper like this one. This is
 * the keeper.
 *
 * WHY IT IS SAFE TO RUN UNATTENDED, which is the same reason `claim_fees` checks no
 * sender in the first place. The contract pays the creator and the platform at the
 * addresses stored when the launch was created. This wallet cannot redirect a
 * single unit of it; all it can do is pay the gas to make the transfer happen. So
 * the worst a compromised keeper key does is waste its own gas, and the money still
 * lands where it was always going to land. A keeper that could choose the recipient
 * would be a different proposition entirely and is not what this is.
 *
 * It needs INJ_MNEMONIC in scripts/.env.local (chmod 600) and a little INJ for gas.
 * That wallet should hold gas and nothing else.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrivateKey, MsgExecuteContract, MsgBroadcasterWithPk } from '@injectivelabs/sdk-ts';
import { Network, getNetworkEndpoints, getNetworkChainInfo } from '@injectivelabs/networks';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', 'app');
const DRY = process.argv.includes('--dry-run');

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
if (!mnemonic && !DRY) die('No INJ_MNEMONIC.', 'Put it in scripts/.env.local, chmod 600.');

const factory = process.env.NEXT_PUBLIC_FACTORY_ADDRESS?.trim();
if (!factory) die('No NEXT_PUBLIC_FACTORY_ADDRESS.');

/*
 * TESTNET IS THE DEFAULT AND IT IS THE RIGHT DEFAULT, which is exactly what makes
 * this worth checking rather than trusting. `network` is not only which LCD to read:
 * it is the chain the broadcaster signs for (see MsgBroadcasterWithPk below). The
 * runbook's step 10 sets NEXT_PUBLIC_NETWORK, NEXT_PUBLIC_FACTORY_ADDRESS and
 * NEXT_PUBLIC_LCD_URL as three separate `gh variable set` commands, so missing the
 * first one leaves a mainnet factory and a mainnet LCD pointed at a testnet
 * broadcaster. Nothing would be mispaid - a testnet signature cannot reach a mainnet
 * contract - but the sweep would fail every fifteen minutes, unattended, reporting
 * "the factory could not be read", which sends the reader to look at the factory.
 */
const network = process.env.NEXT_PUBLIC_NETWORK === 'mainnet' ? Network.Mainnet : Network.Testnet;
const rest = process.env.NEXT_PUBLIC_LCD_URL?.trim() || getNetworkEndpoints(network).rest;
const expectedChainId = getNetworkChainInfo(network).chainId;

const smart = async (addr, q) => {
  const b64 = Buffer.from(JSON.stringify(q)).toString('base64');
  const res = await fetch(`${rest}/cosmwasm/wasm/v1/contract/${addr}/smart/${b64}`);
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
  return (await res.json()).data;
};

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
console.log(`\n  [${stamp()}] payout keeper${DRY ? ' (dry run)' : ''}`);
console.log(`  factory ${factory}`);
console.log(`  ${expectedChainId} via ${rest}`);

/*
 * ASK THE ENDPOINT WHICH CHAIN IT IS, rather than inferring it from the variable that
 * chose it. One request, before anything is read and well before anything is signed,
 * and it is the only thing here that can tell a mainnet LCD from a testnet one. A
 * disagreement means the reads and the broadcast are aimed at different chains, and
 * the honest answer is to refuse: continuing reports a factory problem for a
 * configuration one.
 *
 * It must not fail closed on an unreachable endpoint, because that is the same thing
 * the read below already reports, with a better message. An unanswered probe yields
 * no opinion.
 */
const served = await fetch(`${rest}/cosmos/base/tendermint/v1beta1/node_info`, {
  signal: AbortSignal.timeout(15_000),
})
  .then((r) => (r.ok ? r.json() : null))
  .then((j) => j?.default_node_info?.network ?? null)
  .catch(() => null);

if (served && served !== expectedChainId) {
  die(
    `${rest} is ${served}, but this keeper signs for ${expectedChainId}.`,
    `NEXT_PUBLIC_NETWORK is ${process.env.NEXT_PUBLIC_NETWORK ? `"${process.env.NEXT_PUBLIC_NETWORK}"` : 'unset, so it defaults to testnet'}. It and NEXT_PUBLIC_LCD_URL are set separately and must name the same chain.`,
  );
}

// ------------------------------------------------------------ what is owed --

const launches = (await smart(factory, { launches: { limit: 100 } }).catch((e) => {
  die('The factory could not be read.', e.message);
})).launches;

/*
 * READ EVERY LAUNCH'S STATE BEFORE SENDING ANYTHING. A `claim_fees` on a curve with
 * nothing owed is refused with "nothing to claim", and in one batched transaction
 * that single refusal reverts every other claim with it. Filtering first is what
 * makes the sweep idempotent: running it twice in a row does nothing the second
 * time rather than failing.
 */
const owing = [];
for (const l of launches) {
  try {
    const st = await smart(l.curve, { state: {} });
    const owed = BigInt(st.creator_owed ?? '0') + BigInt(st.platform_owed ?? '0');
    if (owed > 0n) {
      owing.push({ ...l, owed, creator: st.creator_owed, platform: st.platform_owed });
    }
  } catch (e) {
    // One unreadable curve must not stop the others being paid.
    console.log(`  ! ${l.curve} could not be read: ${String(e.message).slice(0, 80)}`);
  }
}

const sym = (d) => d.split('/').pop() ?? d;
const fmt = (v) => (Number(v) / 1e18).toFixed(6);

if (owing.length === 0) {
  console.log('  nothing owed on any launch.\n');
  process.exit(0);
}

console.log(`\n  ${owing.length} ${owing.length === 1 ? 'launch owes' : 'launches owe'}:`);
let total = 0n;
for (const l of owing) {
  total += l.owed;
  console.log(`    ${sym(l.denom).padEnd(12)} creator ${fmt(l.creator)}  platform ${fmt(l.platform)}`);
}
console.log(`    ${''.padEnd(12)} total   ${fmt(total)}`);

if (DRY) {
  console.log('\n  dry run: nothing was sent.\n');
  process.exit(0);
}

// ---------------------------------------------------------------- pay them --

const privateKey = PrivateKey.fromMnemonic(mnemonic);
const sender = privateKey.toBech32();
/*
 * SIMULATE, BECAUSE THE FEE IS CHARGED ON THE LIMIT AND NOT ON WHAT IS USED.
 *
 * Measured on the keeper's own first mainnet-shaped run, testnet tx
 * 7DE3C551…C22BDD: gas_wanted 550,000 against gas_used 253,005. The declared fee is
 * `gas_wanted x price` and is deducted in full - unused gas is never refunded, which
 * 56 consecutive MsgExecuteContract transactions confirmed - so this wallet was paying
 * roughly twice what its payouts cost, every run, forever.
 *
 * The flat limits below are where that came from: `300_000 + 250_000 * n` is sized for
 * the worst batch rather than the one being sent. They stay, because `getTxWithStdFee`
 * falls back to the supplied fee when a simulation fails or returns no gasUsed, so an
 * unreachable node degrades to the old behaviour instead of stopping the payouts. That
 * is the same asymmetry the app's signing path uses: simulation improves the common
 * case and never becomes a new way to fail.
 *
 * 1.5 rather than the SDK's default 1.1. A payout that runs out of gas costs the fee
 * and pays nobody, and this runs unattended with no one watching to retry it; the
 * margin is worth more here than the fraction of a cent it costs.
 */
const broadcaster = new MsgBroadcasterWithPk({
  privateKey,
  network,
  simulateTx: true,
  gasBufferCoefficient: 1.5,
});
console.log(`\n  keeper  ${sender}`);

const msgFor = (curve) =>
  MsgExecuteContract.fromJSON({ sender, contractAddress: curve, msg: { claim_fees: {} }, funds: [] });

/*
 * ONE TRANSACTION when it fits, because it is one fee and one atomic result. Capped,
 * because a batch's gas grows with its size and a transaction that exceeds the block
 * limit pays for the attempt and lands nothing.
 */
const BATCH = 20;
let paid = 0;
let failed = 0;

for (let i = 0; i < owing.length; i += BATCH) {
  const slice = owing.slice(i, i + BATCH);
  try {
    const res = await broadcaster.broadcast({
      msgs: slice.map((l) => msgFor(l.curve)),
      gas: { gas: 300_000 + 250_000 * slice.length },
    });
    if (res.code !== 0) throw new Error(res.rawLog ?? `code ${res.code}`);
    paid += slice.length;
    console.log(`  ✓ paid ${slice.length} in ${res.txHash}`);
  } catch (e) {
    /*
     * A BATCH IS ATOMIC, so one bad launch takes the rest of its batch down with it.
     * Falling back to one transaction each costs more gas and pays everybody it can,
     * which is the right trade for a keeper: the alternative is a single launch in a
     * strange state quietly stopping every other creator from being paid, every
     * fifteen minutes, until somebody notices.
     */
    console.log(`  ! batch of ${slice.length} failed, retrying individually`);
    for (const l of slice) {
      try {
        const res = await broadcaster.broadcast({ msgs: msgFor(l.curve), gas: { gas: 500_000 } });
        if (res.code !== 0) throw new Error(res.rawLog ?? `code ${res.code}`);
        paid += 1;
        console.log(`    ✓ ${sym(l.denom)} ${res.txHash}`);
      } catch (inner) {
        failed += 1;
        console.log(`    ✗ ${sym(l.denom)}: ${String(inner.message ?? inner).slice(0, 120)}`);
      }
    }
  }
}

console.log(`\n  paid ${paid}, failed ${failed}\n`);
// Non-zero only if something could not be paid, so a scheduler's own alerting fires
// on a real problem rather than on a quiet run with nothing to do.
process.exit(failed === 0 ? 0 : 1);
