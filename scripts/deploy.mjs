/**
 * Deploy the launchpad to Injective.
 *
 *   node scripts/deploy.mjs            # testnet
 *   node scripts/deploy.mjs --mainnet  # mainnet, needs a second flag too
 *
 * PUT THE KEY IN `scripts/.env.local`, NOT ON THE COMMAND LINE. This file used to
 * document `INJ_MNEMONIC="..." node deploy.mjs`, which is the one instruction here
 * that could lose someone their funds: an interactive shell writes that line to
 * `~/.zsh_history` in plaintext, where it stays indefinitely, is read by anything
 * that reads history, is synced by some dotfile setups, and is visible to `ps` while
 * the process runs. A seed phrase is not a password you can rotate.
 *
 * `scripts/.env.local` is matched by `.env*.local` in .gitignore, so it cannot be
 * committed, and the loader below refuses to read it if its permissions let anyone
 * else on the machine see it.
 *
 * Your key is read from there and never printed, written, or sent anywhere but the
 * signer. Nothing here logs it, not even on failure.
 *
 * Two habits carried over from the Arc launch:
 *
 *  - **Confirm the chain before broadcasting.** An inferred endpoint there had
 *    no DNS record at all and nobody checked until launch morning. This script
 *    asks the node what chain it is and aborts if the answer is not what was
 *    expected, so a wrong endpoint fails before it can cost gas.
 *
 *  - **Print every variable the app reads.** The Arc runbook was missing seven
 *    of them, and "launch is configuration" is only as true as the list someone
 *    works through. The block at the end is the complete set.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PrivateKey,
  MsgStoreCode,
  MsgInstantiateContract,
  MsgBroadcasterWithPk,
  ChainGrpcBankApi,
} from '@injectivelabs/sdk-ts';
import { Network, getNetworkEndpoints } from '@injectivelabs/networks';
import { createHash } from 'node:crypto';
import { loadEnvLocal } from './loadEnvLocal.mjs';
import {
  openingCapUsd, driftFrom, virtualQuoteFor, MAX_DRIFT, readQuotePrice,
} from './curveScale.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(HERE, '..', 'target', 'wasm32-unknown-unknown', 'release');

const EXPECTED_CHAIN_ID = { testnet: 'injective-888', mainnet: 'injective-1' };

const argv = process.argv.slice(2);
const wantMainnet = argv.includes('--mainnet');
const confirmedMainnet = argv.includes('--i-understand-this-is-real-money');

// Every hint line is printed. This took one `hint` while callers passed up to three,
// so the second and third lines of every multi-line refusal were silently dropped.
function die(msg, ...hints) {
  console.error(`\n  ✗ ${msg}`);
  for (const hint of hints) if (hint) console.error(`    ${hint}`);
  console.error('');
  process.exit(1);
}

function step(n, msg) {
  console.log(`\n  ${n}. ${msg}`);
}

// ---------------------------------------------------------------- network --

if (wantMainnet && !confirmedMainnet) {
  die(
    'Refusing to deploy to mainnet without an explicit confirmation.',
    'Re-run with --mainnet --i-understand-this-is-real-money',
  );
}

const netName = wantMainnet ? 'mainnet' : 'testnet';
const network = wantMainnet ? Network.Mainnet : Network.Testnet;
const endpoints = getNetworkEndpoints(network);
const expectedChainId = EXPECTED_CHAIN_ID[netName];

console.log(`\n  Injective launchpad deploy → ${netName}`);
console.log(`  rest: ${endpoints.rest}`);

// ---------------------------------------------------------------- the key --

/*
 * The loader moved to `loadEnvLocal.mjs`. It was private to this file, and
 * `mainnet-readiness.mjs` therefore could not see the configuration it exists to
 * report on - one piece of configuration with two readers, only one of which read it.
 */
loadEnvLocal(die);

const mnemonic = process.env.INJ_MNEMONIC?.trim();
const rawKey = process.env.INJ_PRIVATE_KEY?.trim();

