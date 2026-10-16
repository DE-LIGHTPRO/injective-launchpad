/**
 * Is the site that is LIVE the one you think is live?
 *
 *   node scripts/verify-deployment.mjs [url]
 *
 * WHY THIS EXISTS. `NEXT_PUBLIC_*` is inlined into the client bundle at build time,
 * so changing it on Vercel does nothing until something rebuilds. Twice in one
 * evening a push-triggered build started seconds BEFORE the env change landed,
 * finished green, reported Ready, and served the previous factory address. Nothing
 * on the deployment said so. The page looked perfect: a board, a chart, real
 * figures, all read from a contract nobody meant to be pointing at.
 *
 * On testnet that wastes an hour. On mainnet it means a creator paying a real fee
 * into a factory the operator has already moved on from, and trades settling on a
 * curve nobody is watching.
 *
 * The only honest check is to read what the live site actually serves and compare it
 * against the chain. That is what this does, and it is the check I kept running by
 * hand: fetch the page, pull the addresses out of the served chunks, and ask the
 * chain whether that factory is configured the way the operator intended.
 *
 * Exit code 0 only if every check held.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', 'app');

let failures = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg, detail) => {
  failures += 1;
  console.log(`  ✗ ${msg}`);
  if (detail) console.log(`      ${detail}`);
};
/*
 * A third reporter, because section 3 asks a question whose answer is a real
 * problem on mainnet and the normal state of affairs on testnet. One laptop key
 * holding all three roles is how testnet is supposed to look; making that exit 1
 * would train whoever runs this to ignore the exit code, which is worse than not
 * checking. Same finding, two severities, decided by the chain id it measured.
 */
const warn = (msg, detail) => {
  console.log(`  ! ${msg}`);
  if (detail) console.log(`      ${detail}`);
};

/** `KEY=value` lines, for the expectation this is measured against. */
function loadEnv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

const env = loadEnv(join(APP, '.env.local'));
const site = (process.argv[2] ?? 'https://injpad.vercel.app').replace(/\/+$/, '');
const expected = process.env.NEXT_PUBLIC_FACTORY_ADDRESS ?? env.NEXT_PUBLIC_FACTORY_ADDRESS;
const lcd = process.env.NEXT_PUBLIC_LCD_URL ?? env.NEXT_PUBLIC_LCD_URL;

console.log(`\n  site     ${site}`);
console.log(`  expected ${expected ?? '(none configured locally)'}`);

if (!expected) {
  bad('No NEXT_PUBLIC_FACTORY_ADDRESS to compare against.', 'Set it in app/.env.local.');
  process.exit(1);
}

// ---------------------------------------------------------------- the bundle --

console.log('\n  1. What the live site actually serves');

let html = '';
try {
  const res = await fetch(`${site}/`, { headers: { accept: 'text/html' } });
  html = await res.text();
  /*
   * The cache header matters: a 200 can be a copy served from the edge from before
   * the deploy, and comparing against that answers a question about the past.
   */
  const cache = res.headers.get('x-vercel-cache');
  ok(`page ${res.status}${cache ? `, x-vercel-cache: ${cache}` : ''}`);
  if (cache === 'HIT') {
    console.log('      A cached copy. Re-run if this disagrees with what you expect.');
  }
} catch (e) {
  bad('The site could not be fetched.', e.message);
  process.exit(1);
}

const chunks = [...new Set(html.match(/\/_next\/static\/chunks\/[A-Za-z0-9._-]+\.js/g) ?? [])];
if (chunks.length === 0) {
  bad('No script chunks in the served HTML.', 'The build may have failed, or this is not a Next page.');
}

const found = new Set();
for (const path of chunks) {
  try {
    const body = await fetch(`${site}${path}`).then((r) => r.text());
    for (const a of body.match(/inj1[a-z0-9]{38}/g) ?? []) found.add(a);
  } catch {
    // One unreachable chunk is not the question being asked.
  }
}

if (found.has(expected)) {
  ok(`the bundle carries ${expected}`);
} else {
  bad(
    'The live bundle does NOT carry the expected factory.',
    `found: ${[...found].join(', ') || '(no addresses in any chunk)'}`,
  );
  console.log('      A NEXT_PUBLIC_* change needs a REDEPLOY, not just an env edit.');
}

const strays = [...found].filter((a) => a !== expected);
if (strays.length > 0) {
  console.log(`      also present (quote denoms, routers, defaults): ${strays.join(', ')}`);
}

// --------------------------------------------------------- who holds a key --

