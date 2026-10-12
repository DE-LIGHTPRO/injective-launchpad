# Session handoff (2026-10-11)

Continue point for picking this up in another Claude Code session. Delete once consumed.
Branch: `claude/eager-ramanujan-0yui7v`, merged to `main`. Everything below is committed
and pushed.

## Current deployment (11 Oct 2026, 23:40 UTC+1)

Injective **testnet**. These are what production runs; anything earlier in this file that
names a different factory or code id is superseded.

| | |
|---|---|
| factory | `inj198s2h3ns8u54jllxgt7u5nurqnvezqk6jt659c` |
| curve code id | `39974` (factory code id `39976`) |
| deploy / platform wallet | `inj10lx8xhswguun9s0htmqk8wvzymjteudmt9hjhl` |
| site | https://injpad.vercel.app, Git-sourced from `main` |

Vercel production env is set to the above. `NEXT_PUBLIC_*` is **inlined at build time**, so
changing one of these requires a REDEPLOY, not just an env edit: the push-triggered build
that happened to start before the env change shipped the previous factory, and the only way
that was caught was grepping the served chunks for the address.

What the new contracts added over `39971/39972`: separate buy and sell fees capped at 10%
per side, a reward route (`creator` | `pool`), and a rescaled curve.

**The curve opens a launch at a market cap of 630 INJ**, about $4,990 at the INJ price
measured on 11 Oct 2026 (Coinbase 7.923, Binance 7.917). It was 55.92 INJ, about $443.
Graduation is a RATIO of the opening reserve (17/6), not a second constant, so the shape
is identical whatever a quote is scaled to: target is 96.7% of the curve ceiling, 99.1%
of the curve supply sold at graduation, 14.69x from open to graduation. A 10 INJ buy at
the open now costs 2.49% in impact instead of 17.68%.

**The opening reserve belongs to the QUOTE, not to the launchpad.** `QuoteSpec` carries
`virtual_quote_whole` per allowlisted asset, because 676 opens an INJ launch at about
$5,000 and would open a dollar-stablecoin launch at about $630. Set it deliberately when
allowlisting an asset; zero and absurd values are refused. The dollar figure is a premise
about one day's INJ price, not a property: there is no oracle and nothing renders a
dollar amount.

**Storing a contract needs an explicit gas limit.** `MsgBroadcasterWithPk` simulates to
estimate gas and Injective charges txSize gas against the simulate's own limit; a 356 KB
module costs ~3.65M against a 600,000 default and the SDK reports only
`Simulate ... failed with INVALID_ARGUMENT`. `scripts/deploy.mjs` passes `STORE_CODE_GAS`.
`INJ_CURVE_CODE_ID` / `INJ_FACTORY_CODE_ID` reuse an existing code id after verifying its
hash, which is the right move when only one contract changed.

### Mainnet launch fee, written and NOT yet deployed

The factory charges `launch_fee` (config, default 0) on `CreateLaunch` and forwards
it to `platform` in the same transaction. Set it at deploy with
`INJ_LAUNCH_FEE=0.2`, or afterwards with `SetLaunchFee` as admin. Capped at 5 INJ by
`MAX_LAUNCH_FEE`, because an admin who can price launching out of reach can close
the launchpad.

**It is not Injective's denom fee.** The chain charges a flat **1 INJ** on
`MsgCreateDenom` (`denom_creation_fee`, measured 12 Oct 2026); that goes to the
chain and nothing here can redirect or waive it. A creator on mainnet pays
1 INJ + 0.2 INJ + gas, and the create form itemises the two separately.

**The fee rides in the same coin as the opening buy.** A wallet cannot attach two
separate `inj` entries; the bank module merges them first. The factory splits by
subtraction and the app merges before building, so what is built is what the chain
sees. Getting this wrong silently turns a creator's dev buy into the fee.

Still to do: fund the deploy wallet, then
`INJ_LAUNCH_FEE=0.2 INJ_CURVE_CODE_ID=39974 node scripts/deploy.mjs`, point the app
at the new factory and REDEPLOY (see the inlining note above).

Verified on chain, not just in tests: `scripts/dry-run-create.mjs` (both message shapes),
`scripts/e2e-testnet.mjs` (all 8 steps including graduation and a 70/30 payout), and a live
launch `VETTA` with 10 real trades.

## What happened this session

1. **GitHub Actions unblocked.** `blofin-toolkit`'s scheduled scanner (daily-scan.yml) was
   burning the 2,000 free minutes; its cron triggers were paused. `injective-launchpad`
   was made **public**, so CI is free and now green on PR #1.
