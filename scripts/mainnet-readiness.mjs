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
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvLocal } from './loadEnvLocal.mjs';

/*
 * READ THE SAME FILE `deploy.mjs` READS. This script reported every address as unset
 * while they sat in `scripts/.env.local`, because the loader was private to the deploy
 * script: the check that answers "is this configured" could not see the configuration.
 * A loose file mode is reported rather than fatal here, so one problem does not hide
 * the rest of the list.
 */
loadEnvLocal((msg, fix) => console.log(`  ! ${msg}\n      ${fix}`));

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

/*
 * THE SAME THREE `deploy.mjs` REFUSES, read here under the same names.
 *
 * This read two of them and checked the existence of one. `deploy.mjs` calls
 * `assertPayable` on all three (lines 600-609) and dies on any that has no account,
 * and it does so in STEP 5, after step 4 has already stored both contracts on chain.
 * So an operator ran this on the morning, saw one address flagged, funded that one,
 * paid for two wasm stores, and died on the second address with the gas spent.
 *
 * Each half was locally right: this script was about the address that receives money,
 * and the deploy script was about every address it names. Nothing errors where the
 * error is, which is why the readiness list has to enforce what the deploy enforces
 * rather than a sensible subset of it.
 */
const platform = process.env.INJ_PLATFORM_ADDRESS?.trim();
const admin = process.env.INJ_FACTORY_ADMIN?.trim();
const wasmAdmin = process.env.INJ_FACTORY_WASM_ADMIN?.trim();

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

/*
 * HOW FAR BACK THIS ENDPOINT CAN SEE, which decides whether there is a chart.
 *
 * The public sentry nodes keep a rolling window and prune the rest, so a launch's
 * trade history, candles, fill prices and 24h volume all expire. Asking for block 1
 * is the cheap probe: a pruning node refuses with the lowest height it still holds,
 * and an archival node answers. Measured rather than assumed, because the number is a
 * property of whichever endpoint the operator actually bought, not of the chain.
 *
 * `BLOCKS_PER_DAY` in the app decides how far back "24h volume" asks, so anything the
 * endpoint retains below that cannot serve a full day even in principle.
 *
 * READ FROM THE APP rather than restated here. Two copies of one number is the defect
 * this project keeps finding: the app would change its window and this script would go
 * on reporting against the old one, which is worse than not checking. If the expression
 * is not where this expects it, the check below says so instead of assuming a figure.
 */
const BLOCKS_PER_DAY = (() => {
  try {
    const src = readFileSync(join(ROOT, 'app', 'src', 'lib', 'launchActivity.ts'), 'utf8');
    const m = /export const BLOCKS_PER_DAY = Math\.round\(\(24 \* 60 \* 60\) \/ ([\d.]+)\)/.exec(src);
    return m ? Math.round((24 * 60 * 60) / Number(m[1])) : null;
  } catch {
    return null;
  }
})();
if (BLOCKS_PER_DAY === null) {
  hm(
    "The app's 24h window could not be read, so it cannot be compared with retention.",
    'BLOCKS_PER_DAY in app/src/lib/launchActivity.ts is no longer where this script looks for it.',
  );
}
/*
 * TEN PROBES, NOT ONE, because a hostname is not a node. Measured 16 Oct 2026:
 * sentry.lcd.injective.network answered 100,000-100,013 blocks on eight of ten requests
 * and 30,577 on the other two, so it balances across nodes pruned to different depths.
 * One sample calls a 5-hour endpoint a 16-hour one, or the reverse, and the operator
 * plans against whichever it happened to hit. The SHALLOWEST answer is the one that
 * decides what a user sees, since any request may land there.
 */
