# Internal security review log

Not a third-party audit. Findings from reviewing the contracts, app and scripts
against what Pons (`ponsdotdev/pons-labs`) and nearly.trade do. Newest first.
Severity uses the usual scale: Critical / High / Medium / Low / Info.

## 2026-10-11 review, second pass

### Fixed

| # | Sev | Finding | Fix |
|---|---|---|---|
| 10 | Critical | The creator stayed **admin of their tokenfactory denom**, which mints without limit. After graduation they could mint any amount and sell it into the locked pool until it was empty, and before that they could dump into the curve reserve. The create page already promised "nothing can mint more afterwards"; it was not true. | The launch tx now hands denom admin to the factory (`MsgChangeAdmin`), and the factory's reply hands it to the new curve, which has no mint code and no wasm admin. If the creator skips the handover, the factory's message is refused and the whole launch reverts. Tests: `the_mint_key_ends_with_the_curve_where_nothing_can_use_it`, `a_creator_who_keeps_the_mint_key_cannot_launch` (simulated tokenfactory enforcing the admin rule; mutation-checked). |
| 11 | High | Nothing stopped the UI offering trades on a curve built from code the admin had repointed to, or one with an upgrade key or a live mint key. | `lib/codeCheck.ts`: the launch page reads code id, wasm admin and denom authority from the chain, compares them against `NEXT_PUBLIC_CURVE_CODE_IDS`, and disables trading with an explanation on any mismatch. |
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
4. Set `NEXT_PUBLIC_CURVE_CODE_IDS` in production to the audited code id. *(code done)*
5. Create the multisig and pass it as `INJ_FACTORY_ADMIN` and `INJ_FACTORY_WASM_ADMIN`
   on mainnet. *(code done)*
6. **Holders panel** needs an indexer over bank events (`denom_owners` returns 501 for
   tokenfactory denoms).
7. Align `@injectivelabs/sdk-ts` between `app/` (^1.20) and `scripts/` (^1.14), after
   the scripts have run once on testnet with the current version.
8. An optional external-AMM adapter for graduation, once an Injective AMM's testnet
   address is verified on chain rather than inferred.

### Verified properties (by test)

- Curve and pool: rounding always favours the pool, a round trip never profits, `k`
  never decreases (`launchpad-math` unit tests, curve integration tests).
- After graduation the contract holds exactly `pool_quote + owed fees` in quote and
  exactly `pool_tokens` in tokens. Nothing is stranded or leaked.
- `SimulateBuy` / `SimulateSell` equal execution in both phases.
- The TypeScript port equals the Rust to the unit on curve and pool vectors generated
  by the Rust (`npm run vectors`).