if (!mnemonic && !rawKey) {
  /*
   * Says WHICH state it is in, because the three are fixed differently and the same
   * sentence for all of them is a setup guide rather than an error. The common one is
   * the third: the example was copied and the key line left as it came, so the file
   * exists, the permissions are right, and nothing says the one line that matters is
   * still blank.
   */
  const envPath = join(HERE, '.env.local');
  if (!existsSync(envPath)) {
    die(
      'No signing key found, and scripts/.env.local does not exist.',
      'cp scripts/.env.example scripts/.env.local && chmod 600 scripts/.env.local, then put your phrase on the INJ_MNEMONIC line.',
    );
  }
  die(
    'scripts/.env.local exists, but INJ_MNEMONIC and INJ_PRIVATE_KEY are both empty.',
    'Open it and put your phrase after INJ_MNEMONIC= on one line. Do not pass it on the command line: an interactive shell records that in ~/.zsh_history in plaintext.',
  );
}

let privateKey;
try {
  privateKey = mnemonic
    ? PrivateKey.fromMnemonic(mnemonic)
    : PrivateKey.fromHex(rawKey.replace(/^0x/, ''));
} catch {
  // Deliberately not echoing anything derived from the key material.
  die('That key could not be parsed.', 'Check the mnemonic wording or the hex key format.');
}

const sender = privateKey.toBech32();
console.log(`  signer: ${sender}`);

// ------------------------------------------------------- confirm the chain --

step(1, 'Confirming the node is the chain we think it is');
{
  const res = await fetch(`${endpoints.rest}/cosmos/base/tendermint/v1beta1/node_info`).catch(
    (e) => die(`Could not reach ${endpoints.rest}`, e.message),
  );
  if (!res.ok) die(`Node returned HTTP ${res.status} from ${endpoints.rest}`);
  const info = await res.json();
  const actual = info?.default_node_info?.network;
  if (actual !== expectedChainId) {
    die(
      `That endpoint reports chain "${actual}", not "${expectedChainId}".`,
      'Refusing to broadcast. An endpoint pointed at the wrong chain is how launches go wrong.',
    );
  }
  console.log(`     chain_id ${actual} ✓`);
}

// ------------------------------------------------------------- the balance --

step(2, 'Checking the signer can pay for this');
{
  const bank = new ChainGrpcBankApi(endpoints.grpc);
  let balance = '0';
  try {
    const res = await bank.fetchBalance({ accountAddress: sender, denom: 'inj' });
    balance = res?.amount ?? '0';
  } catch (e) {
    die('Could not read the signer balance.', e.message);
  }
  const inj = Number(balance) / 1e18;
  console.log(`     ${inj.toFixed(4)} INJ`);
  if (inj < 0.5) {
    die(
      `Only ${inj.toFixed(4)} INJ. Storing two contracts needs more than that.`,
      netName === 'testnet'
        ? 'Fund it at https://testnet.faucet.injective.network'
        : 'Top up the account and re-run.',
    );
  }
}

/**
 * Refuses anything that is not a wasm module, before it is broadcast.
 *
 * Four bytes, read locally, costing nothing. Without it a mis-encoded upload is found
 * by the chain after a simulate and a signature, and the message comes back as a
 * `TransactionException` with a Go file path in it, which reads as the node being
 * broken rather than as the payload being wrong.
 */
function assertWasm(bytes, name) {
  const magic = [0x00, 0x61, 0x73, 0x6d];
  const got = Array.from(bytes.subarray(0, 4));
  if (magic.some((b, i) => got[i] !== b)) {
    const hex = (a) => a.map((b) => '0x' + b.toString(16).padStart(2, '0')).join(' ');
    die(
      `${name} does not start with the wasm magic number.`,
      `expected ${hex(magic)}, got ${hex(got)}. If the actual bytes spell ASCII, something base64-encoded the module instead of sending it.`,
    );
  }
}

// --------------------------------------------------------------- artifacts --