const PROBES = 10;
try {
  const head = await fetch(`${MAINNET_LCD}/cosmos/base/tendermint/v1beta1/blocks/latest`, {
    signal: AbortSignal.timeout(20_000),
  }).then((r) => r.json());
  const latest = Number(head?.block?.header?.height);

  const samples = [];
  for (let i = 0; i < PROBES; i += 1) {
    const r = await fetch(`${MAINNET_LCD}/cosmos/base/tendermint/v1beta1/blocks/1`, {
      signal: AbortSignal.timeout(20_000),
    }).then((res) => res.json());
    const m = /lowest height is (\d+)/.exec(r?.message ?? '');
    if (r?.block?.header?.height === '1') samples.push(null); // archival node answered
    else if (m) samples.push(Number(m[1]));
  }
  const lowest = samples.filter((s) => s !== null);
  const pruned = lowest.length ? [null, String(Math.max(...lowest))] : null;
  /*
   * ARCHIVAL IS ASSERTED FROM THE BLOCK, not from the absence of a complaint. A proxy
   * error page, a rate-limit body or any other shape carries no `message` either, and
   * reading that as "archival" would green-light the exact endpoint this check exists
   * to refuse. Block 1 is present or the answer is "could not be measured".
   */
  const servedBlockOne = samples.filter((s) => s === null).length;
  if (!Number.isFinite(latest)) {
    no('The chain head could not be read, so retention could not be measured.');
  } else if (servedBlockOne === PROBES) {
    ok(`${MAINNET_LCD} served block 1 on ${PROBES}/${PROBES} probes: archival, so no history expires`);
  } else if (servedBlockOne > 0 && lowest.length > 0) {
    /*
     * A MIX IS NOT ARCHIVAL. One archival node behind the same hostname as a pruning one
     * means a chart loads or empties depending on which answered, which is worse to
     * debug than an endpoint that consistently cannot see back that far.
     */
    no(
      `${MAINNET_LCD} is inconsistent: ${servedBlockOne}/${PROBES} probes served block 1, ${lowest.length} refused it.`,
      'The same hostname fronts an archival node and a pruning one, so identical queries succeed or fail by luck of routing.',
    );
  } else if (!pruned) {
    no(
      'Retention could not be measured: the endpoint neither served block 1 nor named a lowest height.',
      `Asking ${MAINNET_LCD} for block 1 returned a shape this does not recognise, so whether history expires is unknown.`,
    );
  } else {
    /*
     * Two block timestamps rather than a target block time. The published 0.65s and
     * the measured 0.598s differ by enough to move the answer by an hour, and the
     * whole point of this check is to report a window somebody can plan against.
     */
    const span = 20_000;
    const t = await Promise.all(
      [latest - span, latest].map((h) =>
        fetch(`${MAINNET_LCD}/cosmos/base/tendermint/v1beta1/blocks/${h}`, {
          signal: AbortSignal.timeout(20_000),
        })
          .then((r) => r.json())
          .then((b) => Date.parse(b?.block?.header?.time)),
      ),
    );
    const retained = latest - Number(pruned[1]);
    const deepest = latest - Math.min(...lowest);
    const perBlock = Number.isFinite(t[0]) && Number.isFinite(t[1]) ? (t[1] - t[0]) / span / 1000 : null;
    const hours = perBlock ? ((retained * perBlock) / 3600).toFixed(1) : '?';
    const spread =
      deepest - retained > 1_000
        ? `\n      It is not one node: across ${PROBES} probes the deepest answered ${deepest.toLocaleString('en-US')} blocks and the shallowest ${retained.toLocaleString(
            'en-US',
          )}, so the same query succeeds or fails by luck of routing. The shallowest is what to plan against.`
        : '';
    const day =
      BLOCKS_PER_DAY === null
        ? ''
        : `\n      A day needs ${BLOCKS_PER_DAY.toLocaleString('en-US')} blocks, so 24h volume is ${
            retained >= BLOCKS_PER_DAY ? 'obtainable but nothing older is' : 'unobtainable here'
          }.`;
    no(
      `${MAINNET_LCD} prunes: it keeps ${retained.toLocaleString('en-US')} blocks (~${hours} hours).`,
      `The chart, trade history and 24h volume all come from transaction search, so they expire with it.${spread}${day}\n      Get an ARCHIVAL endpoint and set INJ_MAINNET_LCD to it.`,
    );
  }
} catch (e) {
  no('The endpoint\'s history retention could not be measured.', e.message);
}

// ---------------------------------------------------------- the addresses --

section(2, 'The addresses that will hold and receive money');

/**
 * Two questions, two requests, because one query cannot answer both honestly.
 *
 * "Does this account hold anything at all" is the plural query, bounded to one denom -
 * that is the whole question. "How much INJ" is `by_denom`, asked for by name.
 *
 * It used to be one unbounded plural query with a `find(denom === 'inj')` over the
 * result. That endpoint pages at 100 denoms, and an account that has been used on
 * Injective accumulates tokenfactory denoms, IBC assets and airdrops, so `inj` falling
 * off the first page is ordinary rather than exotic. The find then yields undefined
 * and this reported `0n` - this tool, about the mainnet fee recipient, on the morning
 * it is being trusted. A paged-out balance and an empty account are indistinguishable
 * in the answer, which is what makes it worth two requests.
 *
 * Note the endpoints disagree about the parameter: bank wants `pagination.limit` and
 * ignores a bare `limit`, while `/cosmos/tx/v1beta1/txs` is the exact opposite. Both
 * measured live on 16 Oct 2026; see `app/src/lib/tx-search-limit.test.ts`.
 */
