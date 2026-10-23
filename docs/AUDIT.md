# Internal security review log

Not a third-party audit. Findings from reviewing the contracts, app and scripts
against what Pons (`ponsdotdev/pons-labs`) and nearly.trade do. Newest first.
Severity uses the usual scale: Critical / High / Medium / Low / Info.

## 2026-10-11 review, sixth pass (the chart, the curve scale, and a share link)

Triggered by promoting candles to the launch page's main chart and rescaling the curve
so a launch opens at about a $5,000 market cap.

### Fixed

| # | Sev | Finding | Fix |
|---|---|---|---|
| 37 | Medium | **Every candle was a 1-pixel dash.** Measured on the live page: 5 trades across 9 blocks asked for 40 candles gave a span of 1 block, so each bucket held exactly ONE trade and every candle had `open == close == high == low`. Every figure was correct and the chart showed nothing. This is the normal state of a new launch, which is when the chart matters most. | The bucket count is bounded by trade density (two per candle) as well as by the block range; a busy launch still fills all 40. Re-measured on the deployed page: 3 candles, bodies 7.7px, 178.6px and one doji. |
| 38 | Medium | **The bonding curve was the headline and the candles were a 60-pixel strip underneath it.** The curve is a property of the contract, identical on every launch here, and it does not move when the market does. | Candles are the main chart with a price axis and a last-close line; the curve is a tab. With no trades the curve still leads, because an empty candle chart is worse than no chart. |
| 39 | Medium | **Sharing a launch produced a relative URL.** `ShareRow` read `window.location`, so the server rendered the X intent with `url=/launch/VETTA` and the client replaced it after hydration: a mismatch React reports, and a share link that went nowhere for anyone clicking before hydration or reading the markup without running it. The site origin was also written out three times. | One `SITE_URL` in `brand.ts`, used by the layout, the sitemap and the share row. |
| 40 | Medium | **One opening reserve for every quote asset.** The constant that opens an INJ launch at about $5,000 opens a 6-decimal dollar-stablecoin launch at about $630, and nothing on chain or on screen said so. The e2e suite itself runs a second quote, so this was exercised. | `QuoteSpec { decimals, virtual_quote_whole }`: the scale is stated by the admin when an asset is allowlisted, refused at zero or beyond a cap, reported on `Quotes {}` and read by the app instead of its own constant. |
| 41 | Low | **The deploy script could not store a 356 KB module.** The SDK simulates to estimate gas and Injective charges txSize gas against the simulate's own limit; ~3.65M needed against a 600,000 default, reported only as `INVALID_ARGUMENT`. | `storeCode` passes an explicit limit. 300 KB of random bytes simulating fine is what ruled out size and transport: an invalid module is rejected before the txSize charge, a valid one is not. |

### Measurement notes

- **A `NEXT_PUBLIC_*` env change needs a redeploy, and the push-triggered build races it.**
  Twice in one day a build started seconds before the env edit landed and shipped the
  previous factory while reporting Ready. Grepping the served chunks for the address is
  the check; the page looks right either way.
- **Deleting `.next` under a running `next dev` breaks it the same way a `next build`
  does**, and the page then renders as server HTML with every client figure empty. I did
  it to myself this time, having diagnosed the identical symptom an hour earlier.

## 2026-10-11 review, fifth pass (deploying 39974/39975, and the front page's claims)

Triggered by pointing the app at the newly deployed contracts and reading the rendered
page against the chain. Scope: the launch URL, the homepage's factual claims, and the
two scripts that exist to verify a launch before it costs money.

### Fixed

