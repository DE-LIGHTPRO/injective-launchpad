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
