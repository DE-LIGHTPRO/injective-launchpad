# inj·pad: project memory

Read this first each session, and update it when something here stops being true.
The full review log is `docs/AUDIT.md`; the product overview is `README.md`.

## What this is

A one-sided bonding-curve launchpad on Injective (CosmWasm), benchmarked against
**Pons** (`ponsdotdev/pons-labs`, EVM: curve → permanently locked Uniswap V4 position)
and **nearly.trade** (NEAR: fixed 1B supply, same opening price for every launch, 70% of
the pool fee to the creator). When choosing behaviour, check what those two do first.

## Layout and commands

- `packages/launchpad-math` (curve + `pool.rs`), `contracts/curve`, `contracts/factory`, `app/` (Next 15), `scripts/`.
- `cargo test` · `npm --prefix app test` · `npx --prefix app tsc --noEmit` · `bash scripts/build-wasm.sh` (needs Rust 1.81 + wasm32 target).
- Changed the maths? Run `npm --prefix app run vectors`. The TS test fails if the vectors are stale.
- CI: `.github/workflows/ci.yml` runs all of the above.

## Decisions already made (don't re-litigate without new facts)

- Fixed policy for every launch: 1B supply, 800M on the curve / 200M reserve, 30 INJ virtual, 85 INJ graduation, fees split 70/30 creator/platform. Only `fee_bps` (≤10%) is the creator's choice.
- **Graduation = locked in-contract `x*y=k` pool**, seeded atomically by the graduating buy. No `migration_target`, no withdraw, curves have **no wasm admin**. Same Buy/Sell messages work in both phases.
- Fees are taken on the quote leg only, in both phases.
- Launch rules (wallet cap, start time, opening fee) apply to the curve only and expire at graduation.
- Factory admin handover is two-step (`UpdateAdmin` → `AcceptAdmin`).
- **The mint key ends with the curve.** The launch tx sends `MsgChangeAdmin` (creator → factory), and the factory's reply sends it on (factory → curve). No creator keeps the ability to mint.
- The launch page refuses to trade a curve whose code id isn't in `NEXT_PUBLIC_CURVE_CODE_IDS`, that has a wasm admin, or whose mint key is held elsewhere (`lib/codeCheck.ts`).
- Testnet is the default everywhere; mainnet needs explicit flags. `NEXT_PUBLIC_*` never holds a secret.

## Current state (2026-10-11)

- Not deployed with the current contracts. An OLD testnet factory exists with the custodial graduation: do not point the app at it. Redeploying is the user's call; never deploy or handle keys without their explicit go-ahead.
- This cloud environment has no deploy key, and its network policy blocks `testnet.sentry.lcd.injective.network`. Testnet work runs on the user's machine: `scripts/deploy.mjs`, then `npm --prefix scripts run e2e`.
- Signing path (`app/src/lib/broadcast.ts`) is built but not yet exercised against a chain.
- Tests: 125 Rust, 196 app.
- Open items, ranked: `docs/AUDIT.md` → "Open".

## House style

- Comments explain *why* and record measurements; keep that density.
- No em dashes in app source (`no-em-dashes.test.ts`).
- Every env var read must be documented in the matching `.env.example` (`env-surface.test.ts`).
- Route files under `app/src/app/api` may only export handlers; put helpers in `lib/`.