async function accountExists(addr) {
  const get = (path) => fetch(`${MAINNET_LCD}${path}`, { signal: AbortSignal.timeout(20_000) });
  const [any, injRes] = await Promise.all([
    get(`/cosmos/bank/v1beta1/balances/${addr}?pagination.limit=1`),
    get(`/cosmos/bank/v1beta1/balances/${addr}/by_denom?denom=inj`),
  ]);
  if (!any.ok || !injRes.ok) return null;
  const held = (await any.json())?.balances ?? [];
  const amount = (await injRes.json())?.balance?.amount;
  return {
    funded: held.length > 0,
    inj: typeof amount === 'string' && /^[0-9]+$/.test(amount) ? BigInt(amount) : 0n,
  };
}

/**
 * One role: is it set, and does the chain know the address?
 *
 * `deploy.mjs` asks the auth endpoint; this asks bank, and the difference does not
 * matter here because both answer the one question worth asking - has anybody ever
 * put anything at this address. A well-formed address with no history is one nobody
 * has proved they hold the key to, which is the case that actually happened: the
 * factory was once deployed paying fees to `inj10c4q...`, an address that has never
 * transacted, and every fee would have gone there successfully and unrecoverably.
 */
async function checkRole(label, addr, hint) {
  if (!addr) {
    hm(`No ${label} address set.`, hint);
    return;
  }
  try {
    const a = await accountExists(addr);
    if (a === null) no(`The ${label} address could not be read: ${addr}`);
    else if (!a.funded) {
      no(
        `${label}: ${addr} has never held anything on mainnet.`,
        'Send it a small amount first. deploy.mjs refuses this address, and it refuses it in step 5, after it has already paid to store both contracts.',
      );
    } else ok(`${label} ${addr} exists on mainnet (${Number(a.inj) / 1e18} INJ)`);
  } catch (e) {
    no(`The ${label} address could not be checked.`, e.message);
  }
}

await checkRole('platform fee recipient', platform, 'Re-run with INJ_PLATFORM_ADDRESS=inj1... once you have chosen it.');
await checkRole('factory admin', admin, 'On mainnet deploy.mjs requires it. It does not fall back to the deploy key.');

/*
 * THE UPGRADE KEY IS THE ONE WORTH ARGUING ABOUT. Curves are deployed with no wasm
 * admin and are immutable for good; the FACTORY has one, and whoever holds it can
 * migrate it. That cannot touch an existing launch's funds, but it can change where
 * future fees go and which curve code new launches run.
 *
 * `none` is a complete answer, not a missing one. It makes the factory immutable, and
 * the check below must not nag about a key that will not exist.
 */
if (wasmAdmin === 'none') {
  ok('the factory will have NO wasm admin: immutable, and no upgrade key to hold or lose');
} else {
  await checkRole(
    'factory upgrade key',
    wasmAdmin,
    'On mainnet deploy.mjs requires it: a multisig address, or the literal `none` to make the factory immutable.',
  );
  if (wasmAdmin) {
    hm(
      'The factory upgrade key is a plain address.',
      'Existing launches are immutable either way. What this key can do is repoint future launches and remove the caps the contract enforces, so a multisig is the right holder and a laptop key is not.',
    );
  }
}

/*
 * DISTINCTNESS, CHECKED ACROSS ALL THREE rather than between two of them.
 * `verify-deployment.mjs` reports an overlap AFTER the deploy, which is the wrong end
 * of the morning to learn it. One compromised key holding two roles is one key that
 * both redirects future fees and migrates the factory.
 */
const roles = [
  ['platform fee recipient', platform],
  ['factory admin', admin],
  ['factory upgrade key', wasmAdmin === 'none' ? undefined : wasmAdmin],
].filter(([, a]) => a);
for (let i = 0; i < roles.length; i += 1) {
  for (let j = i + 1; j < roles.length; j += 1) {
    if (roles[i][1] === roles[j][1]) {
      hm(
        `The ${roles[i][0]} and the ${roles[j][0]} are the same address.`,
        'Workable, and one compromised key then holds both roles.',
      );
    }
  }
}
if (roles.length === 3 && new Set(roles.map(([, a]) => a)).size === 3) {
  ok('the three roles are three distinct addresses');
}

// ------------------------------------------------------------ the config --

section(3, 'Configuration that differs from testnet');

const envExample = join(ROOT, 'scripts', '.env.example');
if (existsSync(envExample)) {
  const text = readFileSync(envExample, 'utf8');
  ok(`scripts/.env.example documents ${(text.match(/^[A-Z][A-Z0-9_]*=/gm) ?? []).length} variables`);
} else {
  no('scripts/.env.example is missing, so the configuration surface is undocumented.');
}