| # | Sev | Finding | Fix |
|---|---|---|---|
| 31 | High | **The page claimed an audit that does not exist.** The launch page read "Audited contract (code 39974)" with a green "Audited code 39974" badge above the buy button, while `AUDIT.md` opens with "Not a third-party audit" and `AUDIT_SCOPE.md` is written for an auditor nobody has engaged. To a trader "audited" means a named third party reviewed the code and signed for it. | Says what is actually established, which is three chain reads: the code id matches the one this launchpad published, there is no upgrade key, and the launch contract holds the mint key. `trust-claims.test.ts` fails on the word in any user-facing string, and asserts `AUDIT.md` still disclaims being an audit, so the guard cannot outlive its premise. Mutation-verified. |
| 32 | High | **The homepage hero priced a curve no launch gets.** `CurveExplorer` and `demo.ts` each held their own copy of the curve shape, still 30/85 after launches moved to 60/170. The hero advertised graduation at 88 INJ against a real 176, and quoted 15,197,452 tokens per INJ where a launch gives 7,680,861, under a docblock asserting every number is real. 245 app tests, 135 contract tests and the typecheck were all green. | Both spread `fixedCurveFor`; the default fee has one definition (`DEFAULT_FEE_BPS`). `curve-shape-single-source.test.ts` fails on any numeric curve-shape literal outside `launchLimits.ts` and on the hero not spreading it. Mutation-verified both ways. |
| 33 | Medium | **The hero's figures mixed two scopes under one row of labels.** "Total liquidity 75.71 E2EUSD" and "Paid to creators 2.02 E2EUSD" are one quote's figures, beside a board-wide "Launches 2", on a board also holding 4.25 INJ. "Graduated" was scoped to that one quote too. The arithmetic was right (summing across quotes would add 18-decimal INJ to 6-decimal USDC) and the labels were the lie. | Money figures name their quote when the board has more than one; `Graduated` is a count, so it spans every pair. |
| 34 | Medium | **`/launch/1` was a row id on the address bar.** It identifies nothing, is unrecognisable when pasted, and makes a token read as a record. | `/launch/VETTA`. A ticker is NOT unique (`factory/<creator>/<SUBDENOM>`), so a shared ticker gets `/launch/INJINU-7` and the bare form renders a chooser rather than picking one. 16 tests, most of them on the ambiguous cases, including the near-miss where a stale `SYMBOL-id` names the right id and the wrong ticker. |
| 35 | Medium | **Both verification scripts verified a path the app does not take.** `dry-run-create.mjs` exists to prove the message shape before Injective charges the 1 INJ denom fee. It restated five messages by hand, had drifted to a `create_launch` payload of `{ denom, fee_bps }`, and omitted `MsgChangeAdmin` entirely, so every run failed inside the factory's reply with `unauthorized account` and read as a contract bug. `create-test-launch.mjs`, which actually spends the fee, had the same restatement. | Both import `planLaunch` and `composeMessages` from the app. The dry run asserts the plan still contains the admin handover, in the right order, and simulates two shapes: the plain launch and one carrying every optional field. |
| 36 | Low | `trade-test.mjs`'s docblock described a different script. Copied from `create-test-launch.mjs` and never rewritten, it documented an argument the file does not take. | Rewritten. A comment describing a control is part of the control. |

### Measurement notes

- **Three defects I nearly reported were artifacts of a broken dev server.** The board
  showed `·` for every 24h volume and trade count and rendered no trending strip. The
  enrichment was fine: a `next build` had overwritten `.next` under a running `next dev`,
  so every `_next/static/chunks/*.js` was a 404 served as `text/plain` and the page had no
  working JavaScript at all. The server-rendered HTML looked like a page with missing
  data. Establish the measurement is sound first; the console was the thing that said so.
- **A `NEXT_PUBLIC_*` change needs a redeploy, not an env edit.** The push-triggered
  production build started before the env change landed and shipped the previous factory.
  Grepping the served chunks for the address is what caught it; the deployment said Ready
  and the page looked right.

## 2026-10-11 review, fourth pass (everything, plus the live site)

Triggered by screenshots of production. Scope: git history, contracts, app, scripts,
deployment.

### Fixed

