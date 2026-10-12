/**
 * Everything that must be true before this is deployed to Injective mainnet.
 *
 *   node scripts/mainnet-readiness.mjs
 *
 * WHY A SCRIPT. Launch morning is the worst possible time to be exercising judgement:
 * the checks that matter are all cheap, all mechanical, and all the kind of thing
 * that is obvious in hindsight. Every item here is something that was either found
 * the hard way on testnet or would only have shown up with real money on the other
 * side.
 *
 * IT REPORTS, IT DOES NOT DECIDE. Some items it cannot settle at all, because they
 * are commercial or legal rather than technical, and those are printed as questions
 * with the evidence attached rather than silently passed. A script that marked its
 * own unknowns green would be the exact failure it exists to prevent.
 *
 * Exit code 0 only when every mechanical check passed. The manual items are listed
 * either way, because they do not stop being true.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MAINNET_LCD = process.env.INJ_MAINNET_LCD ?? 'https://sentry.lcd.injective.network';

let failed = 0;
let warned = 0;
const ok = (m, d) => console.log(`  ✓ ${m}${d ? `\n      ${d}` : ''}`);
const no = (m, d) => {
  failed += 1;
  console.log(`  ✗ ${m}${d ? `\n      ${d}` : ''}`);
};
const hm = (m, d) => {
  warned += 1;
  console.log(`  ? ${m}${d ? `\n      ${d}` : ''}`);
};

const section = (n, t) => console.log(`\n  ${n}. ${t}`);

/** The platform address to check, if the operator has chosen one. */
const platform = process.env.INJ_PLATFORM_ADDRESS?.trim();
const admin = process.env.INJ_FACTORY_ADMIN?.trim();

console.log('\n  Vetta mainnet readiness');
console.log(`  mainnet LCD ${MAINNET_LCD}`);

// ------------------------------------------------------------- the chain --

section(1, 'The chain, and what it will charge');

let denomFee = null;
try {
  const r = await fetch(`${MAINNET_LCD}/injective/tokenfactory/v1beta1/params`, {
    signal: AbortSignal.timeout(20_000),
  });
  const p = (await r.json())?.params?.denom_creation_fee?.find((c) => c.denom === 'inj');
  denomFee = p?.amount ? BigInt(p.amount) : null;
  if (denomFee === null) throw new Error('no inj entry in denom_creation_fee');
  ok(`mainnet charges ${Number(denomFee) / 1e18} INJ to create a denom`);
  /*
   * MEASURED, NOT ASSUMED, because the two chains disagree: testnet charges 1 INJ
   * and mainnet 0.1. The app's pre-flight carried testnet's number and would have
   * refused mainnet launches a creator could comfortably afford.
   */
  if (denomFee !== 100_000_000_000_000_000n) {
    hm(
      `That is not the 0.1 INJ measured on 12 Oct 2026.`,
      'Injective changed it. Check `denomCreationFeeFor` in app/src/lib/launchCost.ts.',
    );
  }
} catch (e) {
  no('The mainnet denom creation fee could not be read.', e.message);
}

// ---------------------------------------------------------- the addresses --

section(2, 'The addresses that will hold and receive money');