/*
 * MEASURED HERE, NOT RESTATED. This line printed a dated snapshot: 676 was chosen at
 * INJ $7.92 on 11 Oct 2026, INJ was $9.09 five days later, so the same constant
 * opened a launch at $5,727 against the $5,000 it was picked for and the constant
 * for $5,000 was 590. Every figure was true and attributed, and it was still the one
 * number in this report that is wrong on the morning it gets read: fourteen per cent
 * of drift in five days is the rate this premise goes stale at. Section 4 below
 * deliberately restates no pruning depth for exactly this reason, and the same
 * argument applies here with more force, because this is the line a hurried operator
 * would copy.
 *
 * DERIVED BY RUNNING THE DERIVER, so there is one implementation of the price read
 * and one of the arithmetic. That script refuses when no venue answers or when two
 * disagree by more than 2%, and a refusal is reported as "not from here" rather than
 * falling back to a number. The curve has no oracle, deliberately, so the constant
 * is only ever as current as the morning somebody derived it.
 */
let derivedScale = null;
try {
  const out = execFileSync('node', [join(ROOT, 'scripts', 'derive-curve-scale.mjs'), '5000'], {
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  derivedScale = out.match(/virtual_quote_whole = (\d+)/)?.[1] ?? null;
} catch {
  /* No venue, or two that disagree. Either one is an answer, and it is not a number. */
}
/*
 * REPORTED AGAINST THE DECISION, NOT AGAINST A MEMORY. This used to say flatly that
 * the reserve "must be re-derived for mainnet", every run, forever - an instruction to
 * remember something at the worst possible moment. `deploy.mjs` now refuses a constant
 * that has drifted past MAX_DRIFT from `INJ_OPEN_TARGET_USD`, so when that target is
 * set this is a measurement with a verdict rather than a standing reminder.
 */
const configuredScale = Number(process.env.INJ_QUOTE_VIRTUAL_WHOLE?.trim() || '');
const openTarget = Number(process.env.INJ_OPEN_TARGET_USD?.trim() || '');
if (derivedScale && configuredScale > 0 && openTarget > 0) {
  const drift = (configuredScale - Number(derivedScale)) / Number(derivedScale);
  const pct = `${drift >= 0 ? '+' : ''}${(drift * 100).toFixed(1)}%`;
  if (Math.abs(drift) <= 0.15) {
    ok(`the opening reserve is current: ${configuredScale} against ${derivedScale} for a $${openTarget.toLocaleString('en-US')} open (${pct}), and deploy.mjs refuses it if it drifts`);
  } else {
    no(
      `INJ_QUOTE_VIRTUAL_WHOLE=${configuredScale} has drifted ${pct} from the $${openTarget.toLocaleString('en-US')} in INJ_OPEN_TARGET_USD.`,
      `It should be about ${derivedScale}. deploy.mjs will refuse this. Run node scripts/derive-curve-scale.mjs ${openTarget} and read what that curve does.`,
    );
  }
} else if (configuredScale > 0 && !(openTarget > 0)) {
  hm(
    'INJ_OPEN_TARGET_USD is not set, so nothing can tell whether the opening reserve is still the figure you chose.',
    'Set it to the dollar cap you intended. deploy.mjs then refuses a stale constant instead of shipping one.',
  );
} else {
  hm(
    'The opening reserve must be re-derived for mainnet.',
    derivedScale
      ? `For a $5,000 open at INJ's price just now, INJ_QUOTE_VIRTUAL_WHOLE=${derivedScale}. Run node scripts/derive-curve-scale.mjs 5000 and read what that curve does before using it.`
      : 'node scripts/derive-curve-scale.mjs 5000. No venue priced INJ from here, so nothing is derived: whatever is in use is a premise about the day it was chosen.',
  );
}

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

      AN ARCHIVAL RPC, and archival is the half that is easy to miss. The
      public sentry LCD will rate limit under real traffic, and it also PRUNES.
      The chart, the trade history and the 24h volume all come from transaction
      search, so on a pruning endpoint a launch's history empties out overnight.
      Section 1 above measured the window live; this section deliberately
      restates no number, because the hostname balances across nodes pruned to
      different depths and the figure MOVES BETWEEN RUNS: three runs on
      16 Oct 2026 answered ~30,600 blocks, ~43,000 and 100,002, a threefold
      spread in an afternoon. A snapshot printed here beside a live measurement there is
      two numbers for one property, and a reader has no way to tell which is
      current. Ask a provider what height their tx search reaches back to rather
      than what the quota is, and take more than one sample.

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
