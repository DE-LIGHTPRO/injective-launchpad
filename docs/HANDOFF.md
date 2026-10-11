# Session handoff (2026-10-11)

Continue point for picking this up in another Claude Code session. Delete once consumed.
Branch: `claude/eager-ramanujan-0yui7v`. Everything below is committed and pushed.

## What happened this session

1. **GitHub Actions unblocked.** `blofin-toolkit`'s scheduled scanner (daily-scan.yml) was
   burning the 2,000 free minutes; its cron triggers were paused. `injective-launchpad`
   was made **public**, so CI is free and now green on PR #1.
2. **New testnet contracts deployed** (from the user's Mac). Keep these:
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