async function accountExists(addr) {
  const r = await fetch(`${MAINNET_LCD}/cosmos/bank/v1beta1/balances/${addr}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) return null;
  const b = (await r.json())?.balances ?? [];
  const inj = b.find((c) => c.denom === 'inj');
  return { funded: b.length > 0, inj: inj ? BigInt(inj.amount) : 0n };
}

if (!platform) {
  hm(
    'No INJ_PLATFORM_ADDRESS set, so the fee recipient cannot be checked.',
    'Re-run with INJ_PLATFORM_ADDRESS=inj1... once you have chosen it.',
  );
} else {
  try {
    const a = await accountExists(platform);
    if (a === null) no(`The platform address could not be read: ${platform}`);
    else if (!a.funded) {
      /*
       * An address with no mainnet history is one nobody has proved they control.
       * Fees paid to a mistyped address are gone, and the mistake is invisible until
       * somebody goes looking for money that never arrived.
       */
      no(
        `${platform} has never held anything on mainnet.`,
        'Send a small amount from it first. An address nobody has transacted from is one nobody has proved they hold the key to.',
      );
    } else ok(`platform ${platform} exists on mainnet (${Number(a.inj) / 1e18} INJ)`);
  } catch (e) {
    no('The platform address could not be checked.', e.message);
  }
}

if (!admin) {
  hm('No INJ_FACTORY_ADMIN set.', 'The deploy key becomes the admin if you do not set one.');
} else if (platform && admin === platform) {
  hm(
    'The factory admin and the platform recipient are the same address.',
    'Workable, but one compromised key then both redirects future fees and migrates the factory.',
  );
} else if (admin) {
  ok(`factory admin ${admin} is separate from the fee recipient`);
}

/*
 * THE UPGRADE KEY IS THE ONE WORTH ARGUING ABOUT. Curves are deployed with no wasm
 * admin and are immutable for good; the FACTORY has one, and whoever holds it can
 * migrate it. That cannot touch an existing launch's funds, but it can change where
 * future fees go and which curve code new launches run.
 */
hm(
  'The factory will have a wasm admin (an upgrade key).',
  'Existing launches are immutable either way. A multisig is the right holder on mainnet; a laptop key is not.',
);

// ------------------------------------------------------------ the config --

section(3, 'Configuration that differs from testnet');

const envExample = join(ROOT, 'scripts', '.env.example');
if (existsSync(envExample)) {
  const text = readFileSync(envExample, 'utf8');
  ok(`scripts/.env.example documents ${(text.match(/^[A-Z][A-Z0-9_]*=/gm) ?? []).length} variables`);
} else {
  no('scripts/.env.example is missing, so the configuration surface is undocumented.');
}

hm(
  'The opening reserve must be re-derived for mainnet.',
  'node scripts/derive-curve-scale.mjs 5000. 676 was chosen at INJ $7.92 on 11 Oct 2026 and is a premise about that day, not a property.',
);

const keeper = join(ROOT, 'scripts', '.env.keeper.local');
if (existsSync(keeper)) {
  ok('a keeper wallet exists for automatic payouts');
  hm(
    'Its mnemonic must be in GitHub Secrets as KEEPER_MNEMONIC, and it needs gas.',
    'It must NOT be the deploy key, which is also the admin and the fee recipient.',
  );
} else {
  hm('No keeper wallet yet, so fee payouts will only happen when somebody clicks.');
}

// ------------------------------------------------------- what no script can --

section(4, 'What this cannot check');

console.log(`
      NO THIRD-PARTY AUDIT. docs/AUDIT.md opens with "Not a third-party audit"
      and docs/AUDIT_SCOPE.md is written for an auditor nobody has engaged.
      These contracts will hold other people's money. Everything else on this
      list is hours of work; this is weeks, and costs money, and is the one
      item I would least want to skip.

      A DEDICATED RPC. The public sentry LCD is fine for testnet and will rate
      limit under real traffic. The board already makes one request per launch.

      TERMS AND A RISK DISCLOSURE, which need an entity and a jurisdiction
      before they can say anything true. See docs/LEGAL-DRAFTS.md.

      A DOMAIN. The product is called Vetta and the site is injpad.vercel.app.
`);

// ----------------------------------------------------------------- result --

console.log(
  failed === 0
    ? `  ✓ ${warned} ${warned === 1 ? 'item needs' : 'items need'} a decision; nothing mechanical is failing.\n`
    : `  ✗ ${failed} ${failed === 1 ? 'check' : 'checks'} failed, ${warned} need a decision.\n`,
);
process.exit(failed === 0 ? 0 : 1);