| # | Sev | Finding | Fix |
|---|---|---|---|
| 23 | High | **Creating a launch from the browser could never sign.** `plan` was computed above `builtRules` and `devBuy`; with a wallet connected it hit the temporal dead zone and the try/catch showed it as a form error. Present on production. | Reordered. New guard `hook-order.test.ts` fails on any hook reading a later-declared hook value; run against the old code it flags exactly this. |
| 24 | High | **Price and market cap were 0 on every 6-decimal pair** (live: PAIR5277 with 9.90 TUSD reserve showed MC 0.00). The per-token price was floored to a whole base unit first. | `marketCapExact` (one division from reserves) and `spotPriceWad` (18 extra digits). |
| 25 | High | **Create form treated every pair as 18-decimal INJ**: curve preview, labels, and the opening buy ("5" on a USDC pair = 5x10^18 base units, reverted after signing). Switching pair also did not refresh the signed plan. | `fixedCurveFor(decimals)`, the pair's label throughout, missing memo dep added. |
| 26 | Medium | An opening buy combined with a future start time, or larger than the wallet cap, reverted the whole launch inside the reply with an opaque error, after signing. | The factory refuses both by name before instantiating (`InitialBuyBeforeStart`, `InitialBuyOverCap`). The form flags the start-time case as you type. 3 new factory tests. |
| 27 | Medium | Trade ticker printed every amount at 18 decimals as INJ ("0 INJ" for a TUSD buy). | Each launch's own quote decimals and label. |
| 28 | Medium | `quote-test.mjs` / `quote-trade-test.mjs` created launches without the mint-key handover, so they would revert against the new factory. | `MsgChangeAdmin` added. The SDK version used by the scripts (1.20.55, the same line as the app) exports it; checked. |

### Checked, nothing to fix

- **Secrets:** no secret-named file in any commit of any branch. Content scan for seed
  phrases, hex keys, JWTs and provider tokens finds only prose. Scripts read keys only
  from `scripts/.env.local` at runtime.
- **Dependencies:** `npm audit --omit=dev` reports 0 for `app/` and for `scripts/`.
- **Factory `create_launch`:** exact supply, quote allowlist, initial-buy ceiling,
  unexpected funds refused, no curve admin, and the mint-key handover forces a real
  tokenfactory denom the creator controlled.
- **Hardcoded INJ / 18 decimals** across components: every remaining 18 is a token
  amount (launch tokens are always 18 decimals). Every remaining INJ label is the gas
  balance or explanatory copy for the default pair.
- **Wallets:** unknown-chain suggestion for `injective-888` is handled and tested.

### Open, operational (see `docs/RELEASE.md`)

- Production points at the old factory. Merging before the new deploy would correctly
  flag all three live launches unsafe and disable trading on them. Follow the release order.
- ~~Quotes shown as hex~~: fixed. `SetQuote` takes an optional `symbol` (1 to 12
  letters, digits, dot or dash), returned by `Quotes` and used everywhere the app
  labels a quote. Mainnet USDT/USDC (peggy hex denoms) must be allowlisted with a symbol.
  The `0x0514…4f78` quote on the old factory is a test token, so it can stay as hex there.
- GitHub Actions: no runner assigned, so no CI has run on this PR (billing or minutes).

## 2026-10-11 review, third pass (app, UI, dependencies)

### Fixed

| # | Sev | Finding | Fix |
|---|---|---|---|
| 16 | High | On a phone the header chips pushed **Connect wallet** off-screen: a phone user could not connect at all. | Chips and wordmark hide below 640px; verified by screenshot at 390px. |
| 17 | High | `npm audit`: PostCSS advisories (GHSA-qx2v-qp2m-jg93 and the sourceMappingURL set), pinned inside Next 15. | `overrides.postcss ^8.5.10`; `npm audit --omit=dev` reports 0. |
| 18 | Medium | No `next.config`, so no security headers: no CSP, frameable (clickjacking on a page that asks a wallet to sign), no HSTS. | `app/next.config.ts`: CSP (`frame-ancestors 'none'`, `connect-src` limited to this origin and `*.injective.network` plus the LCD override, fonts self-hosted), `X-Frame-Options: DENY`, nosniff, HSTS, Referrer- and Permissions-Policy, COOP. |
| 19 | Medium | The launch page's market cap ignored the pool after graduation (one call site the earlier sweep missed). | Passes `detail.pool`. |
| 20 | Low | Demo cards could show negative trade counts ("-16 trades"): a signed shift on an unsigned seed. | `>>>`; regression test over 300 addresses, mutation-checked. |
| 21 | Low | Three places still said graduated tokens "trade on a DEX". | Now says they trade against the locked pool. |
| 22 | Info | Accessibility and SEO were unmeasured. | axe-core 4.10 on home, two launch pages, create, watchlist, creator: **0 violations, 241 passing checks** (incl. contrast on the new palette). Skip link, reduced-motion, `sitemap.xml`, title template and Open Graph metadata added. |

