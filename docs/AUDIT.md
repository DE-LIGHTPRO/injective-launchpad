# Internal security review log

Not a third-party audit. Findings from reviewing the contracts, app and scripts
against what Pons (`ponsdotdev/pons-labs`) and nearly.trade do. Newest first.
Severity uses the usual scale: Critical / High / Medium / Low / Info.

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

### Open, in priority order

1. **Testnet end-to-end on the new contracts.** The old testnet factory has the
   custodial graduation and must not be used. Redeploy, then run create, buy, graduate,
   pool buy/sell and claim from `scripts/` and from the browser.
2. **Third-party audit** before mainnet. Focus areas: `seed_pool`, the pool maths'
   rounding, refund paths in `exec_buy`, the factory reply.
3. **Platform rate limit on `/api/upload`** (Vercel Firewall, or an Upstash limiter).
   The in-memory limit is per instance.
4. **Code-id pinning in the UI.** The factory admin can repoint FUTURE launches at new
   curve code. The app should read each curve's `code_id` (`/cosmwasm/wasm/v1/contract/{addr}`)
   and warn on anything but the audited one.
5. **Multisig** for factory admin and factory wasm admin on mainnet.
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
