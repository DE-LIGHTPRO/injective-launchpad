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

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(HERE, '..', 'target', 'wasm32-unknown-unknown', 'release');

const EXPECTED_CHAIN_ID = { testnet: 'injective-888', mainnet: 'injective-1' };

const argv = process.argv.slice(2);
const wantMainnet = argv.includes('--mainnet');
const confirmedMainnet = argv.includes('--i-understand-this-is-real-money');

function die(msg, hint) {
  console.error(`\n  ✗ ${msg}`);
  if (hint) console.error(`    ${hint}`);
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

/**
 * Loads `scripts/.env.local` into the environment, if it exists.
 *
 * Written out rather than taking a dependency: this script signs transactions, and a
 * package added for the convenience of reading a text file is one more thing with
 * access to the process that holds a seed phrase.
 *
 * Anything already in the environment wins, so a CI secret is not overwritten by a
 * file someone left behind locally.
 */
function loadEnvFile() {
  const envPath = join(HERE, '.env.local');
  if (!existsSync(envPath)) return;

  /*
   * Refused if the file is group or world readable. A seed phrase sitting at 0644 is
   * readable by every process and every other account on the machine, and the usual
   * way that happens is a text editor or a copy that did not preserve the mode. The
   * fix is one chmod, so it is worth stopping for.
   */
  const mode = statSync(envPath).mode & 0o777;
  if (mode & 0o077) {
    die(
      `scripts/.env.local is readable by others (mode ${mode.toString(8)}).`,
      'Run: chmod 600 scripts/.env.local',
    );
  }

  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (t.length === 0 || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    // Surrounding quotes are stripped, because a mnemonic has spaces in it and
    // everyone quotes it. Left in, the first word would carry a leading quote and
    // the derived address would simply be a different, empty account.
    let value = t.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

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
  const msg = MsgStoreCode.fromJSON({ sender, wasmBytes: bytes.toString('base64') });
  const res = await broadcaster.broadcast({ msgs: msg });
  const codeId = fromEvents(res, 'cosmwasm.wasm.v1.EventCodeStored', 'code_id')
    ?? fromEvents(res, 'store_code', 'code_id');
  if (!codeId) {
    die(`Stored ${label} but could not read its code id.`, `tx: ${res.txHash}`);
  }
  console.log(`     ${label} → code id ${codeId}  (${res.txHash})`);
  return Number(String(codeId).replace(/"/g, ''));
}

step(4, 'Storing the contracts on chain');
const curveCodeId = await storeCode('curve', curveWasm);
const factoryCodeId = await storeCode('factory', factoryWasm);

step(5, 'Instantiating the factory');
const initMsg = {
  admin: sender,
  curve_code_id: curveCodeId,
  platform: process.env.INJ_PLATFORM_ADDRESS?.trim() || sender,
  migration_target: process.env.INJ_MIGRATION_TARGET?.trim() || sender,
  quote_denom: 'inj',
};
console.log(`     platform:   ${initMsg.platform}`);
console.log(`     migration:  ${initMsg.migration_target}`);

const instantiate = MsgInstantiateContract.fromJSON({
  sender,
  admin: sender,
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

const explorer =
  netName === 'mainnet'
    ? 'https://explorer.injective.network'
    : 'https://testnet.explorer.injective.network';

console.log(`
  Done.

  curve code id    ${curveCodeId}
  factory code id  ${factoryCodeId}
  factory address  ${factoryAddress}
  ${explorer}/contract/${factoryAddress}

  Every variable the app reads. Set all of them, not just the obvious one:

    NEXT_PUBLIC_NETWORK=${netName}
    NEXT_PUBLIC_FACTORY_ADDRESS=${factoryAddress}
    NEXT_PUBLIC_LCD_URL=${endpoints.rest}

  Put them in app/.env.local, then restart the dev server.
`);