/**
 * One address in three roles, which is correct on testnet and a mainnet blocker.
 *
 * WHY THIS WAS ADDED AFTER THE SCRIPT ALREADY PASSED. Run against the live
 * deployment on 16 Oct 2026 it reported every check green while `admin` and
 * `platform` were the SAME address, which is exactly what §2 of the runbook says
 * must not be true on mainnet. The script printed both values one line apart and
 * never compared them: a report that shows a reader the evidence and leaves them
 * to notice is not a check, and on launch morning nobody notices.
 *
 * The three roles and what each one can do:
 *   platform     receives every launch fee. Loss of this key loses revenue.
 *   factory admin  sets the fee, the quote list and the pinned curve code id.
 *   wasm admin   can MIGRATE the factory to arbitrary code. Strictly the largest.
 *
 * All three as one key means one compromise takes all three, and the migration
 * power is the one that can rewrite what a creator's launch does after they have
 * paid for it.
 *
 * MAINNET IS MEASURED, NOT CONFIGURED. Keying the severity off NEXT_PUBLIC_NETWORK
 * would read an operator's intent from the same file that is being verified; the
 * LCD's own `node_info` says which chain actually answered.
 */
async function reportKeySeparation(lcd, cfg) {
  const chainId = await fetch(`${lcd}/cosmos/base/tendermint/v1beta1/node_info`, {
    signal: AbortSignal.timeout(15_000),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => j?.default_node_info?.network ?? null)
    .catch(() => null);

  const mainnet = chainId === 'injective-1';
  console.log(`\n  3. Who holds the keys (${chainId ?? 'chain id could not be read'})`);
  if (!mainnet) {
    console.log(
      chainId
        ? `      Not injective-1, so these are reported and not failed.`
        : `      The chain id is unknown, so these are reported and not failed.`,
    );
  }
  const note = mainnet ? bad : warn;

  const info = await fetch(`${lcd}/cosmwasm/wasm/v1/contract/${expected}`, {
    signal: AbortSignal.timeout(15_000),
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const wasmAdmin = info === null ? undefined : (info.contract_info?.admin || null);

  if (cfg.admin === cfg.platform) {
    note(
      'The factory admin and the platform address are one key.',
      `Both are ${cfg.admin}. One compromise takes the fee revenue and the power to reconfigure the factory.`,
    );
  } else {
    ok('the factory admin and the platform address are different keys');
  }

  if (wasmAdmin === undefined) {
    warn('The factory\u2019s wasm admin could not be read, so migration rights are unknown.');
    return;
  }
  if (wasmAdmin === null) {
    /*
     * No admin is not a gap: it is the strongest answer available. The code at
     * the pinned id is what runs forever, which is also what makes the pinned
     * id worth getting right before launch rather than after.
     */
    ok('the factory has no wasm admin, so its code can never be migrated');
    return;
  }

  if (wasmAdmin === cfg.admin || wasmAdmin === cfg.platform) {
    note(
      'The wasm admin is the same key as another role.',
      `${wasmAdmin} can migrate the factory to arbitrary code AND ${wasmAdmin === cfg.admin ? 'reconfigure it' : 'collect the fees'}.`,
    );
  } else {
    ok(`the wasm admin ${wasmAdmin} is its own key`);
  }

  const holder = await holderKind(lcd, wasmAdmin);
  if (holder === 'contract' || holder === 'multisig') {
    ok(`the wasm admin is a ${holder}, so migration needs more than one key`);
  } else if (holder === 'single-key') {
    note(
      'The wasm admin is a single-key account.',
      'Whoever holds that one key can migrate the factory. §2 of the runbook asks for a multisig here.',
    );
  } else if (holder === 'absent') {
    note(
      `The wasm admin ${wasmAdmin} does not exist on ${chainId ?? 'this chain'}.`,
      'It holds the power to migrate the factory and has never signed here, so it is either the wrong address or an untested one.',
    );
  } else {
    /*
     * Rule: never report a status that was not measured. An address that has
     * never signed has no public key published on chain, so the shape of its
     * key is genuinely unknown rather than single. Saying "single-key" here
     * would be a guess, and saying "multisig" would be a dangerous one.
     */
    warn(
      `The wasm admin ${holder === 'never signed' ? 'has never signed a transaction' : 'could not be read'}, so whether it is a multisig is unknown.`,
      'A key shape is only on chain once the account has signed once. Send one transaction from it and re-run.',
    );
  }
}

/**
 * Is an address one key, several, or a contract? `contract` | `multisig` |
 * `single-key` | `never signed` | `unknown`.
 *
 * Contracts are checked first because a cw3 multisig IS a contract, and a
 * contract address also answers the auth endpoint with an ordinary account.
 * A native threshold account is a legitimate holder too, so "not a contract"
 * on its own would condemn a perfectly good multisig: the distinguishing fact
 * is the pubkey type, `LegacyAminoPubKey` for a threshold account. Injective
 * wraps its accounts in `EthAccount`, hence the `base_account` fallback.
 *
 * Shapes confirmed against live endpoints on 16 Oct 2026: a mainnet contract
 * answers the wasm endpoint 200; a module account returns `pub_key: null`; an
 * account that has signed returns `/injective.crypto.v1beta1.ethsecp256k1.PubKey`
 * under `base_account`; an address never seen on the chain returns 404 with
 * `code: 5, account … not found`.
 */
async function holderKind(lcd, addr) {
  const isContract = await fetch(`${lcd}/cosmwasm/wasm/v1/contract/${addr}`, {
    signal: AbortSignal.timeout(15_000),
  })
    .then((r) => r.ok)
    .catch(() => null);
  if (isContract === null) return 'unknown';
  if (isContract) return 'contract';

  /*
   * A 404 here is an ANSWER, not a failure to get one: the chain is saying no
   * such account exists. Collapsing it into `unknown` would turn "this address
   * has never existed on the chain you are about to launch on" into "the probe
   * did not work", which is the more comfortable of the two and the wrong one.
   */
  const res = await fetch(`${lcd}/cosmos/auth/v1beta1/accounts/${addr}`, {
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (res?.status === 404) return 'absent';
  const acct = res?.ok ? await res.json().catch(() => null) : null;
  if (!acct?.account) return 'unknown';
  const pubKey = acct.account.pub_key ?? acct.account.base_account?.pub_key ?? null;
  if (!pubKey) return 'never signed';
  return String(pubKey['@type'] ?? '').toLowerCase().includes('multisig') ? 'multisig' : 'single-key';
}

// ----------------------------------------------------------------- the chain --

console.log('\n  2. What that factory says about itself');

if (!lcd) {
  bad('No NEXT_PUBLIC_LCD_URL, so the chain cannot be asked.');
} else {
  const smart = async (addr, q) => {
    const b64 = Buffer.from(JSON.stringify(q)).toString('base64');
    const res = await fetch(`${lcd}/cosmwasm/wasm/v1/contract/${addr}/smart/${b64}`);
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
    return (await res.json()).data;
  };

  try {
    const cfg = await smart(expected, { config: {} });
    ok(`admin    ${cfg.admin}`);
    ok(`platform ${cfg.platform}`);
    ok(`curve code id ${cfg.curve_code_id}`);

    /*
     * The launch fee, stated whichever way it is set. Zero is a legitimate answer
     * and is reported as one rather than passed over, because "I thought mainnet
     * was charging" is exactly the thing this script exists to settle.
     */
    const fee = BigInt(cfg.launch_fee ?? '0');
    const feeDenom = cfg.launch_fee_denom || cfg.quote_denom;
    if (fee === 0n) {
      ok('launch fee: none configured');
    } else {
      ok(`launch fee: ${Number(fee) / 1e18} ${feeDenom} to ${cfg.platform}`);
    }

    /*
     * The pinned curve code id has to match what the app will accept, or every
     * launch renders with "Unrecognised contract code" and trading is disabled.
     * Two values set in two places, which is exactly how they drift.
     */
    const pinned = (process.env.NEXT_PUBLIC_CURVE_CODE_IDS ?? env.NEXT_PUBLIC_CURVE_CODE_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (pinned.length === 0) {
      bad('NEXT_PUBLIC_CURVE_CODE_IDS is unset, so every launch reads as unverified.');
    } else if (!pinned.includes(String(cfg.curve_code_id))) {
      bad(
        `The factory instantiates code ${cfg.curve_code_id}, which is not pinned (${pinned.join(', ')}).`,
        'Every launch would render as unrecognised code and trading would be disabled.',
      );
    } else {
      ok(`curve code id ${cfg.curve_code_id} is pinned in the app`);
    }

    const quotes = await smart(expected, { quotes: {} });
    for (const q of quotes.quotes ?? []) {
      ok(`quote ${q.denom}: ${q.decimals} decimals, opening reserve ${q.virtual_quote_whole ?? '(unset)'}`);
      if (q.virtual_quote_whole === undefined) {
        bad(
          `Quote ${q.denom} has no opening reserve.`,
          'A launch priced in it would use the factory default, which is scaled for INJ.',
        );
      }
    }
    await reportKeySeparation(lcd, cfg);
  } catch (e) {
    bad('The factory could not be read.', e.message);
  }
}

console.log(
  failures === 0
    ? '\n  ✓ The live site and the chain agree.\n'
    : `\n  ✗ ${failures} ${failures === 1 ? 'check' : 'checks'} failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