function loadWasm(name) {
  const path = join(ARTIFACTS, name);
  if (!existsSync(path)) {
    die(
      `Missing ${name}.`,
      // One crate per invocation. The combined form fails to link, because cargo
      // unifies the `library` feature across both and the factory ends up carrying
      // curve's entry points. See scripts/build-wasm.sh.
      'Build first: ./scripts/build-wasm.sh',
    );
  }
  const bytes = readFileSync(path);
  console.log(`     ${name} ${(bytes.length / 1024).toFixed(0)} KB`);
  return bytes;
}

step(3, 'Reading the compiled contracts');
const curveWasm = loadWasm('curve.wasm');
const factoryWasm = loadWasm('factory.wasm');

// -------------------------------------------------------------- broadcast --

const broadcaster = new MsgBroadcasterWithPk({ privateKey, network, simulateTx: true });

/** Gas for a `MsgStoreCode`. See `storeCode` for why this is not simulated. */
const STORE_CODE_GAS = 12_000_000;

/** Pull a value out of the tx events, whichever shape the node returns. */
function fromEvents(res, type, key) {
  const events = res?.events ?? [];
  for (const ev of events) {
    if (ev.type !== type) continue;
    for (const attr of ev.attributes ?? []) {
      const k = attr.key && /^[A-Za-z0-9+/=]+$/.test(attr.key) && attr.key.length % 4 === 0
        ? safeDecode(attr.key)
        : attr.key;
      if (k === key) return attr.value?.startsWith?.('"') ? JSON.parse(attr.value) : safeDecode(attr.value);
    }
  }
  // Fall back to the raw log, which older nodes populate instead.
  const raw = res?.rawLog ?? '';
  const m = raw.match(new RegExp(`"${key}","value":"([^"]+)"`));
  return m ? m[1] : undefined;
}

function safeDecode(v) {
  if (typeof v !== 'string') return v;
  try {
    const d = Buffer.from(v, 'base64').toString('utf8');
    return /^[\x20-\x7e]*$/.test(d) && d.length > 0 ? d : v;
  } catch {
    return v;
  }
}