### Open

- CSP still allows `'unsafe-inline'` scripts (the App Router's inline bootstrap). Closing
  it needs nonce middleware; worth doing before mainnet.

## 2026-10-11 review, second pass

### Fixed

| # | Sev | Finding | Fix |
|---|---|---|---|
| 10 | Critical | The creator stayed **admin of their tokenfactory denom**, which mints without limit. After graduation they could mint any amount and sell it into the locked pool until it was empty, and before that they could dump into the curve reserve. The create page already promised "nothing can mint more afterwards"; it was not true. | The launch tx now hands denom admin to the factory (`MsgChangeAdmin`), and the factory's reply hands it to the new curve, which has no mint code and no wasm admin. If the creator skips the handover, the factory's message is refused and the whole launch reverts. Tests: `the_mint_key_ends_with_the_curve_where_nothing_can_use_it`, `a_creator_who_keeps_the_mint_key_cannot_launch` (simulated tokenfactory enforcing the admin rule; mutation-checked). |
| 11 | High | Nothing stopped the UI offering trades on a curve built from code the admin had repointed to, or one with an upgrade key or a live mint key. | `lib/codeCheck.ts`: the launch page reads code id, code hash, wasm admin and denom authority from the chain and disables trading with an explanation on any mismatch. |
| 11a | High | The code check compared a **code id**, which nobody outside can verify. "39974" is a pointer only whoever uploaded it can vouch for, so "runs this launchpad's published contract" rested on our word. Code ids are append-only on CosmWasm, so the id check was not *forgeable*; it was *unverifiable*, and a code id also means a different contract on a different chain. Raised as F-01 in the 19 Oct 2026 external audit. | `NEXT_PUBLIC_CURVE_CODE_HASHES` pins the sha256 of the released wasm and decides the verdict on its own where it is set. `codeHashOf` reads `code_info.data_hash` from the chain, streamed so the 400 KB module in the same response is never downloaded (hash in the first 2,530 bytes of 409,840, measured). The status carries **which** pin passed, so an id-only build says the weaker thing it can honestly say instead of the stronger thing it cannot. Reproducible: `shasum -a 256 target/wasm32-unknown-unknown/release/curve.wasm` equals the chain's hash for code 39974 (`3196401753e1…53d9db`, both measured 19 Oct 2026). All three states driven end to end against testnet; 15 mutations, 15 caught. |
| 11b | Low | **The fee rate and the fee amount disagreed, and each was right about its own basis.** During an opening window the row read `chargedBps`, the *sum* of the premium and the curve's fee, above an amount produced by applying them *in sequence*: the premium comes off the top and the curve's fee is charged on what is left. F-11 in the 19 Oct 2026 external audit measured it on AUDLAB7, "Fee 4.45 percent" above 0.004415 INJ on a 0.1 INJ buy, which is 4.4155%. The note underneath invited the same addition ("3.45% above the curve's 1.00%"). On a product whose claim is that every cost is named before you sign, the disclosure is the worst place to carry it. | `effectiveFeeBps(totalFee, afterFee)` in `curve.ts` measures the rate back out of the two amounts, so the label cannot disagree with the figure beside it, on either side. The separate exit-rate constant is gone: one derivation covers buys and sells, which also retires the earlier defect where the label read the buy fee above a sell's amount. `null`, never 0%, where there is no basis. The note states the sequence and points at the combined rate instead of restating it. Verified live on AUDLAB7 at 156s into its 5 min window: "Fee · 2.90%" above 0.0029 INJ on 0.1 INJ, where the old label said 2.92%. 6 mutations, 6 caught. `early-fee-basis.test.ts`, `sell-fee-basis.test.ts`. |
| 11c | Low | **The same launch could be sent twice, and the second one could only ever burn gas.** F-05 in the 19 Oct 2026 external audit measured it: testnet block 143426568 created `ghdsjs`, and eight seconds later block 143426582 ran the same `create_launch` and failed. The re-entry guard was never the defect - `busy` is set before the signature is requested - `setBusy(false)` in the `finally` re-**armed** the button over a form that still said `ghdsjs`, and a creator who does not yet see their new row presses the only button on the screen again. The denom already existed, so the chain refused the whole transaction and what they got for the gas was an error. | Two guards, because neither covers the other's case. A **session latch** on the ticker that landed, set inside the branch that knows it landed, keyed on the symbol so launching a second *different* token stays legitimate. And a **chain read** of `denoms_from_creator`, which covers a reload, a second tab, and a ticker used days ago. `tickerAlreadyUsed` is a pure function so the two things that are invisible inline can be exercised: a denom is compared **byte for byte** (`GHDSJS` and `ghdsjs` are two denoms the chain will both create), and `null` is "not read", which neither blocks nor reassures. Both reasons feed one `disabled` and each names itself on screen. `authority_metadata` was measured first and **cannot** answer this: on testnet a nonexistent subdenom and a nonexistent creator both answer `200 {"admin":""}`, identical to a cleared admin. Confirmed live from the browser: the audit's own creator answers `[AUDCAP8, AUDLAB7]`, an unused address answers `[]`. 10 mutations, 10 caught. `create-double-submit.test.ts`. |
| 11d | Low | **The Create page told every visitor the signing path "has not yet been run against a chain".** F-10 in the same audit. It was written when the encoding had never left a unit test, and the audit's own F-05 finding *is* two create transactions in testnet blocks, one of which created a launch. A caution that has stopped being true costs what a missing one costs, because the next true caution reads like this one. | The caution is scoped to what genuinely has not been exercised, mainnet, and scoped by `NETWORK.name` rather than by a flag somebody has to remember to clear. The structural reassurance was the honest half and survives on both branches: all five messages are one transaction, so a mis-built launch is a refused transaction rather than a denom with no curve behind it. The old sentence is banned by source guard. |
| 12 | Medium | The upload limit was per instance. | `allowUploadShared` uses Upstash Redis when `UPSTASH_REDIS_REST_URL`/`_TOKEN` are set, and falls back to the in-memory limit (never unlimited) on outage. |
| 13 | Medium | Factory config admin was always the deploy key. | `INJ_FACTORY_ADMIN` (required on mainnet; multisig contract addresses work). |
| 14 | Info | Accounting was asserted on hand-picked sequences only. | 36 seeded random runs across graduation assert exact books and conservation of every unit after each step (mutation-checked). `docs/AUDIT_SCOPE.md` written for the external auditor. |
| 15 | Info | `env-surface.test.ts` flagged secrets by NAME anywhere in `src/`, which blocked legitimate server-only credentials and let `PINATA_JWT` pass on spelling. | Now asserts the real boundary: no secret-shaped `NEXT_PUBLIC_*`, and no unprefixed variable read in a `'use client'` file. |

### To verify on testnet (cannot be verified offline)

- The factory's reply sends `MsgChangeAdmin` as a stargate message. `factory.wasm` does
  not export a `requires_stargate` marker; the curve does. Confirm Injective dispatches
  the message (step 3 of `scripts/e2e-testnet.mjs` checks the denom authority).
- Injective accepts `MsgChangeAdmin` from a contract sender for a denom it administers.

## 2026-10-11 review

### Fixed

| # | Sev | Finding | Fix |
|---|---|---|---|
| 1 | Critical | Graduation `BankMsg::Send`-ed the whole reserve and every leftover token to `migration_target`, which `deploy.mjs` defaulted to the deploy key. Whoever held that key held all graduated liquidity. That is a rug path, and it is not what "graduates to a pool" means. | The curve contract becomes a constant-product pool at graduation (`launchpad-math/src/pool.rs`), seeded in the same tx as the graduating buy. No withdraw path. `migration_target` removed from both contracts. |
| 2 | High | Curves were instantiated with `admin: Some(factory)`. The factory's own wasm admin (the deployer) could upgrade the factory to code that migrates every curve and drains it. | Curves are instantiated with `admin: None`. Test: `a_launched_curve_has_no_wasm_admin_so_its_code_can_never_be_replaced`. |
| 3 | Medium | `UpdateAdmin` transferred factory admin in one step, so a typo bricked admin. | Two-step: `UpdateAdmin` proposes, `AcceptAdmin` from the proposed address completes it (as Pons does with `Ownable2Step`). |
| 4 | Medium | `deploy.mjs` silently used the deploy key as platform fee recipient when `INJ_PLATFORM_ADDRESS` was unset. | Refuses to run without it. Factory upgrade key is now explicit (`INJ_FACTORY_WASM_ADMIN`, required on mainnet, `none` = immutable). |
| 5 | Medium | `/api/upload` pinned anything to the operator's Pinata account with no rate limit, and parsed the whole body before checking its size. | Per-IP limit (10 per 10 min, per instance) and a `content-length` check before parsing. **Still open:** a platform-level limiter before mainnet (see below). |
| 6 | Low | The buy event emitted `buyer` twice (recipient, then sender), so indexers disagreed about who bought. | Second key renamed to `sender`. |
| 7 | Low | The trade feed accepted wasm events from any contract in a matching tx, so another contract's buy could be shown as this launch's. | Filtered on `_contract_address`. |
| 8 | Low | `die()` in `deploy.mjs` printed only the first hint line; multi-line refusals lost their explanation. | Prints all hints. |
| 9 | Info | No CI: 300+ tests ran only when someone remembered. | `.github/workflows/ci.yml`: cargo test, the wasm build with export and opcode checks, tsc, app tests, next build. |

### Open, in priority order (updated in the second pass)

1. **Testnet end-to-end on the new contracts.** Redeploy with `scripts/deploy.mjs`, then
   `npm --prefix scripts run e2e` (one command, about 3 INJ, mints its own test quote so
   graduation does not need 87 INJ), then the same flow from the browser. The old testnet
   factory has the custodial graduation and creator mint keys and must not be used.
2. **Third-party audit** before mainnet. Send `docs/AUDIT_SCOPE.md`.
3. Set `UPSTASH_REDIS_REST_URL`/`_TOKEN` (or Vercel Firewall) in production. *(code done)*
4. Set `NEXT_PUBLIC_CURVE_CODE_HASHES` in production to the sha256 of the released
   `curve.wasm`, which `deploy.mjs` prints. Prefer it to `NEXT_PUBLIC_CURVE_CODE_IDS`:
   it is the only pin a reader can reproduce from this repository. *(code done)*
5. Create the multisig and pass it as `INJ_FACTORY_ADMIN` and `INJ_FACTORY_WASM_ADMIN`
   on mainnet. *(code done)*
6. **Holders panel** needs an indexer over bank events (`denom_owners` returns 501 for
   tokenfactory denoms).
7. ~~Align `@injectivelabs/sdk-ts` versions~~: the scripts' lockfile already resolves 1.20.55.
8. An optional external-AMM adapter for graduation, once an Injective AMM's testnet
   address is verified on chain rather than inferred.

### Verified properties (by test)

- Curve and pool: rounding always favours the pool, a round trip never profits, `k`
  never decreases (`launchpad-math` unit tests, curve integration tests).
- After graduation the contract holds exactly `pool_quote + owed fees` in quote and
  exactly `pool_tokens` in tokens. Nothing is stranded or leaked.
- `SimulateBuy` / `SimulateSell` equal execution in both phases, **including during an
  opening-fee window**, asserted at seven points of the decay and on a buy that
  overshoots the curve
  (`the_simulation_promises_what_the_buy_delivers_during_the_opening_window`).
  - This bullet was here before any test asserted it, and it was false. `query` took
    `_env` and discarded it, so `SimulateBuy` could not know the block time and quoted
    the base curve for the whole duration of a window, promising tokens `exec_buy`
    would refuse to deliver. The execution side was correct and well covered; the two
    were never compared, because the only helper that reads the simulation
    (`quoted_tokens`) is used solely by fixtures with `early_fee: None`. A property
    listed as verified by test, with no test, is the same defect as a status reported
    without being checked.
- The TypeScript port equals the Rust to the unit on curve and pool vectors generated
  by the Rust (`npm run vectors`), and the opening premium's basis is asserted against
  a transcription of `exec_buy` over 5 premiums x 8 sizes (`early-fee-basis.test.ts`).
  The vectors alone could not cover the premium: they are generated from
  `launchpad-math` and the premium is contract-level, so the panel's wrong basis had no
  Rust number to disagree with.
