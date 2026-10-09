/**
 * Deploy the launchpad to Injective.
 *
 *   INJ_MNEMONIC="..." node deploy.mjs            # testnet
 *   INJ_MNEMONIC="..." node deploy.mjs --mainnet  # mainnet, needs a second flag too
 *
 * Your key is read from the environment and never printed, written, or sent
 * anywhere but the signer. Nothing here logs it, not even on failure.
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

import { readFileSync, existsSync } from 'node:fs';
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

const mnemonic = process.env.INJ_MNEMONIC?.trim();
const rawKey = process.env.INJ_PRIVATE_KEY?.trim();

if (!mnemonic && !rawKey) {
  die(
    'No signing key found.',
    'Set INJ_MNEMONIC="word word …" (or INJ_PRIVATE_KEY=0x…) in your shell and re-run.',
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