async function storeCode(label, bytes) {
  /*
   * RAW BYTES, not base64. `MsgStoreCode.fromJSON` takes a Uint8Array and puts it on
   * the wire as-is; handed a base64 string it encodes that STRING's characters, so the
   * chain receives the text "AGFzbQ…" where the module should be:
   *
   *   magic header not detected: bad magic number
   *   expected=[0x0, 0x61, 0x73, 0x6d]  actual=[0x41, 0x47, 0x46, 0x7a]
   *
   * `0x41 0x47 0x46 0x7a` is the ASCII of "AGFz", which is the base64 OF the expected
   * magic. The error is exact and the fix is one call; what cost the attempt was that
   * nothing checked the bytes before spending gas on them.
   */
  assertWasm(bytes, label);
  const msg = MsgStoreCode.fromJSON({ sender, wasmBytes: new Uint8Array(bytes) });
  /*
   * AN EXPLICIT GAS LIMIT, because simulating this one cannot work.
   *
   * `MsgBroadcasterWithPk` simulates to estimate gas, and Injective charges `txSize`
   * gas against the limit the simulate itself is given. A 356 KB module costs about
   * 3.65M gas in txSize alone, well past the SDK's 600,000 default, so the simulate
   * runs out of gas inside the node and the SDK reports it as:
   *
   *   Simulate on cosmos.tx.v1beta1.Service failed with INVALID_ARGUMENT
   *
   * which names neither gas nor size and sent me looking at payload limits, the
   * endpoints and the module bytes in turn. 300 KB of random bytes simulated fine,
   * which ruled out size and transport; what separated them was that an INVALID
   * module is rejected before the txSize charge and a valid one is not.
   *
   * 12M is roughly three times the measured txSize cost of the larger contract,
   * which leaves room for the module to grow without this needing to be revisited.
   * Gas is only charged for what is used.
   */
  const res = await broadcaster.broadcast({ msgs: msg, gas: { gas: STORE_CODE_GAS } });
  const codeId = fromEvents(res, 'cosmwasm.wasm.v1.EventCodeStored', 'code_id')
    ?? fromEvents(res, 'store_code', 'code_id');
  if (!codeId) {
    die(`Stored ${label} but could not read its code id.`, `tx: ${res.txHash}`);
  }
  console.log(`     ${label} → code id ${codeId}  (${res.txHash})`);
  return Number(String(codeId).replace(/"/g, ''));
}

/**
 * Reuse a code id already on chain instead of storing the same bytes again.
 *
 * WHY THIS EXISTS. `MsgStoreCode` for a 290 KB wasm regularly takes longer than the
 * SDK's 42-second inclusion poll, and the SDK throws on that timeout. **A timeout is
 * not a failure**: the run that produced this check threw, and the transaction had
 * landed, as code id 39965, with the account sequence advanced and the fee paid.
 * Rerunning the script blind would have stored identical bytes a second time, under a
 * third code id, and paid for it.
 *
 * So a partial deploy resumes: pass the code ids the chain already has. The script
 * prints them when it manages to read them, and they are also visible on the code
 * listing for this sender.
 */
function reusedCodeId(label) {
  const raw = process.env[`INJ_${label.toUpperCase()}_CODE_ID`]?.trim();
  if (!raw) return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    die(`INJ_${label.toUpperCase()}_CODE_ID is not a code id: ${raw}`);
  }
  return id;
}

/**
 * Confirm a reused code id exists AND holds the bytes we just built.
 *
 * Checking it exists is not enough: the whole point of reusing is to skip an upload,
 * so a stale id would silently deploy last week's contract while the build log says
 * otherwise. The chain stores a sha256 of the wasm, which is exactly what we have.
 */
async function assertCodeMatches(label, id, bytes) {
  const res = await fetch(`${endpoints.rest}/cosmwasm/wasm/v1/code/${id}`).catch((e) =>
    die(`Could not read code id ${id}.`, e.message),
  );
  if (!res.ok) die(`Code id ${id} does not exist on this chain.`);
  const body = await res.json();
  /*
   * `data_hash` comes back as a HEX string, not base64. Decoding it as base64 yields
   * 48 bytes of nonsense that never matches, and the mismatch reads as "the chain has
   * different bytes" rather than "the comparison is broken" — which is exactly how it
   * first presented: a correct upload reported as the wrong contract.
   */
  const onChain = String(body?.code_info?.data_hash ?? '').toLowerCase();
  const local = createHash('sha256').update(bytes).digest('hex');
  if (onChain.toLowerCase() !== local.toLowerCase()) {
    die(
      `Code id ${id} is not the ${label} you just built.`,
      `on chain: ${onChain}`,
      `locally:  ${local}`,
      'Drop the override and let the script store it.',
    );
  }
  console.log(`     ${label} → code id ${id}  (reused, hash matches)`);
  return id;
}

/*
 * BEFORE ANYTHING IS PAID FOR. A stale opening reserve caught after `storeCode` has
 * run is a refusal that already cost the gas to upload two contracts, which is the
 * complaint the readiness script makes about the payout-address check sitting in step
 * 5. A free check belongs ahead of a paid step, and this one is two HTTP reads.
 */
step(4, 'Checking the opening reserve is still the one you chose');
await checkQuoteScaleFreshness(quoteVirtualWhole());

step(5, 'Storing the contracts on chain');
const curveReuse = reusedCodeId('curve');
const curveCodeId = curveReuse
  ? await assertCodeMatches('curve', curveReuse, curveWasm)
  : await storeCode('curve', curveWasm);
const factoryReuse = reusedCodeId('factory');
const factoryCodeId = factoryReuse
  ? await assertCodeMatches('factory', factoryReuse, factoryWasm)
  : await storeCode('factory', factoryWasm);

/**
 * Refuse a payout address that has never existed on chain.
 *
 * THE DEFECT THIS EXISTS FOR. The factory was deployed with
 * `platform: inj10c4qlte95xqkx505mdvme6lxa50feeujlhlggq`, a well-formed bech32 address
 * that the chain answers `account not found` for: zero balance, no account, never
 * transacted. Nobody has shown they hold its key. The platform's share of every
 * trading fee was routed there and `ClaimFees` would have paid it there, successfully,
 * because a bank send to a valid unused address is not an error. The money would have
 * been gone with nothing reporting a problem.
 *
 * Checking the FORMAT is what let that through: the address was perfectly formed. The
 * only cheap evidence that an address is real is that it exists on chain, so that is
 * what is checked, for both payout addresses, before anything is instantiated.
 *
 * It is not proof of control, and it is not meant to be. An account that has
 * transacted is one somebody has the key to; it could still be the wrong somebody.
 * What it rules out is the case that actually happened: an address nobody has ever
 * held, typed into a config file and never questioned.
 */
async function assertPayable(label, address) {
  const url = `${endpoints.rest}/cosmos/auth/v1beta1/accounts/${address}`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    die(`Could not check the ${label} address.`, e.message);
  }
  if (res.status === 404 || res.status === 400 || res.status === 500) {
    die(
      `The ${label} address has no account on this chain: ${address}`,
      'A well-formed address that has never transacted is one nobody has shown they hold the key to.',
      'Fees sent there are not refused, they are simply unreachable. Fund it once from the',
      'wallet that owns it, then deploy.',
    );
  }
  const body = await res.json().catch(() => ({}));
  // Rule 45: a 200 is not an answer. The LCD returns 200 with a `code` for a
  // missing account on some versions, so the body decides.
  if (body.code || !body.account) {
    die(
      `The ${label} address has no account on this chain: ${address}`,
      `the node answered: ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  console.log(`     ${label}: ${address} ✓ exists on chain`);
}

step(6, 'Instantiating the factory');
/*
 * NO SILENT FALLBACK TO THE DEPLOY KEY.
 *
 * This read `INJ_PLATFORM_ADDRESS || sender`, so forgetting the variable routed the
 * platform's share of every fee, on every launch, to a throwaway deploy key that the
 * comments above tell you not to keep. Name the recipient on purpose, even if it is
 * the deployer: the point is that someone chose it.
 *
 * There is no migration target any more. Graduated liquidity stays locked in each
 * launch's own contract (see `launchpad_math::pool`), so no address receives it.
 */
const platform = process.env.INJ_PLATFORM_ADDRESS?.trim();
if (!platform) {
  die(
    'INJ_PLATFORM_ADDRESS is not set.',
    'It receives the platform share of every trading fee on every launch. Set it in',
    'scripts/.env.local to an address you control. It may be the deployer, but say so.',
  );
}

/*
 * Who may UPGRADE the factory's code. Curves are created with no wasm admin and can
 * never be migrated, but the factory itself can be, by this address. On mainnet it
 * must be chosen explicitly: a multisig, or `none` to make the factory immutable.
 */
const wasmAdminRaw = process.env.INJ_FACTORY_WASM_ADMIN?.trim();
if (netName === 'mainnet' && !wasmAdminRaw) {
  die(
    'INJ_FACTORY_WASM_ADMIN is not set.',
    'On mainnet name the factory upgrade key explicitly: a multisig address, or `none`.',
  );
}
const factoryWasmAdmin =
  wasmAdminRaw === 'none' ? undefined : wasmAdminRaw || sender;
console.log(
  `     factory upgrade key: ${factoryWasmAdmin ?? 'none (immutable)'}` +
    (factoryWasmAdmin === sender ? '  ← the deploy key; fine on testnet only' : ''),
);

/*
 * Who administers the factory's CONFIG: quote allowlist, curve code id for future
 * launches, admin handover. Distinct from the wasm upgrade key above. On mainnet this
 * should be a multisig (a DAO DAO or cw3 multisig contract address works: the factory
 * only compares the sender). It defaults to the deployer on testnet so that
 * `e2e-testnet.mjs` can allowlist its own test quote.
 */
const configAdmin = process.env.INJ_FACTORY_ADMIN?.trim() || (netName === 'mainnet' ? '' : sender);
if (!configAdmin) {
  die(
    'INJ_FACTORY_ADMIN is not set.',
    'On mainnet name the factory admin explicitly, normally a multisig address.',
  );
}
console.log(
  `     factory admin: ${configAdmin}` +
    (configAdmin === sender ? '  ← the deploy key; fine on testnet only' : ''),
);

/**
 * The opening virtual reserve, in whole quote units.
 *
 * WHY THIS IS A VARIABLE NOW. It was the literal `'676'` in the instantiate message
 * below, with a comment citing the INJ price on 11 Oct 2026. Step 6 of the mainnet
 * runbook tells the operator to re-derive it on the morning, and
 * `derive-curve-scale.mjs` prints the number it arrives at - and then there was no way
 * to pass that number to this script. An operator would derive 590, run the deploy
 * exactly as written, and instantiate 676, with nothing on screen mentioning either
 * figure. The number decays fast enough to matter: INJ was $7.92 when 676 was chosen
 * and $9.09 five days later, which is a launch opening at $5,727 instead of $5,000.
 *
 * Mainnet refuses an absent value rather than defaulting, for the same reason
 * `INJ_PLATFORM_ADDRESS` does: this constant sets the market cap every launch on the
 * platform opens at, and a default is not a decision. Testnet keeps 676 so the e2e
 * script needs no new configuration.
 */
function quoteVirtualWhole() {
  const raw = process.env.INJ_QUOTE_VIRTUAL_WHOLE?.trim();
  if (!raw) {
    if (netName === 'mainnet') {
      die(
        'INJ_QUOTE_VIRTUAL_WHOLE is not set.',
        'It sets the market cap every launch opens at, and 676 is a premise about the',
        'INJ price on 11 Oct 2026. Derive it now and pass it:',
        '  node scripts/derive-curve-scale.mjs 5000',
      );
    }
    return '676';
  }
  if (!/^[1-9][0-9]*$/.test(raw)) {
    die(
      `INJ_QUOTE_VIRTUAL_WHOLE is not a whole number of quote units: ${raw}`,
      'It is WHOLE units, not base units: 590, not 590000000000000000000.',
    );
  }
  return raw;
}

/**
 * Has the configured constant gone stale since somebody chose it?
 *
 * THE PROBLEM THIS SOLVES IS FORGETTING, which is not a problem a comment can solve.
 * `INJ_QUOTE_VIRTUAL_WHOLE` is a number of INJ, and what anybody actually chose is a
 * DOLLAR opening cap. INJ moves, so the constant silently stops meaning what it was
 * picked to mean - it drifted 700 to 711 to 710 across three runs in a single
 * afternoon. Every doc here says "re-derive it on the day", which is an instruction to
 * remember something at the worst possible moment, with real money on the other side.
 *
 * So the deploy checks instead of trusting. `INJ_OPEN_TARGET_USD` records the decision
 * - the dollar cap, which does NOT go stale - and this re-derives what the constant
 * should be at today's price and refuses if the two have diverged past `MAX_DRIFT`.
 * Set it once and forgetting becomes a refusal with the right number in it rather than
 * a launchpad quietly opening at the wrong price.
 *
 * IT DOES NOT DERIVE THE CONSTANT FOR YOU, deliberately, and that is the line
 * `derive-curve-scale.mjs` draws: the number is a judgement about what a launch should
 * cost to enter, and the script prints the curve's whole behaviour because those are
 * the figures it is chosen against. Silently substituting a fresh value would deploy a
 * curve nobody looked at. A refusal naming the number keeps the human in the loop and
 * costs them one command.
 *
 * UNSET IS ALLOWED AND SAYS SO. Refusing without it would make a new required variable
 * out of a safety net, and this must not block a deployment that has made its decision
 * some other way. It reports what the constant means today either way, because that is
 * useful even when there is nothing to compare it against.
 */
/** The quote's price, or a throw. Symbol from the configured denom, INJ by default. */
async function priceUsdForQuote() {
  const denom = (process.env.INJ_QUOTE_DENOM?.trim() || 'inj').toUpperCase();
  const symbol = denom === 'INJ' ? 'INJ' : denom.replace(/^.*\//, '').toUpperCase();
  return (await readQuotePrice(symbol)).price;
}

async function checkQuoteScaleFreshness(whole) {
  const target = Number(process.env.INJ_OPEN_TARGET_USD?.trim() || '');
  let price;
  try {
    price = await priceUsdForQuote();
  } catch (e) {
    // A price we cannot read is not a finding. The deploy proceeds; it simply cannot
    // say whether the constant is stale, and says that rather than implying it checked.
    console.log(`  ? could not price the quote asset, so staleness was not checked (${String(e.message).slice(0, 60)})`);
    return;
  }
  const opens = openingCapUsd(Number(whole), price);
  console.log(`  at ${price} per unit, ${whole} opens a launch at about $${Math.round(opens).toLocaleString('en-US')}`);

  if (!Number.isFinite(target) || target <= 0) {
    console.log('  ? INJ_OPEN_TARGET_USD is not set, so nothing here can tell you if that is the figure you chose.');
    console.log('    Set it to the dollar cap you intended and this refuses a stale constant instead of shipping one.');
    return;
  }
  const drift = driftFrom(target, Number(whole), price);
  if (Math.abs(drift) <= MAX_DRIFT) {
    console.log(`  ✓ within ${Math.round(MAX_DRIFT * 100)}% of the $${target.toLocaleString('en-US')} you intended (${drift >= 0 ? '+' : ''}${(drift * 100).toFixed(1)}%)`);
    return;
  }
  die(
    `INJ_QUOTE_VIRTUAL_WHOLE=${whole} is stale: it opens launches at about $${Math.round(opens).toLocaleString('en-US')}, not the $${target.toLocaleString('en-US')} in INJ_OPEN_TARGET_USD (${drift >= 0 ? '+' : ''}${(drift * 100).toFixed(1)}%).`,
    `At ${price} per unit the constant should be about ${virtualQuoteFor(target, price)}.`,
    'Run this, read what the curve would do, then set it:',
    `  node scripts/derive-curve-scale.mjs ${target}`,
  );
}

/**
 * `INJ_LAUNCH_FEE` in whole INJ, as base units. Absent means no charge.
 *
 * Refused rather than rounded if it is not a number, because a typo silently
 * becoming zero is a launchpad that forgot to charge, and one silently becoming
 * something large is worse.
 */
function launchFeeBaseUnits() {
  const raw = process.env.INJ_LAUNCH_FEE?.trim();
  if (!raw) return '0';
  if (!/^[0-9]+(\.[0-9]{1,18})?$/.test(raw)) {
    die(`INJ_LAUNCH_FEE is not a plain INJ amount: ${raw}`, 'For example: INJ_LAUNCH_FEE=0.2');
  }
  const [whole, frac = ''] = raw.split('.');
  return (BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, '0'))).toString();
}

const initMsg = {
  admin: configAdmin,
  curve_code_id: curveCodeId,
  platform,
  quote_denom: 'inj',
  /*
   * INJ is 18 decimals. Declared rather than assumed because this number scales the
   * whole curve: Injective's USDC is 6, and an 18 against a 6-decimal quote sets the
   * graduation target to 85 trillion, which nothing can reach.
   */
  quote_decimals: 18,
  /*
   * The opening virtual reserve for INJ, in whole INJ, which is what sets the market
   * cap a launch opens at. Stated here rather than left to the contract's default so
   * the deploy records the number, and so a deploy whose default quote is a stablecoin
   * fails to look right by accident. See `quoteVirtualWhole` for why it is no longer
   * the literal 676.
   */
  quote_virtual_whole: quoteVirtualWhole(),
  /*
   * THE LAUNCHPAD'S OWN CHARGE for creating a launch, paid to `platform` in the
   * same transaction. Set by `INJ_LAUNCH_FEE` in whole quote units, so testnet
   * deploys free and mainnet deploys with the real number. This is NOT Injective's
   * denom-creation fee: that goes to the chain, is a chain parameter, and nothing
   * here can redirect or waive it. A creator pays both. It is also NOT the same
   * amount on both chains - 1 INJ on testnet, 0.1 INJ on mainnet, measured
   * 16 Oct 2026 - which this comment used to state as a flat 1 INJ.
   */
  launch_fee: launchFeeBaseUnits(),
  launch_fee_denom: 'inj',
};
await assertPayable('platform fee recipient', initMsg.platform);
if (initMsg.launch_fee !== '0') {
  console.log(
    `     launch fee: ${(Number(initMsg.launch_fee) / 1e18).toFixed(4)} INJ to ${initMsg.platform}`,
  );
}
if (configAdmin !== sender) await assertPayable('factory admin', configAdmin);
if (factoryWasmAdmin && factoryWasmAdmin !== sender) {
  await assertPayable('factory upgrade key', factoryWasmAdmin);
}

const instantiate = MsgInstantiateContract.fromJSON({
  sender,
  admin: factoryWasmAdmin ?? '',
  codeId: factoryCodeId,
  label: `injective-launchpad-factory-${Date.now()}`,
  msg: initMsg,
});

const instRes = await broadcaster.broadcast({ msgs: instantiate });
const factoryAddress =
  fromEvents(instRes, 'cosmwasm.wasm.v1.EventContractInstantiated', 'contract_address') ??
  fromEvents(instRes, 'instantiate', '_contract_address');

if (!factoryAddress) {
  die('Factory instantiated but its address could not be read.', `tx: ${instRes.txHash}`);
}
console.log(`     factory → ${factoryAddress}  (${instRes.txHash})`);

// ------------------------------------------------------------------ output --

/*
 * injscan, not *.explorer.injective.network: the testnet host's 301 DISCARDS the path,
 * so the link printed below after a deploy opened the explorer's front page rather than
 * the factory just created. Measured from the Location header on 16 Oct 2026. Mirrors
 * `NETWORKS[*].explorer` in app/src/lib/config.ts, which carries the detail.
 */
const explorer = netName === 'mainnet' ? 'https://injscan.com' : 'https://testnet.injscan.com';

/*
 * Printed because the app pins it and nothing else surfaces it.
 *
 * Computed from the bytes just stored, so it is the same number `assertCodeMatches`
 * compares against the chain on the reuse path, and the same number a reader gets from
 * `shasum -a 256` of the artifact. That reproducibility is the entire reason the app
 * prefers this pin to a code id: anybody can rebuild and check it, where "39974" is a
 * pointer only whoever uploaded it can vouch for.
 */
const curveHash = createHash('sha256').update(curveWasm).digest('hex');

console.log(`
  Done.

  curve code id    ${curveCodeId}
  curve code hash  ${curveHash}
  factory code id  ${factoryCodeId}
  factory address  ${factoryAddress}
  ${explorer}/contract/${factoryAddress}

  Every variable the app reads. Set all of them, not just the obvious one:

    NEXT_PUBLIC_NETWORK=${netName}
    NEXT_PUBLIC_FACTORY_ADDRESS=${factoryAddress}
    NEXT_PUBLIC_CURVE_CODE_IDS=${curveCodeId}
    NEXT_PUBLIC_CURVE_CODE_HASHES=${curveHash}
    NEXT_PUBLIC_LCD_URL=${endpoints.rest}

  Put them in app/.env.local, then restart the dev server.
`);