2. **New testnet contracts deployed** (from the user's Mac). Keep these:
   - **SUPERSEDED 11 Oct 2026**, see "Current deployment" at the top of this file.
   - factory: `inj1ey75764z7v264nttr2v38pnwmd67q79dptjwhq`
   - curve code id: `39971`  ·  factory code id: `39972`
   - deploy/signing wallet: `inj10lx8xhswguun9s0htmqk8wvzymjteudmt9hjhl`
3. **App pointed at the new factory for local testing** via `app/.env.local` on the Mac
   (NEXT_PUBLIC_FACTORY_ADDRESS, NEXT_PUBLIC_CURVE_CODE_IDS=39971, NEXT_PUBLIC_NETWORK=testnet,
   NEXT_PUBLIC_LCD_URL=testnet sentry; no NEXT_PUBLIC_DEMO). Vercel env NOT updated (its old
   vars were saved as Secret type and need deleting + re-adding as Config before that route).
4. **Four signing-path bugs found by live testing and fixed (all pushed):**
   - Keplr testnet connect: matched Keplr's "no modular chain info" wording so it offers to
     add the chain (`wallet.ts`).
   - Create/FeeEarnings read the connected wallet from the shared store, not local state
     (`CreateLaunch.tsx`, `FeeEarnings.tsx`, guard `wallet-store-wiring.test.ts`).
   - Denom metadata built in camelCase the SDK encodes (`denomUnits`/`uriHash`), was
     snake_case → "reading 'map'" at sign time (`broadcast.ts`, test in `broadcast.test.ts`).
   - Broadcast moved to a server route `/api/broadcast` (browser POST to the LCD was blocked
     by CORS preflight → silent no-op). `lib/txBroadcast.ts`, `app/api/broadcast/route.ts`.
   - Broadcast the bytes the WALLET signed (`res.signed`), not our originals → fixed
     `code=4 unauthorized signature` (`broadcast.ts`).

## The one remaining blocker to a successful create

The create now signs, broadcasts, and EXECUTES. It fails only on funds:
`message index 0: spendable 0.9954 INJ < 1 INJ: insufficient funds`.
Injective charges a **1 INJ tokenfactory denom-creation fee** (per `MsgCreateDenom`), and the
wallet is at 0.9954 INJ. **Fix: fund `inj10lx8…` to ~2 INJ** (Google faucet resets ~1pm, or
make a fresh wallet, faucet 10 INJ, send some over). Then Create should land. No code change.

## To clean up once a create succeeds

- Remove the temporary `console.error('[broadcast] …')` lines in `lib/txBroadcast.ts`.

## Feature backlog the user approved ("everything")

Done this session:
- [x] **Board stage tabs** — All / Live / About to graduate / Graduated, with live counts
      (commit on branch). `lib/launchList.ts` (`status`, `matchesStatus`, `ABOUT_TO_GRADUATE`),
      `LaunchList.tsx`, `globals.css`, tests in `launch-list.test.ts`.
- [x] **Portfolio page** `/portfolio` — wallet holdings across launches, valued per quote
      from the board's marketCap; `allBalances` in `wallet.ts`, `Portfolio.tsx`, nav links.
- [x] **Slippage protection** — ALREADY EXISTED in `TradePanel.tsx` (slippage % selector,
      default 1%, sends `min_tokens_out`/`min_inj_out` as the on-chain guard). No work needed.

Remaining:
- [x] **Trending strip** — DONE, with two departures from the note above, both deliberate.

      NOT BY 24H VOLUME. Volume is denominated in each launch's quote, so ranking an INJ
      launch against a USDC one by volume ranks amounts of different assets, and there is
      no price oracle here to convert with. It ranks by TRADE COUNT in about a day
      (`trades24h`), which is the one activity measure that survives crossing a pair
      boundary, and is also the honest meaning of the word: one enormous trade is not
      trending, forty small ones are.

      NO SHARED HOOK. The strip renders INSIDE `LaunchList`, where the enrichment already
      is, so nothing was lifted and no fetch was duplicated. A loader shared with a
      page-level strip would have been more machinery for the same result.

      `trades24h` is counted from the page of trades already fetched, so it costs nothing
      and is bounded the same way the volume is. It returns 0, not null, for an unknown
      height: unlike `volumeWithin`, this feeds a ranking, where the only sensible place
      for a launch we could not measure is the bottom.

Still blocked (need infra, not now): holders list (Injective `denom_owners` returns 501 for
tokenfactory denoms — needs an indexer); per-token comments (need a backend/DB).

## How to continue locally

```
cd ~/Desktop/injective-launchpad
git checkout claude/eager-ramanujan-0yui7v && git pull
# then, to a fresh Claude Code session:
# "Continue the Vetta launchpad on branch claude/eager-ramanujan-0yui7v.
#  Read CLAUDE.md, docs/AUDIT.md and docs/HANDOFF.md first."
```
Checks before any push: `npx --prefix app tsc --noEmit`, `npm --prefix app test`,
`npx --prefix app next build`.
